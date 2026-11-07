import { DbError } from '../db/errors.js';
import type { DbAdapter } from '../db/types.js';
import type { Actor, Engine } from '../domain/types.js';
import { requirePermission } from '../security/policy.js';
import type { DatabaseService } from '../services/databases.js';

export type Availability = 'available' | 'limited' | 'unavailable';

/** A monitoring section: what could be seen, and why not everything when it is limited. */
export interface Section<T> {
  availability: Availability;
  reason: string | null;
  items: T[];
}

export interface SessionInfo {
  /** PostgreSQL pid or MySQL connection ID. */
  id: string;
  user: string | null;
  application: string | null;
  client: string | null;
  database: string | null;
  state: string | null;
  wait: string | null;
  durationMs: number | null;
  /** Null when the account may not see it. */
  query: string | null;
  queryVisible: boolean;
  blockedBy: string[];
  /** Set when the session runs an execution of this tool. */
  executionId: string | null;
}

export interface LockWait {
  waiting: string;
  blocking: string | null;
  lock: string | null;
  object: string | null;
  waitingQuery: string | null;
  blockingQuery: string | null;
  waitMs: number | null;
}

export interface Counters {
  /** Seconds since the previous sample; null for the first one or after a reset. */
  intervalSeconds: number | null;
  /** The server reset its counters since the previous sample; rates start again. */
  reset: boolean;
  resetAt: string | null;
  values: Record<string, number>;
  perSecond: Record<string, number | null>;
}

export interface StatementStat {
  id: string;
  text: string | null;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
}

export interface ActivitySnapshot {
  connectionId: string;
  engine: Engine;
  capturedAt: string;
  account: string;
  sessions: Section<SessionInfo>;
  lockWaits: Section<LockWait>;
  counters: { availability: Availability; reason: string | null; data: Counters | null };
}

export interface StatementsSnapshot {
  connectionId: string;
  engine: Engine;
  capturedAt: string;
  availability: Availability;
  reason: string | null;
  /** Statistics accumulate since this time. */
  statsSince: string | null;
  items: StatementStat[];
}

const TAG = /database-workbench (ex_[0-9A-Za-z]+)/;
const num = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const ids = (v: unknown): string[] => {
  const parsed: unknown = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(parsed) ? parsed.map(String) : [];
};

interface Sample {
  at: number;
  values: Record<string, number>;
  marker: string | null;
}

/** Turns two samples of monotonic counters into per-second rates, detecting resets. */
export function rates(previous: Sample | undefined, current: Sample, resetAt: string | null): Counters {
  const reset = Boolean(
    previous &&
    (previous.marker !== current.marker ||
      Object.entries(current.values).some(([k, v]) => v < (previous.values[k] ?? 0))),
  );
  const seconds = previous && !reset ? (current.at - previous.at) / 1000 : null;
  const perSecond: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(current.values)) {
    perSecond[k] =
      seconds && seconds > 0 && previous
        ? Math.round(((v - (previous.values[k] ?? 0)) / seconds) * 100) / 100
        : null;
  }
  return { intervalSeconds: seconds, reset, resetAt, values: current.values, perSecond };
}

const unavailable = <T>(reason: string): Section<T> => ({ availability: 'unavailable', reason, items: [] });
const denied = (error: unknown) =>
  error instanceof DbError &&
  (error.category === 'permission' || error.code === '1142' || error.code === '1227');

/**
 * Database-wide activity, read with fixed queries only. It never terminates sessions, installs
 * extensions or changes settings. Missing visibility is reported as limited or unavailable with a
 * reason, never as zero.
 */
export class MonitoringService {
  readonly #samples = new Map<string, Sample>();
  readonly #cache = new Map<string, { at: number; snapshot: ActivitySnapshot }>();

  constructor(
    private readonly databases: DatabaseService,
    /** Snapshots are reused for this long, so polling stays bounded. */
    private readonly minIntervalMs = 2000,
  ) {}

  async activity(actor: Actor, connectionId: string): Promise<ActivitySnapshot> {
    requirePermission(actor, 'monitor.view');
    const connection = this.databases.usable(actor, connectionId);
    const cached = this.#cache.get(connectionId);
    if (cached && Date.now() - cached.at < this.minIntervalMs) return cached.snapshot;
    const adapter = await this.databases.adapter(actor, connectionId, 'monitor');
    const snapshot =
      connection.engine === 'postgresql'
        ? await this.#postgres(connectionId, adapter)
        : await this.#mysql(connectionId, adapter);
    this.#cache.set(connectionId, { at: Date.now(), snapshot });
    return snapshot;
  }

  async statements(actor: Actor, connectionId: string, limit = 25): Promise<StatementsSnapshot> {
    requirePermission(actor, 'monitor.view');
    const connection = this.databases.usable(actor, connectionId);
    const adapter = await this.databases.adapter(actor, connectionId, 'monitor');
    const n = Math.min(Math.max(1, limit), 100);
    const base = { connectionId, engine: connection.engine, capturedAt: new Date().toISOString() };
    return connection.engine === 'postgresql'
      ? { ...base, ...(await this.#postgresStatements(adapter, n)) }
      : { ...base, ...(await this.#mysqlStatements(adapter, n)) };
  }

  // ---------------------------------------------------------------- PostgreSQL

  async #postgres(connectionId: string, adapter: DbAdapter): Promise<ActivitySnapshot> {
    const q = (sql: string, params?: unknown[]) => adapter.monitorQuery(sql, params);
    const [who] = await q(`SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
        OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS full_view`);
    const full = who?.full_view === 't' || who?.full_view === true;
    const rows = await q(`
      SELECT pid, usename, application_name, client_addr::text AS client, datname, state,
             CASE WHEN wait_event IS NULL THEN NULL ELSE wait_event_type || ':' || wait_event END AS wait,
             round(extract(epoch FROM (now() - coalesce(query_start, backend_start))) * 1000) AS duration_ms,
             query = '<insufficient privilege>' AS hidden,
             CASE WHEN query = '<insufficient privilege>' THEN NULL ELSE left(query, 2000) END AS query,
             array_to_json(pg_blocking_pids(pid))::text AS blocked_by
        FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         -- Without pg_read_all_stats, backend_type is hidden for other users; their sessions still have a user.
         AND (backend_type = 'client backend' OR (backend_type IS NULL AND usename IS NOT NULL))
       ORDER BY query_start NULLS LAST
       LIMIT 500`);
    const sessions: SessionInfo[] = rows.map((r) => {
      const hidden = r.hidden === 't' || r.hidden === true;
      return {
        id: String(r.pid),
        user: str(r.usename),
        application: str(r.application_name),
        client: str(r.client),
        database: str(r.datname),
        state: str(r.state),
        wait: str(r.wait),
        durationMs: r.duration_ms === null ? null : num(r.duration_ms),
        query: hidden ? null : str(r.query),
        queryVisible: !hidden,
        blockedBy: ids(r.blocked_by),
        executionId: TAG.exec(String(r.application_name ?? ''))?.[1] ?? null,
      };
    });
    const locks = await q(
      `SELECT pid, locktype || ' ' || mode AS lock, relation::regclass::text AS object FROM pg_locks WHERE NOT granted`,
    );
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const lockWaits: LockWait[] = sessions.flatMap((s) =>
      s.blockedBy.map((blocker) => {
        const lock = locks.find((l) => String(l.pid) === s.id);
        return {
          waiting: s.id,
          blocking: blocker,
          lock: str(lock?.lock),
          object: str(lock?.object),
          waitingQuery: s.query,
          blockingQuery: byId.get(blocker)?.query ?? null,
          waitMs: s.durationMs,
        };
      }),
    );
    const [db] = await q(`
      SELECT xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated,
             tup_deleted, deadlocks, temp_bytes, conflicts, stats_reset::text AS stats_reset
        FROM pg_stat_database WHERE datname = current_database()`);
    const { stats_reset: resetAt, ...counters } = db ?? {};
    const values = Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, num(v)]));
    const limited = full
      ? null
      : "The account sees other users' sessions but not their queries. Grant pg_read_all_stats (or pg_monitor).";
    return {
      connectionId,
      engine: 'postgresql',
      capturedAt: new Date().toISOString(),
      account: adapter.monitorAccount,
      sessions: { availability: full ? 'available' : 'limited', reason: limited, items: sessions },
      lockWaits: { availability: full ? 'available' : 'limited', reason: limited, items: lockWaits },
      counters: {
        availability: 'available',
        reason: null,
        data: this.#rates(connectionId, values, str(resetAt), str(resetAt)),
      },
    };
  }

  async #postgresStatements(
    adapter: DbAdapter,
    limit: number,
  ): Promise<Omit<StatementsSnapshot, 'connectionId' | 'engine' | 'capturedAt'>> {
    const q = (sql: string, params?: unknown[]) => adapter.monitorQuery(sql, params);
    const [ext] = await q("SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements'");
    if (!ext) {
      return {
        availability: 'unavailable',
        reason:
          'pg_stat_statements is not installed in this database. An administrator can add it (shared_preload_libraries and CREATE EXTENSION).',
        statsSince: null,
        items: [],
      };
    }
    try {
      const [who] = await q(`SELECT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
          OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS full_view`);
      const full = who?.full_view === 't' || who?.full_view === true;
      const rows = await q(
        `SELECT queryid::text AS id, CASE WHEN query = '<insufficient privilege>' THEN NULL ELSE left(query, 2000) END AS text,
                calls, total_exec_time, mean_exec_time, rows
           FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          ORDER BY total_exec_time DESC LIMIT $1`,
        [limit],
      );
      const info = await q('SELECT stats_reset::text AS since FROM pg_stat_statements_info').catch(() => []);
      return {
        availability: full ? 'available' : 'limited',
        reason: full
          ? null
          : 'Statements of other users are listed without their text. Grant pg_read_all_stats (or pg_monitor).',
        statsSince: str(info[0]?.since),
        items: rows.map((r) => ({
          id: String(r.id),
          text: str(r.text),
          calls: num(r.calls),
          totalMs: Math.round(num(r.total_exec_time) * 1000) / 1000,
          meanMs: Math.round(num(r.mean_exec_time) * 1000) / 1000,
          rows: num(r.rows),
        })),
      };
    } catch (error) {
      return { availability: 'unavailable', reason: (error as Error).message, statsSince: null, items: [] };
    }
  }

  // ---------------------------------------------------------------- MySQL

  async #mysqlPrivileges(adapter: DbAdapter): Promise<{ process: boolean; performanceSchema: boolean }> {
    const grants = (await adapter.monitorQuery('SHOW GRANTS'))
      .map((r) => String(Object.values(r)[0] ?? ''))
      .join('\n')
      .toUpperCase();
    const process = /ALL PRIVILEGES ON \*\.\*|\bPROCESS\b/.test(grants);
    let performanceSchema = true;
    try {
      await adapter.monitorQuery('SELECT 1 FROM performance_schema.threads LIMIT 1');
    } catch (error) {
      if (!denied(error)) throw error;
      performanceSchema = false;
    }
    return { process, performanceSchema };
  }

  async #mysql(connectionId: string, adapter: DbAdapter): Promise<ActivitySnapshot> {
    const q = (sql: string, params?: unknown[]) => adapter.monitorQuery(sql, params);
    const access = await this.#mysqlPrivileges(adapter);
    const toSession = (r: Record<string, unknown>): SessionInfo => {
      const query = str(r.query);
      return {
        id: String(r.id),
        user: str(r.user),
        application: str(r.program),
        client: str(r.host),
        database: str(r.db),
        state: [str(r.command), str(r.state)].filter(Boolean).join(': ') || null,
        wait: null,
        durationMs: r.time_s === null || r.time_s === undefined ? null : num(r.time_s) * 1000,
        query,
        queryVisible: true,
        blockedBy: [],
        executionId: TAG.exec(query ?? '')?.[1] ?? null,
      };
    };
    let sessions: Section<SessionInfo>;
    let lockWaits: Section<LockWait>;
    if (access.performanceSchema) {
      const rows = await q(`
        SELECT t.PROCESSLIST_ID AS id, t.PROCESSLIST_USER AS user, t.PROCESSLIST_HOST AS host, t.PROCESSLIST_DB AS db,
               t.PROCESSLIST_COMMAND AS command, t.PROCESSLIST_STATE AS state, t.PROCESSLIST_TIME AS time_s,
               LEFT(t.PROCESSLIST_INFO, 2000) AS query, a.ATTR_VALUE AS program
          FROM performance_schema.threads t
          LEFT JOIN performance_schema.session_connect_attrs a
            ON a.PROCESSLIST_ID = t.PROCESSLIST_ID AND a.ATTR_NAME = 'program_name'
         WHERE t.TYPE = 'FOREGROUND' AND t.PROCESSLIST_ID IS NOT NULL AND t.PROCESSLIST_ID <> CONNECTION_ID()
         ORDER BY t.PROCESSLIST_TIME DESC LIMIT 500`);
      const items = rows.map(toSession);
      const waits = await q(`
        SELECT rt.PROCESSLIST_ID AS waiting, bt.PROCESSLIST_ID AS blocking,
               CONCAT(rl.LOCK_TYPE, ' ', rl.LOCK_MODE) AS lock_name,
               CONCAT_WS('.', rl.OBJECT_SCHEMA, rl.OBJECT_NAME) AS object,
               LEFT(rt.PROCESSLIST_INFO, 2000) AS waiting_query, LEFT(bt.PROCESSLIST_INFO, 2000) AS blocking_query,
               rt.PROCESSLIST_TIME AS wait_s
          FROM performance_schema.data_lock_waits w
          JOIN performance_schema.data_locks rl ON rl.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID
          JOIN performance_schema.threads rt ON rt.THREAD_ID = w.REQUESTING_THREAD_ID
          JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID
        UNION ALL
        SELECT pt.PROCESSLIST_ID, gt.PROCESSLIST_ID, CONCAT('metadata ', p.LOCK_TYPE), CONCAT_WS('.', p.OBJECT_SCHEMA, p.OBJECT_NAME),
               LEFT(pt.PROCESSLIST_INFO, 2000), LEFT(gt.PROCESSLIST_INFO, 2000), pt.PROCESSLIST_TIME
          FROM performance_schema.metadata_locks p
          JOIN performance_schema.threads pt ON pt.THREAD_ID = p.OWNER_THREAD_ID
          LEFT JOIN performance_schema.metadata_locks g
            ON g.LOCK_STATUS = 'GRANTED' AND g.OBJECT_TYPE = p.OBJECT_TYPE AND g.OBJECT_SCHEMA <=> p.OBJECT_SCHEMA
           AND g.OBJECT_NAME <=> p.OBJECT_NAME AND g.OWNER_THREAD_ID <> p.OWNER_THREAD_ID
          LEFT JOIN performance_schema.threads gt ON gt.THREAD_ID = g.OWNER_THREAD_ID
         WHERE p.LOCK_STATUS = 'PENDING'`);
      const lockItems: LockWait[] = waits.map((w) => ({
        waiting: String(w.waiting),
        blocking: str(w.blocking),
        lock: str(w.lock_name),
        object: str(w.object),
        waitingQuery: str(w.waiting_query),
        blockingQuery: str(w.blocking_query),
        waitMs: w.wait_s === null ? null : num(w.wait_s) * 1000,
      }));
      for (const w of lockItems) {
        const s = items.find((x) => x.id === w.waiting);
        if (s && w.blocking && !s.blockedBy.includes(w.blocking)) s.blockedBy.push(w.blocking);
      }
      const limited = access.process
        ? null
        : "Without the PROCESS privilege, other users' sessions are not shown.";
      sessions = { availability: access.process ? 'available' : 'limited', reason: limited, items };
      lockWaits = {
        availability: access.process ? 'available' : 'limited',
        reason: limited,
        items: lockItems,
      };
    } else {
      const rows =
        await q(`SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, STATE AS state,
                                   TIME AS time_s, LEFT(INFO, 2000) AS query
                              FROM information_schema.PROCESSLIST WHERE ID <> CONNECTION_ID() ORDER BY TIME DESC LIMIT 500`);
      sessions = {
        availability: 'limited',
        reason: access.process
          ? 'performance_schema is not readable by this account; sessions come from the process list.'
          : 'performance_schema is not readable and the account lacks PROCESS, so only its own sessions are shown.',
        items: rows.map(toSession),
      };
      lockWaits = unavailable('Lock waits need SELECT on performance_schema.');
    }
    const status = await q(
      `SHOW GLOBAL STATUS WHERE Variable_name IN ('Questions', 'Com_select', 'Com_insert', 'Com_update', 'Com_delete',
         'Com_commit', 'Com_rollback', 'Innodb_rows_read', 'Innodb_rows_inserted', 'Innodb_rows_updated',
         'Innodb_rows_deleted', 'Slow_queries', 'Innodb_row_lock_waits', 'Created_tmp_disk_tables', 'Uptime')`,
    );
    // Uptime stays in the sample: it goes down after a restart, which marks the counters as reset.
    const values = Object.fromEntries(
      status.map((r) => [String(r.Variable_name).toLowerCase(), num(r.Value)]),
    );
    const startedAt = new Date(Date.now() - (values.uptime ?? 0) * 1000).toISOString();
    return {
      connectionId,
      engine: 'mysql',
      capturedAt: new Date().toISOString(),
      account: adapter.monitorAccount,
      sessions,
      lockWaits,
      counters: {
        availability: 'available',
        reason: null,
        data: this.#rates(connectionId, values, null, startedAt),
      },
    };
  }

  async #mysqlStatements(
    adapter: DbAdapter,
    limit: number,
  ): Promise<Omit<StatementsSnapshot, 'connectionId' | 'engine' | 'capturedAt'>> {
    const [enabled] = await adapter.monitorQuery('SELECT @@performance_schema AS on_');
    if (Number(enabled?.on_) !== 1) {
      return {
        availability: 'unavailable',
        reason: 'performance_schema is disabled on the server.',
        statsSince: null,
        items: [],
      };
    }
    try {
      const rows = await adapter.monitorQuery(
        `SELECT DIGEST AS id, LEFT(DIGEST_TEXT, 2000) AS text, COUNT_STAR AS calls, SUM_TIMER_WAIT / 1e9 AS total_ms,
                AVG_TIMER_WAIT / 1e9 AS mean_ms, SUM_ROWS_SENT AS rows_sent, FIRST_SEEN AS first_seen
           FROM performance_schema.events_statements_summary_by_digest
          WHERE SCHEMA_NAME = DATABASE() AND DIGEST IS NOT NULL
          ORDER BY SUM_TIMER_WAIT DESC LIMIT ?`,
        [limit],
      );
      const since = rows.reduce<string | null>((min, r) => {
        const seen = str(r.first_seen);
        return seen && (!min || seen < min) ? seen : min;
      }, null);
      return {
        availability: 'available',
        reason: null,
        statsSince: since,
        items: rows.map((r) => ({
          id: String(r.id),
          text: str(r.text),
          calls: num(r.calls),
          totalMs: Math.round(num(r.total_ms) * 1000) / 1000,
          meanMs: Math.round(num(r.mean_ms) * 1000) / 1000,
          rows: num(r.rows_sent),
        })),
      };
    } catch (error) {
      if (denied(error)) {
        return {
          availability: 'unavailable',
          reason: 'Statement statistics need SELECT on performance_schema.',
          statsSince: null,
          items: [],
        };
      }
      throw error;
    }
  }

  #rates(
    connectionId: string,
    values: Record<string, number>,
    marker: string | null,
    resetAt: string | null,
  ): Counters {
    const sample: Sample = { at: Date.now(), values, marker };
    const result = rates(this.#samples.get(connectionId), sample, resetAt);
    this.#samples.set(connectionId, sample);
    return result;
  }
}

export { TAG as EXECUTION_TAG };
