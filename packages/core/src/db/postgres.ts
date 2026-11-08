import pg from 'pg';
import Cursor from 'pg-cursor';
import { DbError, mapPostgresError } from './errors.js';
import { PostgresMetadata } from './metadata-postgres.js';
import { postgresTls } from './tls.js';
import type { TableRef } from '../sql/types.js';
import type {
  Cell,
  ColumnInfo,
  ConnectionTarget,
  DbAdapter,
  DbSession,
  Endpoint,
  ExecuteOptions,
  PoolSizes,
  ResultSink,
  StatementOutcome,
} from './types.js';

/** Keep every value in PostgreSQL's text form: lossless for numeric, int8, dates, arrays and JSON. */
const TEXT_TYPES = { getTypeParser: () => (value: string) => value };

const BUILTIN_TYPES = new Map<number, string>([
  [16, 'bool'],
  [17, 'bytea'],
  [18, 'char'],
  [19, 'name'],
  [20, 'int8'],
  [21, 'int2'],
  [23, 'int4'],
  [25, 'text'],
  [26, 'oid'],
  [114, 'json'],
  [142, 'xml'],
  [700, 'float4'],
  [701, 'float8'],
  [790, 'money'],
  [869, 'inet'],
  [1042, 'bpchar'],
  [1043, 'varchar'],
  [1082, 'date'],
  [1083, 'time'],
  [1114, 'timestamp'],
  [1184, 'timestamptz'],
  [1186, 'interval'],
  [1266, 'timetz'],
  [1700, 'numeric'],
  [2950, 'uuid'],
  [3802, 'jsonb'],
  [1000, '_bool'],
  [1005, '_int2'],
  [1007, '_int4'],
  [1016, '_int8'],
  [1009, '_text'],
  [1015, '_varchar'],
  [1231, '_numeric'],
  [2951, '_uuid'],
  [3807, '_jsonb'],
]);

/** Quotes a schema for the `-c search_path=` startup option. */
function searchPathOption(schema: string): string {
  const ident = `"${schema.replace(/"/g, '""')}"`;
  return `-c search_path=${ident.replace(/\\/g, '\\\\').replace(/ /g, '\\ ')}`;
}

export interface PostgresOptions {
  sizes: PoolSizes;
  connectTimeoutMs: number;
  applicationName: string;
}

export function postgresClientConfig(
  target: ConnectionTarget,
  endpoint: Endpoint,
  connectTimeoutMs: number,
  applicationName: string,
) {
  return {
    host: endpoint.host,
    port: endpoint.port,
    database: target.database,
    user: target.username,
    password: target.password,
    ssl: postgresTls({ mode: target.tlsMode, caPem: target.caPem }, endpoint),
    application_name: applicationName,
    connectionTimeoutMillis: connectTimeoutMs,
    types: TEXT_TYPES,
    ...(target.schema ? { options: searchPathOption(target.schema) } : {}),
  };
}

export class PostgresAdapter implements DbAdapter {
  readonly engine = 'postgresql' as const;
  readonly metadata: PostgresMetadata;
  readonly #work: pg.Pool;
  readonly #meta: pg.Pool;
  readonly #control: pg.Pool;
  readonly #monitor: pg.Pool;
  readonly monitorAccount: string;
  readonly #typeNames = new Map(BUILTIN_TYPES);
  #active = 0;

  constructor(target: ConnectionTarget, endpoint: Endpoint, options: PostgresOptions) {
    const base = postgresClientConfig(target, endpoint, options.connectTimeoutMs, options.applicationName);
    const pool = (max: number, name: string, account?: { username: string; password: string } | null) => {
      const p = new pg.Pool({
        ...base,
        ...(account ? { user: account.username, password: account.password } : {}),
        application_name: `${options.applicationName} (${name})`,
        max,
        idleTimeoutMillis: 30_000,
      });
      // Errors on idle clients (server restart, network) must not crash the process.
      p.on('error', () => undefined);
      return p;
    };
    this.#work = pool(options.sizes.work, 'work');
    this.#meta = pool(options.sizes.metadata, 'metadata');
    this.#control = pool(options.sizes.control, 'control');
    this.#monitor = pool(options.sizes.monitor ?? 1, 'monitor', target.monitor);
    this.monitorAccount = target.monitor?.username ?? target.username;
    this.metadata = new PostgresMetadata((sql, params) => this.#metaQuery(sql, params), target.schema);
  }

  async #metaQuery(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    try {
      return (await this.#meta.query({ text: sql, values: params })).rows as Record<string, unknown>[];
    } catch (error) {
      throw mapPostgresError(error);
    }
  }

  /** Resolves type names for OIDs that are not built in (domains, enums, extension types). */
  async typeNames(oids: number[]): Promise<Map<number, string>> {
    const missing = [...new Set(oids)].filter((oid) => !this.#typeNames.has(oid));
    if (missing.length) {
      try {
        const rows = await this.#metaQuery(
          'SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1::oid[])',
          [missing],
        );
        for (const row of rows) this.#typeNames.set(Number(row.oid), String(row.name));
      } catch {
        // Names are cosmetic; fall back to the OID.
      }
    }
    return this.#typeNames;
  }

  async withSession<T>(fn: (session: DbSession) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.#work.connect();
    } catch (error) {
      throw mapPostgresError(error);
    }
    this.#active++;
    const session = new PostgresSession(client, this);
    try {
      return await fn(session);
    } finally {
      await session.finish();
      this.#active--;
      client.release(session.dirty ? true : undefined);
    }
  }

  async cancel(backendId: number): Promise<boolean> {
    try {
      const { rows } = await this.#control.query('SELECT pg_cancel_backend($1) AS ok', [backendId]);
      return rows[0]?.ok === 't' || rows[0]?.ok === true;
    } catch {
      return false;
    }
  }

  async tableEngine(): Promise<string | null> {
    return null;
  }
  async functionEngine(): Promise<string | null> {
    return null;
  }

  async viewEngine(): Promise<string | null> {
    return null;
  }

  async monitorQuery(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    try {
      return (await this.#monitor.query({ text: sql, values: params })).rows as Record<string, unknown>[];
    } catch (error) {
      throw mapPostgresError(error);
    }
  }

  activeSessions(): number {
    return this.#active;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#work.end(), this.#meta.end(), this.#control.end(), this.#monitor.end()]);
  }
}

/** True if the promise settles (either way) within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return settled;
}

/** Command tags of statements that change rows; with RETURNING, each returned row is a changed row. */
const CHANGES_ROWS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

class PostgresSession implements DbSession {
  readonly backendId: number;
  dirty: string | null = null;
  #inTransaction = false;
  /**
   * A cursor could not be closed, so the connection still has a query in progress and anything
   * sent now would wait behind it. Nothing more is sent; the connection is closed on release, which
   * also rolls back an open transaction on the server.
   */
  #stuck = false;
  readonly #onError = (error: Error) => this.markDirty(`connection error: ${error.message}`);

  constructor(
    private readonly client: pg.PoolClient,
    private readonly adapter: PostgresAdapter,
  ) {
    this.backendId = (client as unknown as { processID: number }).processID;
    client.on('error', this.#onError);
  }

  markDirty(reason: string): void {
    this.dirty ??= reason;
  }

  /**
   * Looked up on this session, so its search path decides which schemas an unqualified name can
   * reach, including a path that puts a user schema before pg_catalog. For a called name every
   * overload counts (which one a call picks is not resolved here); for a named view, the functions
   * its definition depends on, through every view beneath it (UNION stops at views already seen). Catalog names are qualified so
   * nothing on the path can stand in for them. An abort cancels the lookup on the server.
   */
  async mayWriteThrough(
    refs: { functions: TableRef[]; relations: TableRef[] },
    _database: string | null,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!refs.functions.length && !refs.relations.length) return false;
    if (this.#stuck)
      throw new DbError('connectivity', 'The connection was left unusable by an earlier error.');
    signal?.throwIfAborted();
    const bare = (list: TableRef[]) => list.filter((r) => r.schema === null).map((r) => r.name);
    const qualified = (list: TableRef[]) => list.filter((r) => r.schema !== null);
    const onAbort = () => void this.adapter.cancel(this.backendId);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.client.query({
        text: `WITH RECURSIVE views (oid) AS (
                 SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
                  WHERE c.relkind = 'v'
                    AND ((c.relname = ANY ($4::text[]) AND s.nspname = ANY (pg_catalog.current_schemas(true)))
                      OR (s.nspname, c.relname) IN (SELECT q.s, q.r FROM ROWS FROM (pg_catalog.unnest($5::text[]), pg_catalog.unnest($6::text[])) AS q (s, r)))
                 UNION
                 SELECT d.refobjid FROM views
                   JOIN pg_catalog.pg_rewrite w ON w.ev_class = views.oid
                   JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
                    AND d.objid = w.oid AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
                   JOIN pg_catalog.pg_class c ON c.oid = d.refobjid AND c.relkind = 'v'
               ), procs AS (
                 SELECT p.oid FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
                  WHERE (p.proname = ANY ($1::text[]) AND s.nspname = ANY (pg_catalog.current_schemas(true)))
                     OR (s.nspname, p.proname) IN (SELECT q.s, q.f FROM ROWS FROM (pg_catalog.unnest($2::text[]), pg_catalog.unnest($3::text[])) AS q (s, f))
                 UNION
                 SELECT d.refobjid FROM views
                   JOIN pg_catalog.pg_rewrite w ON w.ev_class = views.oid
                   JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
                    AND d.objid = w.oid AND d.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
               )
               SELECT pg_catalog.count(*) AS n FROM procs JOIN pg_catalog.pg_proc p ON p.oid = procs.oid
                 JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
                WHERE p.prokind IN ('f', 'w') AND p.provolatile = 'v'
                  AND s.nspname NOT IN ('pg_catalog', 'information_schema')`,
        values: [
          bare(refs.functions),
          qualified(refs.functions).map((r) => r.schema),
          qualified(refs.functions).map((r) => r.name),
          bare(refs.relations),
          qualified(refs.relations).map((r) => r.schema),
          qualified(refs.relations).map((r) => r.name),
        ],
      });
      return Number((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0) > 0;
    } catch (error) {
      throw mapPostgresError(error);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async #run(sql: string): Promise<void> {
    if (this.#stuck) {
      throw new DbError('connectivity', 'The connection was left unusable by an earlier error.');
    }
    try {
      await this.client.query(sql);
    } catch (error) {
      throw mapPostgresError(error);
    }
  }

  async tag(executionId: string): Promise<void> {
    const label = `database-workbench ${executionId}`.replace(/[^\w .:-]/g, '');
    await this.#run(`SET application_name = '${label}'`);
  }

  async begin(options: { readOnly: boolean }): Promise<void> {
    await this.#run(options.readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
    this.#inTransaction = true;
  }

  async commit(): Promise<void> {
    this.#inTransaction = false;
    await this.#run('COMMIT');
  }

  async rollback(): Promise<void> {
    this.#inTransaction = false;
    // Closing the connection (on release) rolls the transaction back on the server.
    if (this.#stuck) return;
    await this.#run('ROLLBACK');
  }

  /**
   * Closes a cursor that an error left open (its portal still holds the connection), within 2 s.
   * A cursor that finished or failed on its own needs nothing.
   */
  async #closeCursor(cursor: Cursor<Cell[]>): Promise<void> {
    const state = (cursor as unknown as { state?: string }).state;
    if (state === 'done' || state === 'error') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      cursor.close().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000);
      }),
    ]);
    clearTimeout(timer);
    if (!closed) {
      this.#stuck = true;
      this.markDirty('a cursor could not be closed');
    }
  }

  async execute(sql: string, sink: ResultSink, options: ExecuteOptions): Promise<StatementOutcome> {
    const timeout = Math.max(1, Math.floor(options.timeoutMs));
    if (this.#inTransaction) await this.#run(`SET LOCAL statement_timeout = ${timeout}`);
    else await this.#run(`SET statement_timeout = ${timeout}`);

    const notices: string[] = [];
    const onNotice = (notice: { message?: string; severity?: string }) => {
      if (notices.length < 50) notices.push(`${notice.severity ?? 'NOTICE'}: ${notice.message ?? ''}`);
    };
    this.client.on('notice', onNotice);

    let interrupted: 'timeout' | 'cancelled' | null = null;
    /** The cancel request: it must settle before this backend runs anything else. */
    let cancelling: Promise<unknown> | null = null;
    const interrupt = (why: 'timeout' | 'cancelled') => {
      if (interrupted) return;
      interrupted = why;
      cancelling = this.adapter.cancel(this.backendId);
    };
    // statement_timeout ends the statement on the server; this backstop covers a server that does not answer.
    const timer = setTimeout(() => interrupt('timeout'), timeout + 2000);
    const onAbort = () => interrupt('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const batchSize = options.batchSize ?? 500;
    const cursor = this.client.query(
      new Cursor<Cell[]>(sql, undefined, { rowMode: 'array', types: TEXT_TYPES }),
    );
    const outcome: StatementOutcome = {
      command: null,
      affectedRows: null,
      resultSets: 0,
      rowsDelivered: 0,
      stopped: false,
      notices,
    };
    let discarding = false;
    let rowsRead = 0;
    try {
      if (options.signal?.aborted) interrupt('cancelled');
      for (;;) {
        // Between batches the server has no running query, so pg_cancel_backend (and
        // statement_timeout, which counts per fetch) cannot stop a long read: stop reading here.
        if (interrupted) {
          await cursor.close().catch(() => undefined);
          throw new DbError(
            interrupted,
            interrupted === 'timeout'
              ? `The statement exceeded its time limit of ${timeout} ms.`
              : 'The statement was cancelled.',
          );
        }
        const { rows, result } = await new Promise<{ rows: Cell[][]; result?: pg.QueryResult }>(
          (resolve, reject) =>
            cursor.read(batchSize, (error, rows, result) =>
              error ? reject(error) : resolve({ rows: rows as Cell[][], result }),
            ),
        );
        // pg-cursor omits the result on a read after the portal has closed (exact multiple of the batch size).
        if (!result) break;
        rowsRead += rows.length;
        if (result.command) {
          // The command tag of a fetch counts only the rows of that fetch. A write with RETURNING
          // returns one row per changed row, so the rows read are its count.
          outcome.command = result.command;
          outcome.affectedRows = !result.fields.length
            ? (result.rowCount ?? null)
            : CHANGES_ROWS.has(result.command)
              ? rowsRead
              : null;
        }
        if (outcome.resultSets === 0 && result.fields.length) {
          const names = await this.adapter.typeNames(result.fields.map((f) => f.dataTypeID));
          const columns: ColumnInfo[] = result.fields.map((f) => ({
            name: f.name,
            type: names.get(f.dataTypeID) ?? String(f.dataTypeID),
            binary: f.dataTypeID === 17,
          }));
          outcome.resultSets = 1;
          await sink.start(columns, 0);
        }
        if (rows.length && !discarding) {
          outcome.rowsDelivered += rows.length;
          if ((await sink.rows(rows, 0)) === 'stop') {
            outcome.stopped = true;
            // A statement that changes data runs to its end; only its further rows are dropped.
            if (options.onStop === 'drain') discarding = true;
            else {
              await cursor.close();
              break;
            }
          }
        }
        if (rows.length < batchSize) break;
      }
      return outcome;
    } catch (error) {
      // An error outside the cursor (storing the rows, looking up types) leaves its portal open,
      // and every later query on this connection would wait behind it.
      await this.#closeCursor(cursor);
      const mapped = mapPostgresError(error);
      if (interrupted === 'cancelled' && mapped.category !== 'connectivity') {
        throw new DbError('cancelled', 'The statement was cancelled.', {
          sqlState: mapped.sqlState,
          code: mapped.code,
        });
      }
      if (interrupted === 'timeout' || mapped.category === 'timeout') {
        throw new DbError('timeout', `The statement exceeded its time limit of ${timeout} ms.`, {
          sqlState: mapped.sqlState,
          code: mapped.code,
        });
      }
      if (mapped.category === 'connectivity') this.markDirty('connection lost');
      throw mapped;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      this.client.removeListener('notice', onNotice);
      if (interrupted && !this.#inTransaction) this.markDirty(`statement ${interrupted}`);
      // A cancel request still on its way could stop the next statement on this backend. Wait for
      // it (pg_cancel_backend has no effect on an idle backend); if it does not settle, discard it.
      if (cancelling && !(await settlesWithin(cancelling, 5000))) {
        this.markDirty('a cancel request did not settle');
      }
    }
  }

  /** Leaves the connection as it was found, or marks it to be closed. */
  async finish(): Promise<void> {
    try {
      if (this.#stuck) return;
      if (this.#inTransaction) {
        this.#inTransaction = false;
        await this.client.query('ROLLBACK');
      }
      // Whatever the run left on the connection is cleared before another execution, perhaps
      // another user's, gets it: settings (set_config, statement_timeout, application_name),
      // temporary tables, advisory locks, prepared statements, LISTEN, also when a function set
      // them, which the statement analysis cannot see.
      if (!this.dirty) await this.client.query('DISCARD ALL');
    } catch {
      this.markDirty('could not restore the session');
    } finally {
      this.client.removeListener('error', this.#onError);
    }
  }
}
