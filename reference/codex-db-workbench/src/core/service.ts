import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { Store } from './store.js';
import { requireHuman, requireOwner, requireRole, effectiveReadOnly } from './policy.js';
import { analyze, previewSql } from './sql.js';
import { exportResult } from './exports.js';
import {
  AppError,
  assert,
  DEFAULT_LIMITS,
  type Actor,
  type Adapter,
  type Connection,
  type Engine,
  type Execution,
  type ExecutionInput,
  type Limits,
  type Profile,
  type Result,
  type Row,
  type Session,
} from './types.js';

export const connectionInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    engine: z.enum(['postgres', 'mysql']),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    database: z.string().min(1).max(128),
    username: z.string().min(1).max(128),
    password: z.string().max(4096).optional(),
    tls: z.boolean().default(true),
    ca: z.string().max(50_000).optional(),
    readOnly: z.boolean().default(true),
    enabled: z.boolean().default(true),
  })
  .strict();
export const profileInput = z
  .object({
    name: z.string().min(1).max(100),
    clientId: z.string().min(1).max(200),
    connectionIds: z.array(z.string().uuid()).max(100),
    readOnly: z.boolean().default(true),
    enabled: z.boolean().default(true),
  })
  .strict();
export const executionInput = z
  .object({
    connectionId: z.string().uuid(),
    sql: z.string().min(1).max(100_000),
    capture: z.enum(['preview', 'full']).default('preview'),
    transaction: z.enum(['per_statement', 'atomic']).default('per_statement'),
    timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
    retentionHours: z.number().min(1).max(168).default(24),
    requestKey: z.string().min(8).max(128),
  })
  .strict();
const terminal = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
  'unknown',
]);
const cleanConnection = (c: Connection) => {
  const { password, ca, ...publicValue } = c;
  return { ...publicValue, hasPassword: password !== undefined, hasCustomCa: !!ca };
};
type Active = { controller: AbortController; session?: Session; timeout: boolean };

export class Workbench {
  readonly limits: Limits;
  private active = new Map<string, Active>();
  private queue: string[] = [];
  private protectedResults = new Set<string>();
  private exportLocks = new Map<string, Promise<unknown>>();
  private stopping = false;
  constructor(
    readonly store: Store,
    private adapters: Record<Engine, Adapter>,
    readonly exportDirectory: string,
    limits: Partial<Limits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    for (const job of store.unfinished()) {
      job.transactionOutcome = job.status === 'queued' ? 'pending' : 'unknown';
      job.status = 'interrupted';
      job.finishedAt = Date.now();
      job.error =
        'Server restarted. In-flight database outcome may be unknown; SQL was not replayed.';
      store.saveExecution(job);
      for (const result of store.results(job.id)) {
        if (result.completeness === 'capturing') result.completeness = 'interrupted';
        if (result.transactionOutcome === 'pending') result.transactionOutcome = 'unknown';
        store.saveResult(result);
      }
    }
  }
  connections(actor: Actor) {
    requireRole(actor, 'query:read');
    const profile = this.getProfile(actor);
    return this.store
      .connections(actor.subject)
      .filter(
        (c) =>
          actor.channel !== 'mcp' ||
          (profile?.enabled && profile.connectionIds.includes(c.id) && c.enabled),
      )
      .map(cleanConnection);
  }
  saveConnection(actor: Actor, raw: unknown, id?: string) {
    requireRole(actor, 'admin');
    assert(actor.channel !== 'mcp', 'FORBIDDEN', 'Manage connections through the GUI.', 403);
    const input = connectionInput.parse(raw);
    const existing = id ? this.store.connection(id) : undefined;
    if (id) {
      assert(existing, 'NOT_FOUND', 'Connection not found.', 404);
      requireOwner(actor, existing.owner);
    }
    const value: Connection = {
      ...input,
      id: id ?? randomUUID(),
      owner: actor.subject,
      password: input.password ?? existing?.password,
      ca: input.ca ?? existing?.ca,
    };
    this.store.saveConnection(value);
    this.store.audit(actor, 'connection.save', value.id, {
      name: value.name,
      readOnly: value.readOnly,
    });
    return cleanConnection(value);
  }
  profiles(actor: Actor) {
    requireRole(actor, 'query:read');
    assert(actor.channel !== 'mcp', 'FORBIDDEN', 'Profiles are managed through the GUI.', 403);
    return this.store.profiles(actor.subject);
  }
  saveProfile(actor: Actor, raw: unknown, id?: string) {
    requireRole(actor, 'admin');
    assert(actor.channel !== 'mcp', 'FORBIDDEN', 'Profiles are managed through the GUI.', 403);
    const input = profileInput.parse(raw);
    const existing = id ? this.store.profile(id) : undefined;
    if (id) {
      assert(existing, 'NOT_FOUND', 'Profile not found.', 404);
      requireOwner(actor, existing.owner);
    }
    for (const connectionId of input.connectionIds) {
      const c = this.store.connection(connectionId);
      assert(c && c.owner === actor.subject, 'NOT_FOUND', 'Connection not found.', 404);
    }
    const duplicate = this.store.profileByClient(input.clientId);
    assert(
      !duplicate || duplicate.id === id,
      'CLIENT_ALREADY_BOUND',
      'An OAuth client can belong to only one MCP profile.',
      409,
    );
    const profile: Profile = { ...input, id: id ?? randomUUID(), owner: actor.subject };
    this.store.saveProfile(profile);
    this.store.audit(actor, 'profile.save', profile.id);
    return profile;
  }
  private getProfile(actor: Actor): Profile | undefined {
    if (actor.channel !== 'mcp') return undefined;
    const profile = actor.profileId ? this.store.profile(actor.profileId) : undefined;
    assert(
      profile &&
        profile.enabled &&
        profile.owner === actor.subject &&
        profile.clientId === actor.clientId,
      'PROFILE_DENIED',
      'MCP profile is unavailable.',
      403,
    );
    return profile;
  }
  private authorizeConnection(
    actor: Actor,
    id: string,
  ): { connection: Connection; readOnly: boolean } {
    const connection = this.store.connection(id);
    assert(connection, 'NOT_FOUND', 'Connection not found.', 404);
    return { connection, readOnly: effectiveReadOnly(actor, connection, this.getProfile(actor)) };
  }
  submit(actor: Actor, raw: unknown): Execution {
    assert(!this.stopping, 'SHUTTING_DOWN', 'The server is shutting down.', 503);
    const input = executionInput.parse(raw);
    const { connection, readOnly } = this.authorizeConnection(actor, input.connectionId);
    assert(
      input.timeoutMs <= this.limits.maxTimeoutMs &&
        input.retentionHours <= this.limits.maxRetentionHours,
      'LIMIT_EXCEEDED',
      'Execution settings exceed server limits.',
    );
    analyze(input.sql, connection.engine, readOnly, input.transaction);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({ ...input, actor: { channel: actor.channel, profileId: actor.profileId } }),
      )
      .digest('hex');
    const existing = this.store.existing(actor.subject, input.requestKey);
    if (existing) {
      assert(
        existing.fingerprint === fingerprint,
        'IDEMPOTENCY_CONFLICT',
        'This request key was already used for different SQL or settings.',
        409,
      );
      return existing.execution;
    }
    assert(this.queue.length < 100, 'QUEUE_FULL', 'The execution queue is full.', 429);
    const job: Execution = {
      ...input,
      id: randomUUID(),
      owner: actor.subject,
      actor,
      status: 'queued',
      createdAt: Date.now(),
      transactionOutcome: 'pending',
    };
    this.store.addExecution(job, fingerprint);
    this.store.audit(actor, 'execution.submit', job.id, {
      capture: job.capture,
      transaction: job.transaction,
    });
    this.queue.push(job.id);
    setImmediate(() => this.pump());
    return job;
  }
  private pump(): void {
    while (!this.stopping && this.active.size < this.limits.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.store.execution(id);
      if (!job || terminal.has(job.status)) continue;
      const active: Active = { controller: new AbortController(), timeout: false };
      this.active.set(id, active);
      void this.run(job, active)
        .catch(() => {
          const current = this.store.execution(id);
          if (current && !terminal.has(current.status)) {
            current.status = 'unknown';
            current.transactionOutcome = 'unknown';
            current.error = 'Unexpected execution failure. Inspect database state before retrying.';
            current.finishedAt = Date.now();
            this.store.saveExecution(current);
          }
        })
        .finally(() => {
          this.active.delete(id);
          this.pump();
        });
    }
  }
  private async run(job: Execution, active: Active): Promise<void> {
    let session: Session | undefined;
    let began = false;
    let committed = 0;
    let commitStarted = false;
    let current: Result | undefined;
    let nonTransactional = false;
    const timeout = setTimeout(() => {
      active.timeout = true;
      active.controller.abort();
    }, job.timeoutMs);
    timeout.unref();
    const abort = () => {
      void active.session?.cancel().catch(() => {});
    };
    active.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      const { connection, readOnly } = this.authorizeConnection(job.actor, job.connectionId);
      const statements = analyze(job.sql, connection.engine, readOnly, job.transaction);
      job.status = 'running';
      job.startedAt = Date.now();
      this.store.saveExecution(job);
      session = await this.adapters[connection.engine].open(connection, job.timeoutMs);
      active.session = session;
      active.controller.signal.throwIfAborted();
      if (job.transaction === 'atomic') {
        await session.validateAtomic?.(statements);
        await session.begin(readOnly);
        began = true;
      }
      for (let index = 0; index < statements.length; index++) {
        active.controller.signal.throwIfAborted();
        // Recheck current connection/profile restrictions before each statement.
        const access = this.authorizeConnection(job.actor, job.connectionId);
        const statement = statements[index]!;
        assert(
          !access.readOnly || statement.readOnly,
          'READ_ONLY',
          'Permission changed while the execution was queued or running.',
          403,
        );
        nonTransactional =
          connection.engine === 'mysql' &&
          !['select', 'insert', 'update', 'delete'].includes(statement.type);
        if (job.transaction === 'per_statement') {
          await session.begin(readOnly);
          began = true;
        }
        const executedSql =
          job.capture === 'preview'
            ? previewSql(statement, connection.engine, this.limits.previewRows + 1)
            : statement.sql;
        current = this.store.addResult(job, index, statement.sql, executedSql);
        const started = Date.now();
        let hasMore = false;
        for await (const batch of session.query(executedSql, active.controller.signal)) {
          active.controller.signal.throwIfAborted();
          if (batch.columns.length) current.columns = batch.columns;
          if (batch.affectedRows !== undefined) current.affectedRows = batch.affectedRows;
          const space =
            job.capture === 'preview'
              ? Math.max(0, this.limits.previewRows - current.rows)
              : batch.rows.length;
          const captured = batch.rows.slice(0, space);
          if (captured.length < batch.rows.length) hasMore = true;
          const bytes = Buffer.byteLength(JSON.stringify(captured));
          const executionBytes = this.store.results(job.id).reduce((sum, r) => sum + r.bytes, 0);
          if (
            executionBytes + bytes > this.limits.maxResultBytes ||
            this.store.totalBytes() + bytes > this.limits.maxTotalBytes
          ) {
            current.completeness = 'quota_limited';
            this.store.saveResult(current);
            throw new AppError(
              'STORAGE_QUOTA',
              'Result storage quota reached. Output is incomplete.',
              409,
            );
          }
          this.store.append(current, captured);
        }
        current.durationMs = Date.now() - started;
        current.completeness = hasMore ? 'preview_limited' : 'complete';
        if (job.transaction === 'per_statement') {
          active.controller.signal.throwIfAborted();
          commitStarted = true;
          await session.commit();
          commitStarted = false;
          began = false;
          committed++;
          current.transactionOutcome = 'committed';
        }
        this.store.saveResult(current);
        current = undefined;
        nonTransactional = false;
      }
      if (job.transaction === 'atomic') {
        active.controller.signal.throwIfAborted();
        commitStarted = true;
        await session.commit();
        commitStarted = false;
        began = false;
        for (const result of this.store.results(job.id)) {
          result.transactionOutcome = 'committed';
          this.store.saveResult(result);
        }
      }
      job.status = 'succeeded';
      job.transactionOutcome = 'committed';
    } catch (error) {
      let rolledBack = false;
      if (began && session) {
        try {
          await session.rollback();
          rolledBack = true;
        } catch {}
      }
      const uncertain = commitStarted || nonTransactional || (began && !rolledBack);
      const outcome = uncertain ? 'unknown' : committed ? 'partial_commit' : 'rolled_back';
      job.transactionOutcome = outcome;
      job.status = uncertain
        ? 'unknown'
        : active.controller.signal.aborted
          ? active.timeout
            ? 'timed_out'
            : 'cancelled'
          : 'failed';
      job.error =
        error instanceof AppError
          ? `${error.code}: ${error.message}`
          : active.controller.signal.aborted
            ? active.timeout
              ? 'Execution timed out.'
              : 'Execution cancelled.'
            : error instanceof Error
              ? error.message.slice(0, 1000)
              : 'Execution failed.';
      for (const result of this.store.results(job.id)) {
        if (current?.id === result.id && current.completeness === 'capturing')
          result.completeness = 'interrupted';
        else if (result.completeness === 'capturing') result.completeness = 'interrupted';
        if (result.transactionOutcome === 'pending')
          result.transactionOutcome = uncertain ? 'unknown' : 'rolled_back';
        this.store.saveResult(result);
      }
    } finally {
      clearTimeout(timeout);
      active.controller.signal.removeEventListener('abort', abort);
      await session?.close().catch(() => {});
      job.finishedAt = Date.now();
      this.store.saveExecution(job);
      this.store.audit(job.actor, 'execution.finish', job.id, {
        status: job.status,
        transactionOutcome: job.transactionOutcome,
      });
    }
  }
  execution(actor: Actor, id: string) {
    requireRole(actor, 'query:read');
    const job = this.store.execution(id);
    assert(job, 'NOT_FOUND', 'Execution not found.', 404);
    requireOwner(actor, job.owner);
    if (actor.channel === 'mcp') this.authorizeConnection(actor, job.connectionId);
    return { ...job, results: this.store.results(id) };
  }
  history(actor: Actor) {
    requireRole(actor, 'query:read');
    const profile = this.getProfile(actor);
    return this.store
      .executions(actor.subject)
      .filter((e) => actor.channel !== 'mcp' || profile?.connectionIds.includes(e.connectionId))
      .map((e) => ({ ...e, results: this.store.results(e.id) }));
  }
  cancel(actor: Actor, id: string) {
    const job = this.execution(actor, id);
    if (terminal.has(job.status)) return job;
    const active = this.active.get(id);
    if (active) {
      job.status = 'cancel_requested';
      this.store.saveExecution(job);
      active.controller.abort();
    } else {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      job.transactionOutcome = 'rolled_back';
      this.store.saveExecution(job);
    }
    this.store.audit(actor, 'execution.cancel', id);
    return job;
  }
  private accessibleResult(actor: Actor, id: string): Result {
    const result = this.store.result(id);
    assert(result, 'NOT_FOUND', 'Result not found.', 404);
    this.execution(actor, result.executionId);
    assert(
      result.completeness !== 'expired' && result.expiresAt > Date.now(),
      'RESULT_EXPIRED',
      'The captured result has expired.',
      410,
    );
    return result;
  }
  resultPage(actor: Actor, id: string, offset = 0, limit = 200) {
    assert(
      Number.isInteger(offset) &&
        offset >= 0 &&
        Number.isInteger(limit) &&
        limit > 0 &&
        limit <= 1000,
      'INVALID_PAGE',
      'Invalid result page.',
    );
    const result = this.accessibleResult(actor, id);
    const approved =
      actor.channel === 'mcp' &&
      !!actor.profileId &&
      this.store.approved(id, actor.profileId, actor.subject);
    const prior =
      actor.channel === 'mcp' && !approved
        ? this.store
            .results(result.executionId)
            .filter((r) => r.statementIndex < result.statementIndex)
        : [];
    const allowance = approved
      ? Infinity
      : Math.max(0, this.limits.previewRows - prior.reduce((n, r) => n + r.rows, 0));
    const byteAllowance = approved
      ? Infinity
      : Math.max(0, this.limits.previewBytes - prior.reduce((n, r) => n + r.bytes, 0));
    const rows: Row[] = [];
    let index = 0;
    let prefixBytes = 0;
    let pageBytes = 0;
    let allowedRows = 0;
    let more = false;
    for (const row of this.store.rows(id)) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (index >= allowance || prefixBytes + size > byteAllowance) {
        more = true;
        break;
      }
      prefixBytes += size;
      allowedRows++;
      if (index >= offset && rows.length < limit && pageBytes + size <= this.limits.responseBytes) {
        rows.push(row);
        pageBytes += size;
      } else if (index >= offset) {
        more = true;
        break;
      }
      index++;
    }
    if (offset > 0 && offset >= allowedRows && offset < result.rows)
      throw new AppError(
        actor.channel === 'mcp' ? 'DISCLOSURE_APPROVAL_REQUIRED' : 'PREVIEW_LIMIT',
        'This page exceeds the available preview. Use full export or approve MCP disclosure.',
        403,
      );
    return {
      result,
      rows,
      offset,
      nextOffset:
        rows.length && offset + rows.length < result.rows && more ? offset + rows.length : null,
      hasMore: offset + rows.length < result.rows || result.completeness === 'preview_limited',
      disclosureApproved: !!approved,
      previewLimited: !approved && (result.rows > allowance || more),
      emptyDueToByteLimit: rows.length === 0 && result.rows > offset,
    };
  }
  approve(actor: Actor, resultId: string, profileId: string, hours = 1) {
    requireHuman(actor);
    const result = this.accessibleResult(actor, resultId);
    const profile = this.store.profile(profileId);
    assert(
      profile && profile.owner === actor.subject && profile.enabled,
      'NOT_FOUND',
      'Profile not found.',
      404,
    );
    const job = this.execution(actor, result.executionId);
    assert(
      profile.connectionIds.includes(job.connectionId),
      'PROFILE_DENIED',
      'The profile cannot access this connection.',
      403,
    );
    assert(
      result.completeness === 'complete' && result.transactionOutcome === 'committed',
      'RESULT_INCOMPLETE',
      'Approve only a complete, committed result.',
      409,
    );
    assert(
      hours > 0 && hours <= 24,
      'INVALID_EXPIRY',
      'Approval duration must be between 0 and 24 hours.',
    );
    const expiresAt = Math.min(result.expiresAt, Date.now() + hours * 3600_000);
    this.store.approve(resultId, profileId, actor.subject, expiresAt);
    this.store.audit(actor, 'disclosure.approve', resultId, {
      profileId,
      expiresAt,
      rows: result.rows,
    });
    return { resultId, profileId, expiresAt };
  }
  revoke(actor: Actor, resultId: string, profileId: string) {
    requireHuman(actor);
    this.accessibleResult(actor, resultId);
    this.store.revoke(resultId, profileId);
    this.store.audit(actor, 'disclosure.revoke', resultId, { profileId });
  }
  async export(actor: Actor, resultId: string, format: 'csv' | 'json') {
    const result = this.accessibleResult(actor, resultId);
    assert(
      result.transactionOutcome === 'committed',
      'TRANSACTION_NOT_COMMITTED',
      'Wait for a confirmed commit before exporting.',
      409,
    );
    // File creation does not grant the MCP caller permission to read that file.
    const key = `${actor.subject}:${resultId}:${format}`;
    if (this.exportLocks.has(key)) await this.exportLocks.get(key);
    const existing = this.store
      .exports(actor.subject)
      .find((e) => e.resultId === resultId && e.format === format && e.expiresAt > Date.now());
    if (existing) return { ...existing, path: undefined };
    this.protectedResults.add(resultId);
    const work = exportResult(this.store, result, actor, this.exportDirectory, format);
    this.exportLocks.set(key, work);
    try {
      const value = await work;
      return { ...value, path: undefined };
    } finally {
      this.protectedResults.delete(resultId);
      this.exportLocks.delete(key);
    }
  }
  download(actor: Actor, exportId: string) {
    const item = this.store.export(exportId);
    assert(item, 'NOT_FOUND', 'Export not found.', 404);
    requireOwner(actor, item.owner);
    const result = this.accessibleResult(actor, item.resultId);
    if (actor.channel === 'mcp')
      assert(
        actor.profileId && this.store.approved(result.id, actor.profileId, actor.subject),
        'DISCLOSURE_APPROVAL_REQUIRED',
        'A separate human approval is required before downloading this export through MCP.',
        403,
      );
    return item;
  }
  async cleanup(now = Date.now()): Promise<void> {
    for (const item of this.store.exports())
      if (item.expiresAt <= now && !this.protectedResults.has(item.resultId)) {
        await rm(item.path, { force: true });
        this.store.deleteExport(item.id);
      }
    for (const result of this.store.expiredResults(now))
      if (!this.protectedResults.has(result.id) && !this.active.has(result.executionId))
        this.store.expire(result);
    this.store.pruneMetadata(now - 90 * 24 * 3600_000);
  }
  async testConnection(actor: Actor, id: string) {
    const { connection } = this.authorizeConnection(actor, id);
    const session = await this.adapters[connection.engine].open(connection, 5000);
    try {
      const rows: Row[] = [];
      for await (const batch of session.query('SELECT VERSION()', AbortSignal.timeout(5000)))
        rows.push(...batch.rows);
      return { ok: true, version: rows[0]?.[0] };
    } finally {
      await session.close();
    }
  }
  async inspect(actor: Actor, id: string, sql: string) {
    const { connection } = this.authorizeConnection(actor, id);
    const session = await this.adapters[connection.engine].open(connection, 5000);
    try {
      await session.begin(true);
      const rows: Row[] = [];
      let columns: Result['columns'] = [];
      for await (const batch of session.query(sql, AbortSignal.timeout(5000))) {
        columns = batch.columns;
        rows.push(...batch.rows);
        assert(rows.length <= 1000, 'INSPECTION_LIMIT', 'Metadata exceeded the inspection limit.');
      }
      await session.commit();
      return { columns, rows };
    } finally {
      await session.close();
    }
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const active of this.active.values()) active.controller.abort();
    while (this.active.size) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
