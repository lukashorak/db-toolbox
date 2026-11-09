import type { Database, Row } from './store/database.js';
import type { Actor, AuditEventView, AuditOutcome, Clock, Source } from './domain/types.js';
import { requirePermission } from './security/policy.js';

/** Keys whose values never enter audit details, at any depth. */
const SENSITIVE =
  /pass(word)?|secret|token|authori[sz]ation|cookie|private.?key|encryption.?key|^sql$|^params$|^rows$|^values$/i;
export const REDACTED_VALUE = '[redacted]';

export function redactDetails(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactDetails(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SENSITIVE.test(key) ? REDACTED_VALUE : redactDetails(inner, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export interface AuditRecord {
  actor: Actor | 'system';
  action: string;
  target?: { type: string; id?: string | null; label?: string | null };
  outcome: AuditOutcome;
  details?: Record<string, unknown>;
}

export interface AuditQuery {
  source?: Source | 'server';
  actionPrefix?: string;
  actorSubject?: string;
  from?: string;
  to?: string;
  /** Return events with an id lower than this (pagination, newest first). */
  before?: number;
  limit?: number;
}

const toView = (r: Row): AuditEventView => ({
  id: Number(r.id),
  at: String(r.at),
  actorSubject: (r.actor_subject as string | null) ?? null,
  actorLabel: String(r.actor_label),
  source: r.source as AuditEventView['source'],
  profileId: (r.profile_id as string | null) ?? null,
  action: String(r.action),
  targetType: (r.target_type as string | null) ?? null,
  targetId: (r.target_id as string | null) ?? null,
  targetLabel: (r.target_label as string | null) ?? null,
  outcome: r.outcome as AuditOutcome,
  details: JSON.parse(String(r.details)) as Record<string, unknown>,
});

/** Append-only record of sensitive actions. Details are redacted before they are stored. */
export class AuditLog {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  record(entry: AuditRecord): number {
    const actor = entry.actor === 'system' ? null : entry.actor;
    const { lastInsertRowid } = this.db.run(
      `INSERT INTO audit_events (at, actor_subject, actor_label, source, profile_id, action, target_type, target_id, target_label, outcome, details)
       VALUES (:at, :subject, :label, :source, :profile, :action, :ttype, :tid, :tlabel, :outcome, :details)`,
      {
        at: this.clock.now().toISOString(),
        subject: actor?.subject ?? null,
        label: actor ? actor.displayName || actor.username : 'System',
        source: actor ? actor.source : 'server',
        profile: actor?.profileId ?? null,
        action: entry.action,
        ttype: entry.target?.type ?? null,
        tid: entry.target?.id ?? null,
        tlabel: entry.target?.label ?? null,
        outcome: entry.outcome,
        details: JSON.stringify(redactDetails(entry.details ?? {})),
      },
    );
    return lastInsertRowid;
  }

  list(actor: Actor, query: AuditQuery = {}): AuditEventView[] {
    requirePermission(actor, 'audit.view');
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    const add = (clause: string, key: string, value: string | number | undefined) => {
      if (value === undefined || value === '') return;
      where.push(clause);
      params[key] = value;
    };
    add('source = :source', 'source', query.source);
    add('action LIKE :action', 'action', query.actionPrefix ? `${query.actionPrefix}%` : undefined);
    add('actor_subject = :subject', 'subject', query.actorSubject);
    add('at >= :from', 'from', query.from);
    add('at < :to', 'to', query.to);
    add('id < :before', 'before', query.before);
    params.limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const sql = `SELECT * FROM audit_events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT :limit`;
    return this.db.all(sql, params).map(toView);
  }
}
