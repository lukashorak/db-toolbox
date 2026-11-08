import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { DbError, SessionUnusableError } from '../db/errors.js';
import { STALL_GRACE_MS } from '../db/stall.js';
import type { Cell, ColumnInfo, DbAdapter, DbSession } from '../db/types.js';
import { AppError, assert } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import type {
  Actor,
  Completeness,
  Engine,
  ExecutionStatus,
  Role,
  TransactionOutcome,
} from '../domain/types.js';
import { evaluateWritePolicy, requirePermission } from '../security/policy.js';
import type { ConnectionService } from '../services/connections.js';
import { isoNow, type ServiceContext } from '../services/context.js';
import type { DatabaseService } from '../services/databases.js';
import type { ProfileService } from '../services/profiles.js';
import type { ExecutionDefaults, SettingsService } from '../services/settings.js';
import { parseInput } from '../services/validation.js';
import { analyzeScript, analyzeStatement } from '../sql/analyze.js';
import { TRANSACTIONAL_ENGINES, UNRESOLVED_VIEW } from '../sql/types.js';
import { preflight, type PreflightProblem } from '../sql/preflight.js';
import type { StatementKind } from '../sql/types.js';
import { bool, int, type Database, type Row } from '../store/database.js';
import { METADATA_DUE, readRows, ResultCapture, StorageBudget, resultGone } from './capture.js';
import { canSeeExecution } from './visibility.js';

const submitSchema = z
  .object({
    connectionId: z.string().min(1),
    sql: z.string().min(1, 'Enter SQL to run.').max(1_000_000, 'The script is too long.'),
    title: z.string().trim().max(200).optional(),
    scope: z.string().trim().min(1).max(60).default('Script'),
    savedQueryId: z.string().nullable().default(null),
    requestKey: z.string().trim().min(8).max(100).optional(),
    captureMode: z.enum(['preview', 'full']).default('preview'),
    transactionMode: z.enum(['per_statement', 'atomic']).default('per_statement'),
    continueOnError: z.boolean().default(false),
    timeoutMs: z.number().int().positive().optional(),
    retention: z.enum(['working', 'retained']).default('working'),
    retainDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export type SubmitInput = z.input<typeof submitSchema>;

export interface StatementView {
  ordinal: number;
  sql: string;
  kind: StatementKind;
  command: string;
  range: {
    start: number;
    end: number;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  status: string;
  transactionOutcome: TransactionOutcome;
  affectedRows: number | null;
  error: { code: string | null; message: string; detail: unknown } | null;
  notices: string[];
  startedAt: string | null;
  durationMs: number | null;
}

export interface ResultSetView {
  index: number;
  statement: number;
  columns: ColumnInfo[];
  rowCount: number;
  byteCount: number;
  moreAvailable: boolean;
  completeness: Completeness;
  expiresAt: string | null;
}

export interface ExecutionView {
  id: string;
  title: string;
  owner: string;
  actorSubject: string;
  source: Actor['source'];
  clientId: string;
  profile: { id: string | null; name: string } | null;
  connection: { id: string | null; name: string; engine: string };
  database: string | null;
  schema: string | null;
  savedQueryId: string | null;
  requestKey: string;
  sql: string;
  scope: string;
  captureMode: 'preview' | 'full';
  transactionMode: 'per_statement' | 'atomic';
  continueOnError: boolean;
  timeoutMs: number;
  retention: 'working' | 'retained';
  readOnly: boolean;
  policySources: string[];
  status: ExecutionStatus;
  statusNote: string | null;
  transactionOutcome: TransactionOutcome;
  submittedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  error: { code: string | null; message: string; detail: unknown } | null;
  /** While queued: 1-based position on the connection and why it waits. */
  queue: { position: number; reason: string } | null;
  statements: StatementView[];
  resultSets: ResultSetView[];
  resultExpiresAt: string | null;
}

export interface ExecutionOptions {
  /** Executions running at once across all connections. */
  globalCap?: number;
}

const parse = (v: unknown, fallback: unknown = null) =>
  v === null || v === undefined ? fallback : JSON.parse(String(v));
const TERMINAL =
  "('succeeded', 'failed', 'rejected', 'preflight_rejected', 'cancelled', 'timed_out', 'interrupted', 'unknown')";

/** How long an execution's results are kept, in hours, from its retention choice. */
function retentionHours(e: Row, defaults: ExecutionDefaults): number {
  return e.retention === 'retained'
    ? Number(e.retain_days ?? defaults.retainedMaxDays) * 24
    : defaults.workingRetentionHours;
}

/**
 * Closes an execution's result sets still `capturing` (a restart, or closing them failed): they are
 * marked interrupted, counted from the chunks stored, so quotas and disclosure see those rows, and
 * given a retention deadline, so cleanup removes them in time.
 */
function closeCapturing(db: Database, id: string, expires: string): void {
  db.run(
    `UPDATE result_sets SET completeness = 'interrupted',
       row_count = (SELECT coalesce(sum(c.row_count), 0) FROM result_chunks c
                     WHERE c.execution_id = result_sets.execution_id AND c.result_index = result_sets.result_index),
       byte_count = (SELECT coalesce(sum(c.byte_count), 0) FROM result_chunks c
                      WHERE c.execution_id = result_sets.execution_id AND c.result_index = result_sets.result_index),
       expires_at = coalesce(expires_at, :expires)
     WHERE execution_id = :id AND completeness = 'capturing'`,
    { id, expires },
  );
}

interface Running {
  controller: AbortController;
  connectionId: string;
  done: Promise<void>;
}

/**
 * Server-owned executions. A submission is stored (with its SQL snapshot) before it is
 * acknowledged and then runs in the background, independent of the request that created it.
 * Status, transaction outcome and result completeness are reported separately and honestly.
 */
/** `work`, unless the signal aborts or the deadline (epoch ms) passes first. */
/**
 * Runs a check after a statement failed, within the execution's bounds: until the deadline, and for
 * the grace period once the execution is cancelled or past its deadline (the failure may be that
 * cancel or time limit). A check that has not finished then gives `fallback`, and its lookups are
 * aborted.
 */
export async function withinBounds<T>(
  check: (signal: AbortSignal) => Promise<T>,
  bounds: { signal: AbortSignal; deadline: number },
  fallback: T,
  graceMs = STALL_GRACE_MS,
): Promise<T> {
  const lookups = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let giveUp: (value: T) => void = () => undefined;
  const gaveUp = new Promise<T>((resolve) => (giveUp = resolve));
  const until = (at: number) => {
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        // Settled first, so the race gives the fallback, not the aborted lookup's error.
        giveUp(fallback);
        lookups.abort();
      },
      Math.max(0, at - Date.now()),
    );
  };
  const onAbort = () => until(Date.now() + graceMs);
  if (bounds.signal.aborted) onAbort();
  else {
    until(bounds.deadline + graceMs);
    bounds.signal.addEventListener('abort', onAbort, { once: true });
  }
  const work = check(lookups.signal);
  work.catch(() => undefined); // An abandoned check may still fail later.
  try {
    return await Promise.race([work, gaveUp]);
  } finally {
    clearTimeout(timer);
    bounds.signal.removeEventListener('abort', onAbort);
  }
}

/** A view whose effects could not be looked up: refused like one that cannot roll back. */
const VIEW_UNCHECKED = 'what it does could not be checked (the lookup failed)';

async function untilDone<T>(
  work: Promise<T>,
  signal: AbortSignal,
  deadline: number,
): Promise<T | 'cancelled' | 'timeout'> {
  work.catch(() => undefined); // An abandoned lookup may still fail later.
  if (signal.aborted) return 'cancelled';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
      }),
      new Promise<'cancelled'>((resolve) => {
        onAbort = () => resolve('cancelled');
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export class ExecutionService {
  readonly events = new EventEmitter();
  readonly #running = new Map<string, Running>();
  readonly #budget: StorageBudget;
  readonly #globalCap: number;
  #stopped = false;
  #shuttingDown = false;

  constructor(
    private readonly ctx: ServiceContext,
    private readonly deps: {
      databases: DatabaseService;
      connections: ConnectionService;
      profiles: ProfileService;
      settings: SettingsService;
    },
    options: ExecutionOptions = {},
  ) {
    this.#budget = StorageBudget.fromDatabase(ctx.db, ctx.limits.maxTotalBytes);
    this.#globalCap = options.globalCap ?? 16;
    this.events.setMaxListeners(0);
  }

  /** Bytes of captured results currently stored. */
  get storedBytes(): number {
    return this.#budget.used;
  }

  /** Gives back space freed by deleting results (exports service). */
  releaseStorage(bytes: number): void {
    this.#budget.release(bytes);
  }

  // ---------------------------------------------------------------- submission

  async submit(actor: Actor, input: SubmitInput): Promise<ExecutionView> {
    requirePermission(actor, 'sql.read');
    const v = parseInput(submitSchema, input);
    const connection = this.deps.databases.usable(actor, v.connectionId);
    const profile = actor.profileId ? this.deps.profiles.findByClientId(actor.clientId) : undefined;
    const policy = evaluateWritePolicy({
      actor,
      connection: { name: connection.name, readOnly: connection.readOnly },
      ...(profile ? { profile: { name: profile.name, readOnly: profile.readOnly } } : {}),
    });
    const defaults = this.deps.settings.defaults();
    const maxTimeout = Math.min(
      v.captureMode === 'full' ? defaults.fullTimeoutMaxMs : defaults.ordinaryTimeoutMs,
      profile ? profile.timeoutMs : Number.MAX_SAFE_INTEGER,
    );
    const timeoutMs = Math.min(v.timeoutMs ?? defaults.ordinaryTimeoutMs, maxTimeout);
    if (v.timeoutMs !== undefined && v.timeoutMs > maxTimeout) {
      throw new AppError('validation_failed', `The timeout may be at most ${maxTimeout} ms for this run.`, {
        fields: [{ path: 'timeoutMs', message: `At most ${maxTimeout} ms.` }],
      });
    }
    const retainDays =
      v.retention === 'retained'
        ? Math.min(v.retainDays ?? defaults.retainedMaxDays, defaults.retainedMaxDays)
        : null;

    const requestKey = v.requestKey ?? newId('execution', this.ctx.clock.now());
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          v.connectionId,
          v.sql,
          v.scope,
          v.savedQueryId,
          v.captureMode,
          v.transactionMode,
          v.continueOnError,
          timeoutMs,
          v.retention,
          retainDays,
        ]),
      )
      .digest('hex');
    const existing = this.ctx.db.get(
      'SELECT id, request_hash FROM executions WHERE owner = :owner AND request_key = :key',
      {
        owner: actor.subject,
        key: requestKey,
      },
    );
    if (existing) {
      if (existing.request_hash !== hash) {
        throw new AppError(
          'idempotency_conflict',
          'This request key was already used for a different SQL text or different settings.',
          { executionId: String(existing.id) },
        );
      }
      return this.view(String(existing.id));
    }

    const statements = await analyzeScript(v.sql, connection.engine);
    let problems: PreflightProblem[];
    // MySQL single-transaction runs check storage engines; PostgreSQL checks what the views a script
    // reads do, for single-transaction writes and for every read-only run.
    const adapter =
      connection.engine === 'mysql'
        ? v.transactionMode === 'atomic'
          ? await this.#adapter(connection.id)
          : null
        : (v.transactionMode === 'atomic' && !policy.readOnly) || policy.readOnly
          ? await this.#adapter(connection.id)
          : null;
    problems = await preflight(statements, {
      engine: connection.engine,
      transactionMode: v.transactionMode,
      readOnly: policy.readOnly,
      readOnlySources: policy.sources,
      ...(adapter
        ? {
            tableEngine: async (table) => {
              try {
                return await adapter.tableEngine(table);
              } catch {
                return 'unknown (the storage engine could not be checked)';
              }
            },
            functionEngine: async (fn) => {
              try {
                return await adapter.functionEngine(fn);
              } catch {
                return 'unknown (the storage engine could not be checked)';
              }
            },
            viewEngine: async (table) => {
              try {
                return await adapter.viewEngine(table);
              } catch {
                return 'unknown (the storage engine could not be checked)';
              }
            },
            viewEffects: async (table) => {
              try {
                return await adapter.viewEffects(table);
              } catch {
                return { irreversible: VIEW_UNCHECKED, notReadOnly: VIEW_UNCHECKED };
              }
            },
          }
        : {}),
    });
    problems = problems.map((p) =>
      p.message.includes('unknown (the storage engine')
        ? { ...p, hint: 'Retry, or use per-statement mode.' }
        : p,
    );

    const id = newId('execution', this.ctx.clock.now());
    const now = isoNow(this.ctx);
    const metadataExpires = new Date(
      Date.parse(now) + defaults.metadataRetentionDays * 86_400_000,
    ).toISOString();
    const rejected = problems.length > 0;
    let duplicateOf: string | null = null;
    this.ctx.db.transaction(() => {
      // Again inside the transaction: an overlapping submission with the same key may have been
      // stored while this one was analysed.
      const raced = this.ctx.db.get(
        'SELECT id, request_hash FROM executions WHERE owner = :owner AND request_key = :key',
        { owner: actor.subject, key: requestKey },
      );
      if (raced) {
        if (raced.request_hash !== hash) {
          throw new AppError(
            'idempotency_conflict',
            'This request key was already used for a different SQL text or different settings.',
            { executionId: String(raced.id) },
          );
        }
        duplicateOf = String(raced.id);
        return;
      }
      this.ctx.db.run(
        `INSERT INTO executions (id, owner, actor_subject, source, client_id, actor_roles, profile_id, profile_name,
           connection_id, connection_name, engine, database_name, schema_name, saved_query_id, title, request_key, request_hash,
           sql, scope, capture_mode, transaction_mode, continue_on_error, timeout_ms, retention, retain_days, read_only,
           policy_sources, status, transaction_outcome, submitted_at, finished_at, error_code, error_message, error_detail,
           metadata_expires_at)
         VALUES (:id, :owner, :owner, :source, :client, :roles, :profileId, :profileName, :connectionId, :connectionName,
           :engine, :database, :schema, :savedQuery, :title, :key, :hash, :sql, :scope, :capture, :mode, :continue, :timeout,
           :retention, :retainDays, :readOnly, :sources, :status, 'not_started', :now, :finished, :errorCode, :errorMessage,
           :errorDetail, :metadataExpires)`,
        {
          id,
          owner: actor.subject,
          source: actor.source,
          client: actor.clientId,
          roles: JSON.stringify(actor.roles),
          profileId: profile?.id ?? null,
          profileName: profile?.name ?? null,
          connectionId: connection.id,
          connectionName: connection.name,
          engine: connection.engine,
          database: connection.database,
          schema: connection.schema,
          savedQuery: v.savedQueryId,
          title: v.title || statements[0]?.text.slice(0, 80).replace(/\s+/g, ' ') || 'SQL',
          key: requestKey,
          hash,
          sql: v.sql,
          scope: v.scope,
          capture: v.captureMode,
          mode: v.transactionMode,
          continue: int(v.continueOnError),
          timeout: timeoutMs,
          retention: v.retention,
          retainDays,
          readOnly: int(policy.readOnly),
          sources: JSON.stringify(policy.sources),
          status: rejected ? 'preflight_rejected' : 'queued',
          now,
          finished: rejected ? now : null,
          errorCode: rejected ? 'preflight' : null,
          errorMessage: rejected ? (problems[0]?.message ?? 'The script was rejected before it ran.') : null,
          errorDetail: rejected ? JSON.stringify({ problems }) : null,
          metadataExpires,
        },
      );
      for (const s of statements) {
        this.ctx.db.run(
          `INSERT INTO statements (execution_id, ordinal, sql, kind, command, offset_start, offset_end, line_start, column_start,
             line_end, column_end, status, transaction_outcome, read_only_safe, changes_session)
           VALUES (:id, :ordinal, :sql, :kind, :command, :os, :oe, :ls, :cs, :le, :ce, 'not_run', 'not_started', :safe, :session)`,
          {
            id,
            ordinal: s.index,
            sql: s.text,
            kind: s.analysis.kind,
            command: s.analysis.command,
            safe: int(s.analysis.readOnlySafe),
            session: int(
              s.analysis.changesSession || s.analysis.kind === 'session' || s.analysis.kind === 'unknown',
            ),
            os: s.range.start,
            oe: s.range.end,
            ls: s.range.startLine,
            cs: s.range.startColumn,
            le: s.range.endLine,
            ce: s.range.endColumn,
          },
        );
      }
      this.ctx.audit.record({
        actor,
        action: 'execution.submit',
        target: { type: 'execution', id, label: connection.name },
        outcome: rejected ? 'denied' : 'accepted',
        details: {
          connection: connection.name,
          statements: statements.length,
          readOnly: policy.readOnly,
          captureMode: v.captureMode,
          transactionMode: v.transactionMode,
          ...(rejected ? { problems: problems.map((p) => p.code) } : {}),
        },
      });
    });
    if (duplicateOf) return this.view(duplicateOf);
    this.#changed(id);
    if (!rejected) this.#pump();
    return this.view(id);
  }

  // ---------------------------------------------------------------- reading

  get(actor: Actor, id: string): ExecutionView {
    this.#assertVisible(actor, this.#row(id));
    return this.view(id);
  }

  list(
    actor: Actor,
    query: {
      status?: ExecutionStatus;
      connectionId?: string;
      source?: Actor['source'];
      from?: string;
      to?: string;
      limit?: number;
      before?: string;
    } = {},
  ) {
    requirePermission(actor, 'sql.read');
    const where = ['owner = :owner'];
    const params: Record<string, string | number> = {
      owner: actor.subject,
      limit: Math.min(query.limit ?? 50, 200),
    };
    for (const [key, clause] of [
      ['source', 'source = :source'],
      ['from', 'submitted_at >= :from'],
      ['to', 'submitted_at <= :to'],
    ] as const) {
      const value = query[key];
      if (value) {
        where.push(clause);
        params[key] = value;
      }
    }
    if (query.status) {
      where.push('status = :status');
      params.status = query.status;
    }
    if (query.connectionId) {
      where.push('connection_id = :connection');
      params.connection = query.connectionId;
    }
    if (query.before) {
      // The ID of the last execution on the previous page (or, for older clients, a timestamp).
      // Ties on submitted_at are broken by ID, matching the ORDER BY below.
      const cursor = this.ctx.db.get(
        'SELECT submitted_at FROM executions WHERE id = :id AND owner = :owner',
        {
          id: query.before,
          owner: actor.subject,
        },
      );
      if (cursor) {
        where.push('(submitted_at < :beforeAt OR (submitted_at = :beforeAt AND id < :beforeId))');
        params.beforeAt = String(cursor.submitted_at);
        params.beforeId = query.before;
      } else {
        where.push('submitted_at < :before');
        params.before = query.before;
      }
    }
    return this.ctx.db
      .all(
        `SELECT id FROM executions WHERE ${where.join(' AND ')} ORDER BY submitted_at DESC, id DESC LIMIT :limit`,
        params,
      )
      .map((r) => this.view(String(r.id)));
  }

  /** A page of captured rows of one result set. */
  rows(actor: Actor, id: string, resultIndex: number, page: { offset?: number; limit?: number } = {}) {
    this.#assertVisible(actor, this.#row(id));
    const set = this.ctx.db.get(
      'SELECT * FROM result_sets WHERE execution_id = :id AND result_index = :index',
      {
        id,
        index: resultIndex,
      },
    );
    assert(set, 'not_found', 'Result set not found.', { resultIndex });
    const completeness = String(set.completeness) as Completeness;
    if (resultGone(set, this.ctx.clock.now())) {
      throw new AppError('result_expired', 'The captured result is no longer stored. Run the query again.');
    }
    const offset = Math.max(0, page.offset ?? 0);
    const limit = Math.min(Math.max(1, page.limit ?? 100), 1000);
    return {
      columns: parse(set.columns, []) as ColumnInfo[],
      rows: readRows(this.ctx.db, id, resultIndex, offset, limit),
      offset,
      rowCount: Number(set.row_count),
      moreAvailable: bool(set.more_available),
      completeness,
    };
  }

  view(id: string): ExecutionView {
    const r = this.#row(id);
    const statements = this.ctx.db
      .all('SELECT * FROM statements WHERE execution_id = :id ORDER BY ordinal', { id })
      .map((s): StatementView => ({
        ordinal: Number(s.ordinal),
        sql: String(s.sql),
        kind: String(s.kind) as StatementKind,
        command: String(s.command),
        range: {
          start: Number(s.offset_start),
          end: Number(s.offset_end),
          startLine: Number(s.line_start),
          startColumn: Number(s.column_start),
          endLine: Number(s.line_end),
          endColumn: Number(s.column_end),
        },
        status: String(s.status),
        transactionOutcome: String(s.transaction_outcome) as TransactionOutcome,
        affectedRows: s.affected_rows === null ? null : Number(s.affected_rows),
        error: s.error_message
          ? {
              code: (s.error_code as string | null) ?? null,
              message: String(s.error_message),
              detail: parse(s.error_detail),
            }
          : null,
        notices: parse(s.notices, []) as string[],
        startedAt: (s.started_at as string | null) ?? null,
        durationMs: s.duration_ms === null ? null : Number(s.duration_ms),
      }));
    const resultSets = this.ctx.db
      .all('SELECT * FROM result_sets WHERE execution_id = :id ORDER BY result_index', { id })
      .map((s): ResultSetView => ({
        index: Number(s.result_index),
        statement: Number(s.statement),
        columns: parse(s.columns, []) as ColumnInfo[],
        rowCount: Number(s.row_count),
        byteCount: Number(s.byte_count),
        moreAvailable: bool(s.more_available),
        completeness: String(s.completeness) as Completeness,
        expiresAt: (s.expires_at as string | null) ?? null,
      }));
    const status = String(r.status) as ExecutionStatus;
    return {
      id,
      title: String(r.title),
      owner: String(r.owner),
      actorSubject: String(r.actor_subject),
      source: r.source as Actor['source'],
      clientId: String(r.client_id),
      profile: r.profile_name
        ? { id: (r.profile_id as string | null) ?? null, name: String(r.profile_name) }
        : null,
      connection: {
        id: (r.connection_id as string | null) ?? null,
        name: String(r.connection_name),
        engine: String(r.engine),
      },
      database: (r.database_name as string | null) ?? null,
      schema: (r.schema_name as string | null) ?? null,
      savedQueryId: (r.saved_query_id as string | null) ?? null,
      requestKey: String(r.request_key),
      sql: String(r.sql),
      scope: String(r.scope),
      captureMode: r.capture_mode as ExecutionView['captureMode'],
      transactionMode: r.transaction_mode as ExecutionView['transactionMode'],
      continueOnError: bool(r.continue_on_error),
      timeoutMs: Number(r.timeout_ms),
      retention: r.retention as ExecutionView['retention'],
      readOnly: bool(r.read_only),
      policySources: parse(r.policy_sources, []) as string[],
      status,
      statusNote: (r.status_note as string | null) ?? null,
      transactionOutcome: String(r.transaction_outcome) as TransactionOutcome,
      submittedAt: String(r.submitted_at),
      startedAt: (r.started_at as string | null) ?? null,
      finishedAt: (r.finished_at as string | null) ?? null,
      cancelRequestedAt: (r.cancel_requested_at as string | null) ?? null,
      error: r.error_message
        ? {
            code: (r.error_code as string | null) ?? null,
            message: String(r.error_message),
            detail: parse(r.error_detail),
          }
        : null,
      queue: status === 'queued' ? this.#queuePosition(r) : null,
      statements,
      resultSets,
      resultExpiresAt: (r.result_expires_at as string | null) ?? null,
    };
  }

  #queuePosition(r: Row): { position: number; reason: string } {
    const ahead = this.ctx.db.get(
      `SELECT count(*) AS n FROM executions WHERE connection_id = :connection AND status = 'queued'
         AND (submitted_at < :at OR (submitted_at = :at AND id < :id))`,
      { connection: r.connection_id as string, at: String(r.submitted_at), id: String(r.id) },
    );
    const running = [...this.#running.values()].filter((x) => x.connectionId === r.connection_id).length;
    const slots = this.deps.settings.defaults().concurrencyPerConnection;
    const reason =
      this.#running.size >= this.#globalCap
        ? `The server is running its maximum of ${this.#globalCap} executions.`
        : running >= slots
          ? `Waiting for a free slot on ${String(r.connection_name)} (${running} of ${slots} in use).`
          : 'Starting.';
    return { position: Number(ahead?.n ?? 0) + 1, reason };
  }

  #row(id: string): Row {
    const row = this.ctx.db.get('SELECT * FROM executions WHERE id = :id', { id });
    assert(row, 'not_found', 'Execution not found.', { id });
    return row;
  }

  /** Owners see their executions; administrators see all. */
  #assertVisible(actor: Actor, row: Row): void {
    if (canSeeExecution(this.ctx.db, actor, row)) return;
    throw new AppError('not_found', 'Execution not found.', { id: String(row.id) });
  }

  #changed(id: string): void {
    const row = this.ctx.db.get('SELECT status, connection_id FROM executions WHERE id = :id', { id });
    this.events.emit('change', { id, status: row?.status, connectionId: row?.connection_id ?? null });
  }

  /**
   * What would happen if this SQL were submitted: statement ranges for the editor, the policy and
   * the preflight problems. Nothing is stored and nothing runs.
   */
  async check(
    actor: Actor,
    input: { connectionId: string; sql: string; transactionMode?: 'per_statement' | 'atomic' },
  ): Promise<{
    readOnly: boolean;
    policySources: string[];
    statements: unknown[];
    problems: PreflightProblem[];
  }> {
    requirePermission(actor, 'sql.read');
    const connection = this.deps.databases.usable(actor, input.connectionId);
    const profile = actor.profileId ? this.deps.profiles.findByClientId(actor.clientId) : undefined;
    const policy = evaluateWritePolicy({
      actor,
      connection: { name: connection.name, readOnly: connection.readOnly },
      ...(profile ? { profile: { name: profile.name, readOnly: profile.readOnly } } : {}),
    });
    const statements = await analyzeScript(input.sql, connection.engine);
    const problems = await preflight(statements, {
      engine: connection.engine,
      transactionMode: input.transactionMode ?? 'per_statement',
      readOnly: policy.readOnly,
      readOnlySources: policy.sources,
    });
    return {
      readOnly: policy.readOnly,
      policySources: policy.sources,
      statements: statements.map((s) => ({
        index: s.index,
        range: s.range,
        incomplete: s.incomplete,
        kind: s.analysis.kind,
        command: s.analysis.command,
        readOnlySafe: s.analysis.readOnlySafe,
        returnsRows: s.analysis.returnsRows,
        reasons: s.analysis.reasons,
      })),
      problems,
    };
  }

  /** Keeps captured results for `days` (at most the administrator maximum) after the run ended. */
  retain(actor: Actor, id: string, days: number): ExecutionView {
    const row = this.#row(id);
    this.#assertVisible(actor, row);
    const max = this.deps.settings.defaults().retainedMaxDays;
    if (!Number.isInteger(days) || days < 1 || days > max) {
      throw new AppError('validation_failed', `Keep results for 1 to ${max} days.`, {
        fields: [{ path: 'days', message: `1 to ${max}` }],
      });
    }
    const base = Date.parse(String(row.finished_at ?? row.submitted_at));
    const expires = new Date(base + days * 86_400_000).toISOString();
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        "UPDATE executions SET retention = 'retained', retain_days = :days, result_expires_at = :expires WHERE id = :id",
        { id, days, expires },
      );
      this.ctx.db.run(
        "UPDATE result_sets SET expires_at = :expires WHERE execution_id = :id AND completeness NOT IN ('expired', 'deleted')",
        { id, expires },
      );
      this.ctx.db.run(
        "UPDATE exports SET expires_at = :expires WHERE execution_id = :id AND status IN ('generating', 'ready')",
        { id, expires },
      );
      this.ctx.audit.record({
        actor,
        action: 'execution.retain',
        target: { type: 'execution', id },
        outcome: 'succeeded',
        details: { days },
      });
    });
    return this.view(id);
  }

  // ---------------------------------------------------------------- cancellation

  cancel(actor: Actor, id: string): ExecutionView {
    const row = this.#row(id);
    this.#assertVisible(actor, row);
    const now = isoNow(this.ctx);
    const queued = this.ctx.db.run(
      `UPDATE executions SET status = 'cancelled', finished_at = :now, cancel_requested_at = :now,
         status_note = 'Cancelled before it started.' WHERE id = :id AND status = 'queued'`,
      { id, now },
    );
    if (Number(queued.changes) > 0) {
      this.#finishAudit(actor, id, 'cancel', 'succeeded');
      this.#changed(id);
      return this.view(id);
    }
    const running = this.#running.get(id);
    if (running && row.status === 'running') {
      this.ctx.db.run(
        `UPDATE executions SET status = 'cancel_requested', cancel_requested_at = :now WHERE id = :id AND status = 'running'`,
        { id, now },
      );
      this.#finishAudit(actor, id, 'cancel', 'accepted');
      running.controller.abort();
      this.#changed(id);
    }
    return this.view(id);
  }

  #finishAudit(
    actor: Actor | 'system',
    id: string,
    what: string,
    outcome: 'succeeded' | 'accepted' | 'failed',
  ) {
    this.ctx.audit.record({ actor, action: `execution.${what}`, target: { type: 'execution', id }, outcome });
  }

  // ---------------------------------------------------------------- scheduling

  /** Starts queued executions in FIFO order while slots are free. */
  #pump(): void {
    if (this.#stopped) return;
    const slots = this.deps.settings.defaults().concurrencyPerConnection;
    const queued = this.ctx.db.all(
      "SELECT id, connection_id FROM executions WHERE status = 'queued' ORDER BY submitted_at, id",
    );
    for (const q of queued) {
      if (this.#running.size >= this.#globalCap) return;
      const connectionId = String(q.connection_id ?? '');
      const busy = [...this.#running.values()].filter((r) => r.connectionId === connectionId).length;
      if (busy >= slots) continue;
      try {
        this.#start(String(q.id), connectionId);
      } catch (error) {
        // One broken row must not stall the queue behind it.
        this.#failToStart(String(q.id), error);
      }
    }
  }

  #failToStart(id: string, error: unknown): void {
    // The cause goes to the audit trail for operators; the execution shows a plain message.
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    try {
      this.ctx.db.run(
        `UPDATE executions SET status = 'failed', finished_at = :now, error_code = 'internal',
           error_message = 'The execution could not be started.' WHERE id = :id AND status = 'queued'`,
        { id, now: isoNow(this.ctx) },
      );
      this.ctx.audit.record({
        actor: 'system',
        action: 'execution.error',
        target: { type: 'execution', id },
        outcome: 'failed',
        details: { stage: 'start', cause },
      });
      this.#changed(id);
    } catch {
      // The application database itself failed; the next start reconciles.
    }
  }

  /** Re-authorizes a queued execution and starts it, or rejects it if it may no longer run. */
  #start(id: string, connectionId: string): void {
    const row = this.#row(id);
    const refusal = this.#reauthorize(row);
    const now = isoNow(this.ctx);
    if (refusal) {
      this.ctx.db.run(
        `UPDATE executions SET status = 'rejected', finished_at = :now, error_code = :code, error_message = :message
          WHERE id = :id AND status = 'queued'`,
        { id, now, code: refusal.code, message: refusal.message },
      );
      this.#finishAudit('system', id, 'reject', 'succeeded');
      this.#changed(id);
      return;
    }
    const started = this.ctx.db.run(
      "UPDATE executions SET status = 'running', started_at = :now WHERE id = :id AND status = 'queued'",
      { id, now },
    );
    if (Number(started.changes) === 0) return;
    const controller = new AbortController();
    const entry: Running = { controller, connectionId, done: Promise.resolve() };
    this.#running.set(id, entry);
    this.#changed(id);
    entry.done = this.#run(id, controller.signal)
      .catch((error: unknown) => {
        try {
          this.#finalize(id, 'failed', 'unknown', {
            code: 'internal',
            message: 'The execution failed unexpectedly.',
          });
          this.ctx.audit.record({
            actor: 'system',
            action: 'execution.error',
            target: { type: 'execution', id },
            outcome: 'failed',
            details: { error: error instanceof Error ? error.message : String(error) },
          });
        } catch {
          // The application database is gone (shutdown); reconcile() reports it after the restart.
        }
      })
      .finally(() => {
        this.#running.delete(id);
        try {
          this.#changed(id);
          this.#pump();
        } catch {
          // As above.
        }
      });
  }

  #reauthorize(row: Row): AppError | null {
    const connectionId = row.connection_id as string | null;
    if (!connectionId)
      return new AppError('not_found', 'The connection was deleted before the execution started.');
    const connection = this.ctx.db.get('SELECT name, read_only, enabled FROM connections WHERE id = :id', {
      id: connectionId,
    });
    if (!connection)
      return new AppError('not_found', 'The connection was deleted before the execution started.');
    if (!bool(connection.enabled))
      return new AppError('connection_disabled', `Connection “${String(connection.name)}” is disabled.`);
    const actor: Actor = {
      subject: String(row.actor_subject),
      username: String(row.actor_subject),
      displayName: String(row.actor_subject),
      roles: parse(row.actor_roles, []) as Role[],
      source: row.source as Actor['source'],
      clientId: String(row.client_id),
      ...(row.profile_id ? { profileId: String(row.profile_id) } : {}),
    };
    let profile: { name: string; readOnly: boolean } | undefined;
    if (actor.source === 'mcp') {
      const p = row.profile_id ? this.deps.profiles.findByClientId(actor.clientId) : undefined;
      if (!p || p.id !== row.profile_id || !p.enabled || !p.connectionIds.includes(connectionId)) {
        return new AppError('forbidden', 'The MCP profile no longer allows this connection.');
      }
      profile = { name: p.name, readOnly: p.readOnly };
    }
    const policy = evaluateWritePolicy({
      actor,
      connection: { name: String(connection.name), readOnly: bool(connection.read_only) },
      ...(profile ? { profile } : {}),
    });
    if (policy.readOnly) {
      // The same test as the read-only preflight: statements of kind read can still be unsafe
      // (pg_terminate_backend, for example), so the stored analysis decides, not the kind.
      const unsafe = this.ctx.db.get(
        'SELECT count(*) AS n FROM statements WHERE execution_id = :id AND read_only_safe = 0',
        { id: String(row.id) },
      );
      if (!bool(row.read_only) && Number(unsafe?.n ?? 0) > 0) {
        return new AppError(
          'forbidden',
          `The policy became read-only (${policy.sources.join(', ')}) before the execution started; it contains writes.`,
        );
      }
      if (!bool(row.read_only)) {
        this.ctx.db.run('UPDATE executions SET read_only = 1, policy_sources = :sources WHERE id = :id', {
          id: String(row.id),
          sources: JSON.stringify(policy.sources),
        });
      }
    }
    return null;
  }

  async #adapter(connectionId: string): Promise<DbAdapter> {
    return this.deps.databases.adapterForConnection(connectionId);
  }

  // ---------------------------------------------------------------- running

  async #run(id: string, signal: AbortSignal): Promise<void> {
    const row = this.#row(id);
    const readOnly = bool(row.read_only);
    const atomic = row.transaction_mode === 'atomic';
    const continueOnError = bool(row.continue_on_error);
    const deadline = Date.now() + Number(row.timeout_ms);
    const defaults = this.deps.settings.defaults();
    const statements = this.ctx.db.all('SELECT * FROM statements WHERE execution_id = :id ORDER BY ordinal', {
      id,
    });
    const capture = { limit: this.ctx.limits.maxResultBytes, used: 0 };

    let adapter: DbAdapter;
    try {
      adapter = await this.#adapter(String(row.connection_id));
    } catch (error) {
      this.#finalize(id, 'failed', 'not_started', describe(error));
      return;
    }

    // The storage engines were checked at submission against the connection as it was then. The
    // connection may point elsewhere now (another database or host), and tables may have changed:
    // check again against the adapter that will run the script.
    if ((atomic && !readOnly) || (readOnly && row.engine === 'postgresql')) {
      // Bounded like the run itself: a cancel or the time limit ends it even if a lookup stalls, and
      // then stops the lookups too, so none is left waiting for the metadata connection.
      const lookups = new AbortController();
      const problems = await untilDone(
        this.#engineProblems(
          adapter,
          row.engine as Engine,
          String(row.sql),
          { transactionMode: atomic ? 'atomic' : 'per_statement', readOnly },
          lookups.signal,
        ),
        signal,
        deadline,
      );
      if (problems === 'cancelled' || problems === 'timeout') lookups.abort();
      if (problems === 'cancelled') {
        this.#finalize(id, 'cancelled', 'not_started', null, 'Cancelled before it started.');
        return;
      }
      if (problems === 'timeout') {
        this.#finalize(id, 'timed_out', 'not_started', {
          code: 'timeout',
          message: 'The time limit was reached while the tables and views were being checked. Nothing ran.',
        });
        return;
      }
      if (problems.length) {
        this.#finalize(id, 'rejected', 'not_started', {
          code: 'preflight_rejected',
          message: problems.map((p) => p.message).join(' '),
          detail: { problems },
        });
        return;
      }
    }

    let resultIndex = 0;
    let committedWrites = 0;
    let unknownOutcome = false;
    type Failure = { status: ExecutionStatus; error: ReturnType<typeof describe> };
    let failure: Failure | null = null;
    let atomicOutcome: TransactionOutcome = 'not_started';

    const expiresAt = () => {
      // Read now, not from the snapshot at start: Retain may have been chosen while it ran.
      const current =
        this.ctx.db.get('SELECT retention, retain_days FROM executions WHERE id = :id', { id }) ?? row;
      return new Date(Date.now() + retentionHours(current, defaults) * 3_600_000).toISOString();
    };

    let skippedForCancel = false;
    /** MySQL: the database a USE in this script switched to, for unqualified names. */
    let database: string | null = null;
    try {
      await adapter.withSession(async (session: DbSession) => {
        // Commands outside a statement are bounded too: a cancel or the time limit gives a connection
        // that stopped answering a grace period, then closes it.
        const bounds = { signal, deadline };
        await session.tag(id, bounds);
        if (atomic) await session.begin({ readOnly, ...bounds });
        for (const st of statements) {
          if (signal.aborted) {
            skippedForCancel = true;
            break;
          }
          const ordinal = Number(st.ordinal);
          const timedOut = (): Failure => ({
            status: 'timed_out',
            error: { code: 'timeout', message: 'The execution reached its time limit.' },
          });
          if (deadline - Date.now() <= 0) {
            failure = timedOut();
            break;
          }
          // A read can still write through the functions it calls, directly or through the views it
          // names, unless the transaction is read-only. The lookup gives way to a cancel and to the
          // time limit.
          let writesThroughFunctions = false;
          if (st.kind === 'read' && !readOnly) {
            const analysis = await analyzeStatement(String(st.sql), row.engine as Engine);
            const refs = {
              functions: analysis.callsFunctions ?? [],
              relations: analysis.referencesTables ?? [],
            };
            // A built-in that changes data (a PostgreSQL large object) needs no lookup.
            if (analysis.builtinWrite) writesThroughFunctions = true;
            else if (refs.functions.length || refs.relations.length) {
              const lookups = new AbortController();
              const found = await untilDone(
                session.mayWriteThrough(refs, database, lookups.signal).catch(() => true),
                signal,
                deadline,
              );
              if (found === 'cancelled' || found === 'timeout') {
                lookups.abort();
                // The lookup may still be running on this session: it is not reused.
                session.markDirty('a function lookup did not finish');
                if (found === 'cancelled') skippedForCancel = true;
                else failure = timedOut();
                break;
              }
              writesThroughFunctions = found;
            }
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            failure = timedOut();
            break;
          }
          const writes =
            writesThroughFunctions || !(st.kind === 'read' || (readOnly && st.kind === 'session'));
          // A procedure (or, in MySQL, a prepared statement, which may itself be a CALL or DDL) can
          // commit part of its work and then fail: its failure promises no rollback, whatever the error.
          const command = String(st.command).toUpperCase();
          const mayCommit =
            command === 'CALL' ||
            (row.engine === 'mysql' && command === 'EXECUTE') ||
            // A top-level DO block may COMMIT (PostgreSQL allows transaction control there).
            (row.engine === 'postgresql' && command === 'DO');
          const startedAt = isoNow(this.ctx);
          const t0 = performance.now();
          // A read that writes through functions is recorded as a write before it starts, so the
          // transaction outcome, restart recovery and "run for the full result" treat it as one.
          this.ctx.db.run(
            `UPDATE statements SET status = 'running', started_at = :at,
               kind = CASE WHEN :promote = 1 THEN 'write' ELSE kind END WHERE execution_id = :id AND ordinal = :ordinal`,
            { id, ordinal, at: startedAt, promote: int(writesThroughFunctions) },
          );
          this.#changed(id);
          const sink = new ResultCapture(this.ctx.db, id, ordinal, resultIndex, {
            mode: row.capture_mode === 'full' ? 'full' : 'preview',
            previewRows: this.ctx.limits.previewRows,
            executionBytes: capture,
            budget: this.#budget,
            now: () => isoNow(this.ctx),
          });
          try {
            if (!atomic && readOnly) await session.begin({ readOnly: true, ...bounds });
            let outcome;
            try {
              outcome = await session.execute(String(st.sql), sink, {
                timeoutMs: remaining,
                signal,
                batchSize: sink.batchSize,
                // Reaching the capture limit may end a read, never a statement that changes data:
                // a procedure that returns rows and then writes must still finish, and so must a
                // SELECT whose functions write for every row.
                onStop: st.kind === 'read' && !writesThroughFunctions ? 'cancel' : 'drain',
              });
            } finally {
              // SET, user variables (SELECT @v := …) and the like stay on a pooled session: discard
              // it after this execution, so the next one (perhaps another user's) starts clean.
              if (bool(st.changes_session)) session.markDirty('session state may have changed');
            }
            if (!atomic && readOnly) await session.commit(bounds);
            if (row.engine === 'mysql' && String(st.command).toUpperCase() === 'USE') {
              database = (await analyzeStatement(String(st.sql), 'mysql')).usesDatabase ?? database;
            }
            sink.finish('complete', expiresAt());
            resultIndex += sink.count;
            const txOutcome: TransactionOutcome = atomic
              ? 'not_started'
              : writes && !readOnly
                ? 'committed'
                : 'none';
            if (txOutcome === 'committed') committedWrites++;
            this.ctx.db.run(
              `UPDATE statements SET status = 'succeeded', transaction_outcome = :tx, affected_rows = :affected, notices = :notices,
                 duration_ms = :ms WHERE execution_id = :id AND ordinal = :ordinal`,
              {
                id,
                ordinal,
                tx: txOutcome,
                affected: outcome.affectedRows,
                notices: outcome.notices.length ? JSON.stringify(outcome.notices) : null,
                ms: Math.round(performance.now() - t0),
              },
            );
          } catch (error) {
            // When storing the result is what failed, closing it can fail the same way: keep what
            // was stored and go on, so the statement's outcome is still recorded.
            try {
              sink.finish('interrupted', expiresAt());
            } catch {
              sink.abandon(expiresAt());
            }
            resultIndex += sink.count;
            const e = describe(error);
            const category = error instanceof DbError ? error.category : 'other';
            const lost = category === 'connectivity';
            const status: ExecutionStatus =
              category === 'cancelled'
                ? 'cancelled'
                : category === 'timeout'
                  ? 'timed_out'
                  : lost && writes && !readOnly
                    ? 'unknown'
                    : 'failed';
            if (!atomic && readOnly)
              await session.rollback().catch(() => session.markDirty('rollback failed'));
            // A syntax or read-only error stops the statement before it runs. A missing object or
            // privilege may be hit inside a trigger or stored function after earlier writes, so per
            // statement, a failed write rolls back only if everything it can reach is known to roll
            // back; a target table that does not exist wrote nothing.
            const nothingWritten = ['syntax', 'read_only'].includes(category);
            const missingIsHarmless = ['not_found', 'permission'].includes(category);
            // A failure that is not the database's (capturing the rows, storing the result) can come
            // after the statement committed: a write's outcome is then unknown, never rolled back.
            const notFromDatabase = !(error instanceof DbError);
            const uncertain =
              lost ||
              mayCommit ||
              (notFromDatabase && !atomic && writes && !readOnly) ||
              (row.engine === 'mysql' &&
                !atomic &&
                writes &&
                !readOnly &&
                !nothingWritten &&
                // Bounded: a cancel or the time limit (perhaps the failure itself) leaves the check
                // the grace period; one that does not finish leaves the outcome unknown.
                !(await withinBounds(
                  (lookups) =>
                    this.#failedWriteRolledBack(
                      adapter,
                      String(st.sql),
                      database,
                      missingIsHarmless,
                      lookups,
                    ),
                  { signal, deadline },
                  false,
                )));
            const txOutcome: TransactionOutcome = atomic
              ? 'not_started'
              : uncertain && writes && !readOnly
                ? 'unknown'
                : writes && !readOnly
                  ? 'rolled_back'
                  : 'none';
            if (txOutcome === 'unknown') unknownOutcome = true;
            this.ctx.db.run(
              `UPDATE statements SET status = :status, transaction_outcome = :tx, error_code = :code, error_message = :message,
                 error_detail = :detail, duration_ms = :ms WHERE execution_id = :id AND ordinal = :ordinal`,
              {
                id,
                ordinal,
                status: status === 'unknown' ? 'failed' : status,
                tx: txOutcome,
                code: e.code,
                message: e.message,
                detail: e.detail ? JSON.stringify(e.detail) : null,
                ms: Math.round(performance.now() - t0),
              },
            );
            if (lost) session.markDirty('connection lost');
            failure ??= { status, error: { ...e, message: `Statement ${ordinal + 1}: ${e.message}` } };
            // A connection left unfit for later statements (a changed client encoding) ends the script.
            const stop =
              atomic ||
              !continueOnError ||
              category === 'cancelled' ||
              category === 'timeout' ||
              lost ||
              error instanceof SessionUnusableError;
            if (stop) break;
          }
        }

        if (atomic) {
          if (failure || signal.aborted) {
            try {
              await session.rollback();
            } catch {
              session.markDirty('rollback failed');
            }
            // An open transaction is rolled back by the server when the connection drops, too.
            atomicOutcome = 'rolled_back';
          } else {
            this.ctx.db.run("UPDATE executions SET transaction_outcome = 'unknown' WHERE id = :id", { id });
            try {
              // A COMMIT whose answer is lost (the connection closed after it stopped answering) has
              // an unknown outcome.
              await session.commit(bounds);
              atomicOutcome = 'committed';
            } catch (error) {
              const e = describe(error);
              const lost = error instanceof DbError && error.category === 'connectivity';
              atomicOutcome = lost ? 'unknown' : 'rolled_back';
              failure = {
                status: lost ? 'unknown' : 'failed',
                error: {
                  ...e,
                  message: lost
                    ? `The connection was lost during COMMIT: ${e.message}`
                    : `COMMIT failed: ${e.message}`,
                },
              };
              session.markDirty('commit did not complete');
            }
          }
          this.ctx.db.run(
            `UPDATE statements SET transaction_outcome = :tx WHERE execution_id = :id AND status IN ('succeeded', 'failed')
               AND kind NOT IN ('read')`,
            { id, tx: readOnly ? 'none' : atomicOutcome },
          );
        }
      });
    } catch (error) {
      // Could not get a session (connection failure) or the session failed outside a statement.
      failure ??= { status: 'failed', error: describe(error) };
      if (atomic && atomicOutcome === 'not_started') atomicOutcome = 'rolled_back';
    }

    const cancelRequested = Boolean(
      this.ctx.db.get('SELECT cancel_requested_at FROM executions WHERE id = :id', { id })
        ?.cancel_requested_at,
    );
    let status: ExecutionStatus = failure ? (failure as { status: ExecutionStatus }).status : 'succeeded';
    let note: string | null = null;
    if (
      signal.aborted &&
      !failure &&
      (atomic ? (atomicOutcome as TransactionOutcome) !== 'committed' : skippedForCancel)
    ) {
      // Cancelled between statements (what ran stays as it is), or before COMMIT (rolled back).
      // When the last statement finished anyway, or a COMMIT already under way completed, the
      // execution succeeded and says so in its note. (atomicOutcome is set inside the session
      // callback, which the type checker does not follow: hence the cast.)
      status = 'cancelled';
    }
    if (status === 'succeeded' && cancelRequested) note = 'Completed before the cancellation took effect.';
    if (status === 'cancelled' && this.#shuttingDown && !cancelRequested) {
      // Nobody cancelled it: the server stopped. Like a restart, it is never run again.
      status = 'interrupted';
      note = 'The server shut down while this was running. It is not run again.';
    }

    let outcome: TransactionOutcome;
    if (readOnly) outcome = 'none';
    else if (atomic) outcome = atomicOutcome;
    else if (unknownOutcome) outcome = 'unknown';
    else if (committedWrites === 0) outcome = 'none';
    else outcome = status === 'succeeded' ? 'committed' : 'partial_commit';

    this.#finalize(
      id,
      status,
      outcome,
      failure ? (failure as { error: ReturnType<typeof describe> }).error : null,
      note,
      expiresAt(),
    );
  }

  #finalize(
    id: string,
    status: ExecutionStatus,
    outcome: TransactionOutcome,
    error: { code: string | null; message: string; detail?: unknown } | null,
    note: string | null = null,
    resultExpiresAt: string | null = null,
  ): void {
    this.ctx.db.run(
      `UPDATE executions SET status = :status, transaction_outcome = :outcome, finished_at = :now, error_code = :code,
         error_message = :message, error_detail = :detail, status_note = coalesce(:note, status_note), result_expires_at = :expires
       WHERE id = :id`,
      {
        id,
        status,
        outcome,
        now: isoNow(this.ctx),
        code: error?.code ?? null,
        message: error?.message ?? null,
        detail: error?.detail ? JSON.stringify(error.detail) : null,
        note,
        expires: resultExpiresAt,
      },
    );
    this.ctx.audit.record({
      actor: 'system',
      action: 'execution.finish',
      target: { type: 'execution', id },
      outcome: status === 'succeeded' ? 'succeeded' : 'failed',
      details: { status, transactionOutcome: outcome },
    });
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * After a restart: work that was running is marked interrupted and never replayed. Queued work
   * stays queued and is authorized again when it starts.
   */
  /** MySQL single transaction: storage-engine problems of the script, checked through `adapter`. */
  async #engineProblems(
    adapter: DbAdapter,
    engine: Engine,
    sql: string,
    mode: { transactionMode: 'atomic' | 'per_statement'; readOnly: boolean },
    signal: AbortSignal,
  ) {
    const statements = await analyzeScript(sql, engine);
    const problems = await preflight(statements, {
      engine,
      ...mode,
      tableEngine: async (table) => {
        signal.throwIfAborted();
        try {
          return await adapter.tableEngine(table, signal);
        } catch {
          return 'unknown (the storage engine could not be checked)';
        }
      },
      functionEngine: async (fn) => {
        signal.throwIfAborted();
        try {
          return await adapter.functionEngine(fn, signal);
        } catch {
          return 'unknown (the storage engine could not be checked)';
        }
      },
      viewEngine: async (table) => {
        signal.throwIfAborted();
        try {
          return await adapter.viewEngine(table, signal);
        } catch {
          return 'unknown (the storage engine could not be checked)';
        }
      },
      viewEffects: async (table) => {
        signal.throwIfAborted();
        try {
          return await adapter.viewEffects(table, signal);
        } catch {
          return { irreversible: VIEW_UNCHECKED, notReadOnly: VIEW_UNCHECKED };
        }
      },
    });
    // What the database holds now; the script's own statements were checked at submission.
    return problems.filter(
      (p) =>
        p.code === 'non_transactional_engine' ||
        p.code === 'unchecked_write_target' ||
        (['irreversible_effect', 'read_only_violation'].includes(p.code) &&
          p.message.includes(' reads the view ')),
    );
  }

  /**
   * MySQL, per statement: whether a write that failed is known to have changed nothing. InnoDB
   * undoes a failed statement; MyISAM and other non-transactional tables keep the rows written
   * before the error (a multi-row INSERT that hits a duplicate key half way).
   */
  async #failedWriteRolledBack(
    adapter: DbAdapter,
    sql: string,
    database: string | null,
    missingIsHarmless: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    const analysis = await analyzeStatement(sql, 'mysql');
    if (analysis.writeTargetsUnknown || analysis.mayCommit || analysis.irreversible) return false;
    const declared = analysis.declaredEngine?.toLowerCase();
    if (declared && !TRANSACTIONAL_ENGINES.has(declared)) return false;
    for (const table of analysis.writesTables) {
      let engine: string | null;
      try {
        engine = await adapter.tableEngine({ ...table, schema: table.schema ?? database }, signal);
      } catch {
        return false;
      }
      // No engine found: a temporary table (invisible to the metadata connection, possibly MyISAM)
      // or one that is gone. Its rollback is not established, unless the error says an object was
      // missing: a table that does not exist wrote nothing, and a temporary one has no triggers.
      if (!engine) {
        if (missingIsHarmless) continue;
        return false;
      }
      if (engine === UNRESOLVED_VIEW || !TRANSACTIONAL_ENGINES.has(engine.toLowerCase())) return false;
    }
    // A stored function, called directly or by a view, may have written a non-transactional table
    // before the statement failed.
    const reached = [
      ...(analysis.callsFunctions ?? []).map(
        (fn) => () => adapter.functionEngine({ ...fn, schema: fn.schema ?? database }, signal),
      ),
      ...(analysis.referencesTables ?? []).map(
        (t) => () => adapter.viewEngine({ ...t, schema: t.schema ?? database }, signal),
      ),
    ];
    for (const lookup of reached) {
      let engine: string | null;
      try {
        engine = await lookup();
      } catch {
        return false;
      }
      const base = engine?.split(' ')[0];
      if (engine === UNRESOLVED_VIEW || (base && !TRANSACTIONAL_ENGINES.has(base.toLowerCase())))
        return false;
    }
    return true;
  }

  reconcile(): { interrupted: number; queued: number } {
    const now = isoNow(this.ctx);
    const inFlight = this.ctx.db.all(
      `SELECT id, transaction_mode, transaction_outcome, read_only, retention, retain_days FROM executions
        WHERE status IN ('running', 'cancel_requested')`,
    );
    const defaults = this.deps.settings.defaults();
    this.ctx.db.transaction(() => {
      for (const e of inFlight) {
        const id = String(e.id);
        const running = this.ctx.db.get(
          "SELECT kind FROM statements WHERE execution_id = :id AND status = 'running'",
          { id },
        );
        const committed = Number(
          this.ctx.db.get(
            "SELECT count(*) AS n FROM statements WHERE execution_id = :id AND transaction_outcome = 'committed'",
            { id },
          )?.n ?? 0,
        );
        let outcome: TransactionOutcome;
        if (bool(e.read_only)) outcome = 'none';
        else if (e.transaction_mode === 'atomic') {
          // 'unknown' was written just before COMMIT; otherwise the server rolled the transaction back.
          outcome = e.transaction_outcome === 'unknown' ? 'unknown' : 'rolled_back';
        } else if (running && running.kind !== 'read') outcome = 'unknown';
        // A statement that already ended uncertain (a procedure that failed after committing) keeps
        // the execution uncertain, whatever was running when the server stopped.
        else if (
          this.ctx.db.get(
            "SELECT 1 AS found FROM statements WHERE execution_id = :id AND transaction_outcome = 'unknown'",
            { id },
          )
        )
          outcome = 'unknown';
        else outcome = committed > 0 ? 'partial_commit' : 'none';
        this.ctx.db.run(
          `UPDATE statements SET status = 'interrupted', transaction_outcome = CASE WHEN kind = 'read' THEN 'none' ELSE 'unknown' END
            WHERE execution_id = :id AND status = 'running'`,
          { id },
        );
        // Chunks written before the crash stay readable.
        closeCapturing(
          this.ctx.db,
          id,
          new Date(Date.parse(now) + retentionHours(e, defaults) * 3_600_000).toISOString(),
        );
        this.ctx.db.run(
          `UPDATE executions SET status = 'interrupted', transaction_outcome = :outcome, finished_at = :now,
             status_note = 'The server restarted while this execution was running. It was not run again.' WHERE id = :id`,
          { id, outcome, now },
        );
        this.ctx.audit.record({
          actor: 'system',
          action: 'execution.interrupt',
          target: { type: 'execution', id },
          outcome: 'succeeded',
        });
      }
    });
    const queued = Number(
      this.ctx.db.get("SELECT count(*) AS n FROM executions WHERE status = 'queued'")?.n ?? 0,
    );
    this.#budget.recount(this.ctx.db);
    return { interrupted: inFlight.length, queued };
  }

  /** Starts queued work (after reconcile at startup). */
  resume(): void {
    this.#stopped = false;
    this.#shuttingDown = false;
    this.#pump();
  }

  /**
   * Expires captured results past their retention and deletes execution metadata past its
   * retention. Returns what it removed.
   */
  cleanup(now = this.ctx.clock.now()): {
    resultsExpired: number;
    bytesFreed: number;
    executionsDeleted: number;
  } {
    const at = now.toISOString();
    // A result still capturing after its execution ended was never closed (closing it after a
    // failure failed too). Without a deadline it would never expire, and it would keep its
    // execution's metadata as well: close it, due a retention period after the execution ended.
    const stray = this.ctx.db.all(
      `SELECT DISTINCT e.id, e.retention, e.retain_days, e.finished_at FROM result_sets r
         JOIN executions e ON e.id = r.execution_id
        WHERE r.completeness = 'capturing' AND e.status IN ${TERMINAL}`,
    );
    if (stray.length) {
      const defaults = this.deps.settings.defaults();
      this.ctx.db.transaction(() => {
        for (const e of stray) {
          const ended = Date.parse(String(e.finished_at));
          const from = Number.isNaN(ended) ? now.getTime() : ended;
          closeCapturing(
            this.ctx.db,
            String(e.id),
            new Date(from + retentionHours(e, defaults) * 3_600_000).toISOString(),
          );
        }
      });
      this.#budget.recount(this.ctx.db);
    }
    const expired = this.ctx.db.all(
      `SELECT r.execution_id, r.result_index, r.byte_count FROM result_sets r
         JOIN executions e ON e.id = r.execution_id
        WHERE r.completeness NOT IN ('expired', 'deleted', 'capturing') AND r.expires_at IS NOT NULL AND r.expires_at <= :at
          AND e.status IN ${TERMINAL}`,
      { at },
    );
    let bytes = 0;
    this.ctx.db.transaction(() => {
      for (const r of expired) {
        this.ctx.db.run('DELETE FROM result_chunks WHERE execution_id = :id AND result_index = :index', {
          id: String(r.execution_id),
          index: Number(r.result_index),
        });
        this.ctx.db.run(
          "UPDATE result_sets SET completeness = 'expired' WHERE execution_id = :id AND result_index = :index",
          { id: String(r.execution_id), index: Number(r.result_index) },
        );
        bytes += Number(r.byte_count);
      }
    });
    this.#budget.release(bytes);
    const old = this.ctx.db.all(
      `SELECT e.id FROM executions e WHERE ${METADATA_DUE} AND e.status IN ${TERMINAL}`,
      { at },
    );
    this.ctx.db.transaction(() => {
      for (const e of old) {
        const sets = this.ctx.db.get(
          "SELECT coalesce(sum(byte_count), 0) AS b FROM result_sets WHERE execution_id = :id AND completeness NOT IN ('expired', 'deleted')",
          { id: String(e.id) },
        );
        this.#budget.release(Number(sets?.b ?? 0));
        this.ctx.db.run('DELETE FROM executions WHERE id = :id', { id: String(e.id) });
      }
    });
    if (expired.length || old.length) {
      this.ctx.audit.record({
        actor: 'system',
        action: 'retention.cleanup',
        outcome: 'succeeded',
        details: { resultsExpired: expired.length, bytesFreed: bytes, executionsDeleted: old.length },
      });
    }
    return { resultsExpired: expired.length, bytesFreed: bytes, executionsDeleted: old.length };
  }

  /** Waits until nothing is running (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.#running.size) await Promise.allSettled([...this.#running.values()].map((r) => r.done));
  }

  /**
   * Shutdown: stops starting new work (queued work stays queued for the next start), lets running
   * work finish for up to `graceMs`, then interrupts what is left.
   */
  async stop(graceMs = 0): Promise<void> {
    this.#stopped = true;
    if (graceMs > 0 && this.#running.size) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.idle(), new Promise((r) => (timer = setTimeout(r, graceMs)))]);
      clearTimeout(timer);
    }
    this.#shuttingDown = true;
    for (const r of this.#running.values()) r.controller.abort();
    await this.idle();
  }
}

function describe(error: unknown): { code: string | null; message: string; detail?: unknown } {
  if (error instanceof DbError) {
    return {
      code: error.code ?? error.category,
      message: error.message,
      detail: {
        category: error.category,
        sqlState: error.sqlState,
        detail: error.detail,
        hint: error.hint,
        position: error.position,
        server: error.server,
      },
    };
  }
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'internal', message: 'Unexpected error.' };
}

export type { Cell };

export { submitSchema as executionSubmitSchema };
