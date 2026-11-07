import pg from 'pg';
import Cursor from 'pg-cursor';
import { DbError, mapPostgresError } from './errors.js';
import { PostgresMetadata } from './metadata-postgres.js';
import { postgresTls } from './tls.js';
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
  readonly #typeNames = new Map(BUILTIN_TYPES);
  #active = 0;

  constructor(target: ConnectionTarget, endpoint: Endpoint, options: PostgresOptions) {
    const base = postgresClientConfig(target, endpoint, options.connectTimeoutMs, options.applicationName);
    const pool = (max: number, name: string) => {
      const p = new pg.Pool({
        ...base,
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

  activeSessions(): number {
    return this.#active;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#work.end(), this.#meta.end(), this.#control.end()]);
  }
}

class PostgresSession implements DbSession {
  readonly backendId: number;
  dirty: string | null = null;
  #inTransaction = false;
  #sessionTimeoutSet = false;
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

  async #run(sql: string): Promise<void> {
    try {
      await this.client.query(sql);
    } catch (error) {
      throw mapPostgresError(error);
    }
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
    await this.#run('ROLLBACK');
  }

  async execute(sql: string, sink: ResultSink, options: ExecuteOptions): Promise<StatementOutcome> {
    const timeout = Math.max(1, Math.floor(options.timeoutMs));
    if (this.#inTransaction) await this.#run(`SET LOCAL statement_timeout = ${timeout}`);
    else {
      await this.#run(`SET statement_timeout = ${timeout}`);
      this.#sessionTimeoutSet = true;
    }

    const notices: string[] = [];
    const onNotice = (notice: { message?: string; severity?: string }) => {
      if (notices.length < 50) notices.push(`${notice.severity ?? 'NOTICE'}: ${notice.message ?? ''}`);
    };
    this.client.on('notice', onNotice);

    let interrupted: 'timeout' | 'cancelled' | null = null;
    const interrupt = (why: 'timeout' | 'cancelled') => {
      if (interrupted) return;
      interrupted = why;
      void this.adapter.cancel(this.backendId);
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
    try {
      if (options.signal?.aborted) interrupt('cancelled');
      for (;;) {
        const { rows, result } = await new Promise<{ rows: Cell[][]; result?: pg.QueryResult }>(
          (resolve, reject) =>
            cursor.read(batchSize, (error, rows, result) =>
              error ? reject(error) : resolve({ rows: rows as Cell[][], result }),
            ),
        );
        // pg-cursor omits the result on a read after the portal has closed (exact multiple of the batch size).
        if (!result) break;
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
        if (rows.length) {
          outcome.rowsDelivered += rows.length;
          if ((await sink.rows(rows, 0)) === 'stop') {
            outcome.stopped = true;
            await cursor.close();
            break;
          }
        }
        if (rows.length < batchSize) {
          outcome.command = result.command ?? null;
          outcome.affectedRows =
            result.fields.length && result.command === 'SELECT' ? null : (result.rowCount ?? null);
          break;
        }
      }
      return outcome;
    } catch (error) {
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
    }
  }

  /** Leaves the connection as it was found, or marks it to be closed. */
  async finish(): Promise<void> {
    try {
      if (this.#inTransaction) {
        this.#inTransaction = false;
        await this.client.query('ROLLBACK');
      }
      if (this.#sessionTimeoutSet && !this.dirty) await this.client.query('RESET statement_timeout');
    } catch {
      this.markDirty('could not restore the session');
    } finally {
      this.client.removeListener('error', this.#onError);
    }
  }
}
