import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { Cell, ColumnInfo } from '../db/types.js';
import { AppError, assert } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import type { Actor, Completeness } from '../domain/types.js';
import { can, requirePermission } from '../security/policy.js';
import { isoNow, type ServiceContext } from '../services/context.js';
import type { ProfileService } from '../services/profiles.js';
import { parseInput } from '../services/validation.js';
import type { Row } from '../store/database.js';
import { readRows, resultGone } from './capture.js';
import type { ExecutionView } from './service.js';
import { canSeeExecution } from './visibility.js';

type ErrorView = ExecutionView['error'];

/**
 * An error message the database server wrote, whatever its category (a function can raise any
 * SQLSTATE with any text). Errors stored before the marker existed count when they have a SQLSTATE.
 */
function fromDatabase(error: NonNullable<ErrorView>): boolean {
  const detail = error.detail as { sqlState?: unknown; server?: unknown } | null;
  if (typeof detail?.server === 'boolean') return detail.server;
  return typeof detail?.sqlState === 'string';
}

const decideSchema = z
  .object({
    /** Rows granted (default what was requested) and a byte cap (default the whole result set). */
    rows: z.number().int().positive().optional(),
    bytes: z.number().int().positive().optional(),
    /** Minutes until the approval expires; default 60, bounded by the result's retention. */
    minutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60)
      .optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export type DecideInput = z.input<typeof decideSchema>;

export interface ApprovalView {
  id: string;
  executionId: string;
  executionTitle: string;
  connectionName: string;
  resultIndex: number;
  profile: { id: string | null; name: string };
  status: 'pending' | 'active' | 'expired' | 'revoked' | 'denied';
  requested: { rows: number; bytes: number; by: string | null; at: string };
  granted: { rows: number; bytes: number } | null;
  delivered: { rows: number; bytes: number };
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  note: string | null;
}

export interface DisclosedPage {
  columns: ColumnInfo[];
  rows: Cell[][];
  offset: number;
  /** Rows captured in this result set. */
  captured: number;
  completeness: Completeness;
  /** The requested page was cut because the allowance ran out. */
  truncated: boolean;
  allowance: {
    rowsRemaining: number;
    bytesRemaining: number;
    approvedRowsRemaining: number;
    approvedBytesRemaining: number;
  };
  /** Present when more rows need a human approval. */
  approval: { id: string; status: 'pending'; message: string } | null;
}

const rowBytes = (row: Cell[]) => Buffer.byteLength(JSON.stringify(row)) + 1;

/**
 * What an MCP client may receive of a captured result. Every delivered row counts against the
 * profile's allowance for the execution, whatever the call or page. Beyond it, rows flow only under
 * an approval that an authenticated human gave in the GUI for that one result set and profile.
 */
export class DisclosureService {
  /** `change` with `{ id }` whenever an approval is requested, granted, denied or revoked. */
  readonly events = new EventEmitter();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly profiles: ProfileService,
  ) {}

  /** Rows for an MCP client, within its allowance and approvals. */
  page(
    actor: Actor,
    executionId: string,
    resultIndex: number,
    request: { offset?: number; limit?: number } = {},
  ): DisclosedPage {
    if (actor.source !== 'mcp' || !actor.profileId)
      throw new AppError('forbidden', 'Disclosure applies to MCP clients only.');
    const profile = this.profiles.findByClientId(actor.clientId);
    if (!profile || profile.id !== actor.profileId || !profile.enabled) {
      throw new AppError('profile_disabled', 'The MCP profile is not available.');
    }
    const execution = this.ctx.db.get('SELECT * FROM executions WHERE id = :id', { id: executionId });
    // Owner, and a connection the profile allows now (not only when the execution ran).
    if (!execution || !canSeeExecution(this.ctx.db, actor, execution))
      throw new AppError('not_found', 'Execution not found.', { id: executionId });
    const set = this.ctx.db.get(
      'SELECT * FROM result_sets WHERE execution_id = :id AND result_index = :index',
      {
        id: executionId,
        index: resultIndex,
      },
    );
    assert(set, 'not_found', 'Result set not found.', { resultIndex });
    const completeness = String(set.completeness) as Completeness;
    if (resultGone(set, this.ctx.clock.now())) {
      throw new AppError('result_expired', 'The captured result is no longer stored.');
    }
    this.#expire();

    const offset = Math.max(0, request.offset ?? 0);
    const limit = Math.min(Math.max(1, request.limit ?? 100), 500);
    const captured = Number(set.row_count);
    const usage = this.ctx.db.get(
      'SELECT * FROM mcp_usage WHERE execution_id = :id AND profile_id = :profile',
      {
        id: executionId,
        profile: profile.id,
      },
    );
    let baseRows = Math.max(0, profile.previewRows - Number(usage?.rows_returned ?? 0));
    let baseBytes = Math.max(0, profile.previewBytes - Number(usage?.bytes_returned ?? 0));
    const approval = this.ctx.db.get(
      `SELECT * FROM disclosure_approvals WHERE execution_id = :id AND result_index = :index AND profile_id = :profile
          AND status = 'active' ORDER BY decided_at DESC LIMIT 1`,
      { id: executionId, index: resultIndex, profile: profile.id },
    );
    let approvedRows = approval
      ? Math.max(0, Number(approval.granted_rows) - Number(approval.rows_delivered))
      : 0;
    let approvedBytes = approval
      ? Math.max(0, Number(approval.granted_bytes) - Number(approval.bytes_delivered))
      : 0;

    const candidates =
      offset < captured
        ? readRows(this.ctx.db, executionId, resultIndex, offset, Math.min(limit, captured - offset))
        : [];
    const rows: Cell[][] = [];
    let fromBase = { rows: 0, bytes: 0 };
    let fromApproval = { rows: 0, bytes: 0 };
    for (const row of candidates) {
      const bytes = rowBytes(row);
      if (baseRows >= 1 && baseBytes >= bytes) {
        baseRows--;
        baseBytes -= bytes;
        fromBase = { rows: fromBase.rows + 1, bytes: fromBase.bytes + bytes };
      } else if (approvedRows >= 1 && approvedBytes >= bytes) {
        approvedRows--;
        approvedBytes -= bytes;
        fromApproval = { rows: fromApproval.rows + 1, bytes: fromApproval.bytes + bytes };
      } else break;
      rows.push(row);
    }
    const truncated = rows.length < candidates.length;

    this.ctx.db.transaction(() => {
      if (fromBase.rows) {
        this.ctx.db.run(
          `INSERT INTO mcp_usage (execution_id, profile_id, rows_returned, bytes_returned) VALUES (:id, :profile, :rows, :bytes)
           ON CONFLICT (execution_id, profile_id) DO UPDATE SET rows_returned = rows_returned + excluded.rows_returned,
             bytes_returned = bytes_returned + excluded.bytes_returned`,
          { id: executionId, profile: profile.id, rows: fromBase.rows, bytes: fromBase.bytes },
        );
      }
      if (fromApproval.rows && approval) {
        this.ctx.db.run(
          'UPDATE disclosure_approvals SET rows_delivered = rows_delivered + :rows, bytes_delivered = bytes_delivered + :bytes WHERE id = :id',
          { id: String(approval.id), rows: fromApproval.rows, bytes: fromApproval.bytes },
        );
      }
      if (rows.length) {
        this.ctx.audit.record({
          actor,
          action: 'mcp.result',
          target: { type: 'execution', id: executionId },
          outcome: 'succeeded',
          details: {
            resultIndex,
            offset,
            rows: rows.length,
            bytes: fromBase.bytes + fromApproval.bytes,
            approved: fromApproval.rows > 0,
          },
        });
      }
    });
    // The owner's approval list shows how much of the approval is used.
    if (fromApproval.rows && approval) this.events.emit('change', { id: String(approval.id) });

    let pending: DisclosedPage['approval'] = null;
    if (truncated) pending = this.#request(actor, execution, resultIndex, set, profile, offset + rows.length);
    return {
      columns: JSON.parse(String(set.columns)) as ColumnInfo[],
      rows,
      offset,
      captured,
      completeness,
      truncated,
      allowance: {
        rowsRemaining: baseRows,
        bytesRemaining: baseBytes,
        approvedRowsRemaining: approvedRows,
        approvedBytesRemaining: approvedBytes,
      },
      approval: pending,
    };
  }

  /** Opens (or reuses) a pending request for the rest of a result set. */
  #request(
    actor: Actor,
    execution: Row,
    resultIndex: number,
    set: Row,
    profile: { id: string; name: string },
    from: number,
  ): DisclosedPage['approval'] {
    const existing = this.ctx.db.get(
      `SELECT id FROM disclosure_approvals WHERE execution_id = :id AND result_index = :index AND profile_id = :profile
          AND status = 'pending'`,
      { id: String(execution.id), index: resultIndex, profile: profile.id },
    );
    const message =
      'This result is larger than the MCP allowance. The user must approve the rest in Database Workbench (Approvals), then call get_result again.';
    if (existing) return { id: String(existing.id), status: 'pending', message };
    const total = Number(set.row_count);
    const rows = Math.max(1, total - from);
    const bytes = Math.max(1, Math.ceil((Number(set.byte_count) * rows) / Math.max(1, total)));
    const id = newId('approval', this.ctx.clock.now());
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO disclosure_approvals (id, execution_id, result_index, profile_id, profile_name, status, requested_rows,
           requested_bytes, requested_by, requested_at)
         VALUES (:id, :execution, :index, :profile, :name, 'pending', :rows, :bytes, :by, :now)`,
        {
          id,
          execution: String(execution.id),
          index: resultIndex,
          profile: profile.id,
          name: profile.name,
          rows,
          bytes,
          by: actor.subject,
          now: isoNow(this.ctx),
        },
      );
      this.ctx.audit.record({
        actor,
        action: 'disclosure.request',
        target: { type: 'approval', id, label: String(execution.title) },
        outcome: 'pending',
        details: { executionId: String(execution.id), resultIndex, rows, bytes },
      });
    });
    this.events.emit('change', { id });
    return { id, status: 'pending', message };
  }

  // ---------------------------------------------------------------- human decisions (GUI)

  list(actor: Actor, filter: { status?: ApprovalView['status'] } = {}): ApprovalView[] {
    requirePermission(actor, 'disclosure.decide');
    this.#expire();
    const admin = can(actor, 'connections.manage');
    return this.ctx.db
      .all(
        `SELECT a.id FROM disclosure_approvals a JOIN executions e ON e.id = a.execution_id
          WHERE (:admin = 1 OR e.owner = :owner) ${filter.status ? 'AND a.status = :status' : ''}
          ORDER BY a.requested_at DESC LIMIT 200`,
        { admin: admin ? 1 : 0, owner: actor.subject, ...(filter.status ? { status: filter.status } : {}) },
      )
      .map((r) => this.view(String(r.id)));
  }

  /**
   * Approves a pending request. Only the human who owns the execution may approve, signed in to
   * the GUI; MCP clients can never decide (their tokens carry no disclosure permission).
   */
  approve(actor: Actor, id: string, input: DecideInput = {}): ApprovalView {
    const v = parseInput(decideSchema, input);
    const row = this.#decidable(actor, id, 'approve');
    const set = this.ctx.db.get(
      'SELECT expires_at, byte_count FROM result_sets WHERE execution_id = :id AND result_index = :index',
      {
        id: String(row.execution_id),
        index: Number(row.result_index),
      },
    );
    // The person decides in rows. The requested bytes are an estimate from the average row size, so
    // by default the byte cap is the whole result set: an approval never reaches beyond it anyway.
    const bytes = v.bytes ?? Math.max(Number(row.requested_bytes), Number(set?.byte_count ?? 0));
    const rows = v.rows ?? Number(row.requested_rows);
    const now = this.ctx.clock.now();
    const wanted = now.getTime() + (v.minutes ?? 60) * 60_000;
    const retention = set?.expires_at ? Date.parse(String(set.expires_at)) : wanted;
    const expires = new Date(Math.min(wanted, retention)).toISOString();
    this.ctx.db.transaction(() => {
      // One active approval per result set and profile: a new one replaces the old.
      this.ctx.db.run(
        `UPDATE disclosure_approvals SET status = 'revoked', note = 'Replaced by a newer approval.'
          WHERE execution_id = :execution AND result_index = :index AND profile_id = :profile AND status = 'active'`,
        {
          execution: String(row.execution_id),
          index: Number(row.result_index),
          profile: row.profile_id as string | null,
        },
      );
      this.ctx.db.run(
        `UPDATE disclosure_approvals SET status = 'active', granted_rows = :rows, granted_bytes = :bytes, decided_by = :by,
           decided_at = :now, expires_at = :expires, note = :note WHERE id = :id`,
        {
          id,
          rows,
          bytes,
          by: actor.subject,
          now: now.toISOString(),
          expires,
          note: v.note ?? null,
        },
      );
      this.ctx.audit.record({
        actor,
        action: 'disclosure.approve',
        target: { type: 'approval', id },
        outcome: 'succeeded',
        details: {
          rows,
          bytes,
          expiresAt: expires,
        },
      });
    });
    this.events.emit('change', { id });
    return this.view(id);
  }

  /**
   * The owner shares a result with an MCP profile in advance ("Share full result with MCP"), without
   * waiting for a request. Same scope and limits as an approval.
   */
  grant(
    actor: Actor,
    executionId: string,
    resultIndex: number,
    input: DecideInput & { profileId: string },
  ): ApprovalView {
    requirePermission(actor, 'disclosure.decide');
    if (actor.source !== 'gui') {
      throw new AppError('forbidden', 'Disclosure is decided by a person in the Database Workbench GUI.');
    }
    const execution = this.ctx.db.get('SELECT owner FROM executions WHERE id = :id', { id: executionId });
    if (!execution || execution.owner !== actor.subject) {
      throw new AppError('not_found', 'Execution not found.', { id: executionId });
    }
    const set = this.ctx.db.get(
      'SELECT * FROM result_sets WHERE execution_id = :id AND result_index = :index',
      {
        id: executionId,
        index: resultIndex,
      },
    );
    if (!set || set.completeness === 'capturing' || resultGone(set, this.ctx.clock.now())) {
      throw new AppError('result_expired', 'The result is not stored.');
    }
    const profile = this.ctx.db.get('SELECT id, name FROM mcp_profiles WHERE id = :id', {
      id: input.profileId,
    });
    assert(profile, 'not_found', 'MCP profile not found.', { profileId: input.profileId });
    const id = newId('approval', this.ctx.clock.now());
    this.ctx.db.run(
      `INSERT INTO disclosure_approvals (id, execution_id, result_index, profile_id, profile_name, status, requested_rows,
         requested_bytes, requested_by, requested_at)
       VALUES (:id, :execution, :index, :profile, :name, 'pending', :rows, :bytes, :by, :now)`,
      {
        id,
        execution: executionId,
        index: resultIndex,
        profile: String(profile.id),
        name: String(profile.name),
        rows: input.rows ?? Number(set.row_count),
        bytes: input.bytes ?? Number(set.byte_count),
        by: actor.subject,
        now: isoNow(this.ctx),
      },
    );
    const { profileId: _profileId, ...decision } = input;
    return this.approve(actor, id, decision);
  }

  deny(actor: Actor, id: string, note?: string): ApprovalView {
    this.#decidable(actor, id, 'deny');
    this.#close(actor, id, 'denied', note ?? null);
    return this.view(id);
  }

  /** Ends an active approval: further pages beyond the allowance are refused. */
  revoke(actor: Actor, id: string, note?: string): ApprovalView {
    requirePermission(actor, 'disclosure.decide');
    const row = this.#row(id);
    this.#ownerOrAdmin(actor, row);
    if (row.status !== 'active' && row.status !== 'pending') return this.view(id);
    this.#close(actor, id, 'revoked', note ?? null);
    return this.view(id);
  }

  view(id: string): ApprovalView {
    this.#expire();
    const r = this.ctx.db.get(
      `SELECT a.*, e.title, e.connection_name FROM disclosure_approvals a JOIN executions e ON e.id = a.execution_id WHERE a.id = :id`,
      { id },
    );
    assert(r, 'not_found', 'Approval not found.', { id });
    return {
      id,
      executionId: String(r.execution_id),
      executionTitle: String(r.title),
      connectionName: String(r.connection_name),
      resultIndex: Number(r.result_index),
      profile: { id: (r.profile_id as string | null) ?? null, name: String(r.profile_name) },
      status: r.status as ApprovalView['status'],
      requested: {
        rows: Number(r.requested_rows),
        bytes: Number(r.requested_bytes),
        by: (r.requested_by as string | null) ?? null,
        at: String(r.requested_at),
      },
      granted:
        r.granted_rows === null ? null : { rows: Number(r.granted_rows), bytes: Number(r.granted_bytes) },
      delivered: { rows: Number(r.rows_delivered), bytes: Number(r.bytes_delivered) },
      decidedBy: (r.decided_by as string | null) ?? null,
      decidedAt: (r.decided_at as string | null) ?? null,
      expiresAt: (r.expires_at as string | null) ?? null,
      note: (r.note as string | null) ?? null,
    };
  }

  #row(id: string): Row {
    const row = this.ctx.db.get(
      'SELECT a.*, e.owner FROM disclosure_approvals a JOIN executions e ON e.id = a.execution_id WHERE a.id = :id',
      { id },
    );
    assert(row, 'not_found', 'Approval not found.', { id });
    return row;
  }

  #ownerOrAdmin(actor: Actor, row: Row): void {
    if (row.owner === actor.subject || can(actor, 'connections.manage')) return;
    throw new AppError('not_found', 'Approval not found.', { id: String(row.id) });
  }

  #decidable(actor: Actor, id: string, what: 'approve' | 'deny'): Row {
    requirePermission(actor, 'disclosure.decide');
    if (actor.source !== 'gui')
      throw new AppError('forbidden', 'Disclosure is decided by a person in the Database Workbench GUI.');
    this.#expire();
    const row = this.#row(id);
    // Others do not learn that the request exists; administrators may deny but not approve.
    this.#ownerOrAdmin(actor, row);
    if (what === 'approve' && row.owner !== actor.subject) {
      throw new AppError('forbidden', 'Only the person whose MCP client asked can approve this disclosure.');
    }
    if (row.status !== 'pending')
      throw new AppError('validation_failed', `This request is ${String(row.status)}.`);
    const set = this.ctx.db.get(
      'SELECT completeness, expires_at FROM result_sets WHERE execution_id = :id AND result_index = :index',
      {
        id: String(row.execution_id),
        index: Number(row.result_index),
      },
    );
    if (!set || resultGone(set, this.ctx.clock.now())) {
      throw new AppError('result_expired', 'The result is no longer stored.');
    }
    return row;
  }

  #close(actor: Actor, id: string, status: 'denied' | 'revoked', note: string | null): void {
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        'UPDATE disclosure_approvals SET status = :status, decided_by = :by, decided_at = :now, note = :note WHERE id = :id',
        {
          id,
          status,
          by: actor.subject,
          now: isoNow(this.ctx),
          note,
        },
      );
      this.ctx.audit.record({
        actor,
        action: `disclosure.${status === 'denied' ? 'deny' : 'revoke'}`,
        target: { type: 'approval', id },
        outcome: 'succeeded',
      });
    });
    this.events.emit('change', { id });
  }

  /**
   * The execution as an MCP client may see it. Error messages the database composed can quote data
   * (an invalid value, a duplicate key, text a function raised), so each counts once against the
   * profile's byte allowance for the execution, like captured rows. One the allowance cannot cover
   * is withheld; its code stays. Messages this tool wrote, and the GUI's view, are unchanged.
   */
  diagnostics(actor: Actor, view: ExecutionView): ExecutionView {
    if (actor.source !== 'mcp') return view;
    const profile = actor.profileId ? this.profiles.findByClientId(actor.clientId) : null;
    if (!profile || profile.id !== actor.profileId || !profile.enabled) {
      throw new AppError('profile_disabled', 'The MCP profile is not available.');
    }
    const reveal = (item: string, error: ErrorView): ErrorView =>
      error && fromDatabase(error)
        ? { ...error, message: this.#diagnostic(actor, view.id, profile, item, error.message) }
        : error;
    return {
      ...view,
      error: reveal('execution', view.error),
      statements: view.statements.map((s) => ({ ...s, error: reveal(`statement:${s.ordinal}`, s.error) })),
    };
  }

  #diagnostic(
    actor: Actor,
    executionId: string,
    profile: { id: string; previewBytes: number },
    item: string,
    message: string,
  ): string {
    const bytes = Buffer.byteLength(message);
    const disclosed = this.ctx.db.transaction(() => {
      const key = { id: executionId, profile: profile.id, item };
      const seen = this.ctx.db.get(
        'SELECT disclosed FROM mcp_diagnostics WHERE execution_id = :id AND profile_id = :profile AND item = :item',
        key,
      );
      if (seen) return Boolean(Number(seen.disclosed));
      const usage = this.ctx.db.get(
        'SELECT bytes_returned FROM mcp_usage WHERE execution_id = :id AND profile_id = :profile',
        { id: executionId, profile: profile.id },
      );
      const fits = bytes <= Math.max(0, profile.previewBytes - Number(usage?.bytes_returned ?? 0));
      this.ctx.db.run(
        `INSERT INTO mcp_diagnostics (execution_id, profile_id, item, disclosed, bytes)
         VALUES (:id, :profile, :item, :disclosed, :bytes)`,
        { ...key, disclosed: fits ? 1 : 0, bytes },
      );
      if (fits) {
        this.ctx.db.run(
          `INSERT INTO mcp_usage (execution_id, profile_id, rows_returned, bytes_returned) VALUES (:id, :profile, 0, :bytes)
           ON CONFLICT (execution_id, profile_id) DO UPDATE SET bytes_returned = bytes_returned + excluded.bytes_returned`,
          { id: executionId, profile: profile.id, bytes },
        );
      }
      this.ctx.audit.record({
        actor,
        action: 'mcp.error_message',
        target: { type: 'execution', id: executionId },
        outcome: fits ? 'succeeded' : 'denied',
        details: { item, bytes },
      });
      return fits;
    });
    return disclosed
      ? message
      : `The database's message is withheld (${bytes} bytes): it may quote data, and it is larger than what remains of this MCP profile's allowance for the execution. Read it in Database Workbench.`;
  }

  #expire(): void {
    this.ctx.db.run(
      "UPDATE disclosure_approvals SET status = 'expired' WHERE status = 'active' AND expires_at <= :now",
      {
        now: isoNow(this.ctx),
      },
    );
  }
}

export { decideSchema as disclosureDecideSchema };
