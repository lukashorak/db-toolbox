import mysql, { type FieldPacket, type Pool, type PoolConnection, type PoolOptions } from 'mysql2';
import type { TableRef } from '../sql/types.js';
import { DbError, mapMysqlError } from './errors.js';
import { MysqlMetadata } from './metadata-mysql.js';
import { mysqlTls, mysqlVerifyFullProblem } from './tls.js';
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

const BINARY_CHARSET = 63;
const TYPE_NAMES = new Map<number, string>(
  Object.entries(mysql.Types).map(([name, id]) => [Number(id), name]),
);
const STRING_TYPES = new Set([
  'STRING',
  'VAR_STRING',
  'VARCHAR',
  'BLOB',
  'TINY_BLOB',
  'MEDIUM_BLOB',
  'LONG_BLOB',
]);

type RawField = FieldPacket & { columnType?: number; characterSet?: number };

function columnInfo(field: RawField): ColumnInfo {
  const type = TYPE_NAMES.get(Number(field.columnType ?? field.type)) ?? 'UNKNOWN';
  const binary =
    type === 'GEOMETRY' ||
    type === 'BIT' ||
    (STRING_TYPES.has(type) && field.characterSet === BINARY_CHARSET);
  return { name: field.name, type, binary };
}

/** Raw bytes for every value; turned into text (or `\x` hex for binary columns) per column. */
const RAW = (field: { buffer(): Buffer | null }) => field.buffer();
const toCell = (value: unknown, binary: boolean): Cell => {
  if (value === null || value === undefined) return null;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return binary ? `\\x${bytes.toString('hex')}` : bytes.toString('utf8');
};

export interface MysqlOptions {
  sizes: PoolSizes;
  connectTimeoutMs: number;
}

export function mysqlConnectionOptions(
  target: ConnectionTarget,
  endpoint: Endpoint,
  connectTimeoutMs: number,
): PoolOptions {
  const ssl = mysqlTls({ mode: target.tlsMode, caPem: target.caPem });
  return {
    host: endpoint.host,
    port: endpoint.port,
    user: target.username,
    password: target.password,
    database: target.database,
    ...(ssl ? { ssl } : {}),
    connectTimeout: connectTimeoutMs,
    charset: 'utf8mb4',
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  };
}

export class MysqlAdapter implements DbAdapter {
  readonly engine = 'mysql' as const;
  readonly metadata: MysqlMetadata;
  readonly #work: Pool;
  readonly #meta: Pool;
  readonly #control: Pool;
  readonly #monitor: Pool;
  readonly monitorAccount: string;
  readonly #refusal: DbError | null;
  #active = 0;

  constructor(target: ConnectionTarget, endpoint: Endpoint, options: MysqlOptions) {
    this.#refusal = mysqlVerifyFullProblem(target.tlsMode, endpoint.host);
    const base = mysqlConnectionOptions(target, endpoint, options.connectTimeoutMs);
    const pool = (connectionLimit: number, account?: { username: string; password: string } | null) => {
      const p = mysql.createPool({
        ...base,
        ...(account ? { user: account.username, password: account.password } : {}),
        connectionLimit,
        maxIdle: connectionLimit,
        idleTimeout: 30_000,
        waitForConnections: true,
        queueLimit: 0,
      });
      p.on('connection', (c) => c.on('error', () => undefined));
      return p;
    };
    this.#work = pool(options.sizes.work);
    this.#meta = pool(options.sizes.metadata);
    this.#control = pool(options.sizes.control);
    this.#monitor = pool(options.sizes.monitor ?? 1, target.monitor);
    this.monitorAccount = target.monitor?.username ?? target.username;
    this.metadata = new MysqlMetadata((sql, params) => this.#metaQuery(sql, params), target.database);
  }

  async #acquire(pool: Pool): Promise<PoolConnection> {
    if (this.#refusal) throw this.#refusal;
    return new Promise<PoolConnection>((resolve, reject) =>
      pool.getConnection((error, c) => (error ? reject(mapMysqlError(error)) : resolve(c))),
    );
  }

  async #pooledQuery(pool: Pool, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const connection = await this.#acquire(pool);
    try {
      return await new Promise((resolve, reject) =>
        connection.query({ sql, values: params }, (error, rows) =>
          error
            ? reject(mapMysqlError(error))
            : resolve((Array.isArray(rows) ? rows : []) as Record<string, unknown>[]),
        ),
      );
    } finally {
      connection.release();
    }
  }

  #metaQuery(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return this.#pooledQuery(this.#meta, sql, params);
  }

  async withSession<T>(fn: (session: DbSession) => Promise<T>): Promise<T> {
    const connection = await this.#acquire(this.#work);
    this.#active++;
    const session = new MysqlSession(connection, this);
    try {
      return await fn(session);
    } finally {
      await session.finish();
      this.#active--;
      if (session.dirty) connection.destroy();
      else connection.release();
    }
  }

  /** KILL QUERY over the control pool; resolves once the server has accepted it. */
  async cancel(backendId: number): Promise<boolean> {
    try {
      await this.#pooledQuery(this.#control, 'KILL QUERY ?', [backendId]);
      return true;
    } catch {
      return false;
    }
  }

  async tableEngine(table: TableRef): Promise<string | null> {
    const [row] = await this.#metaQuery(
      'SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?',
      [table.schema, table.name],
    );
    return row?.engine ? String(row.engine) : null;
  }

  activeSessions(): number {
    return this.#active;
  }

  monitorQuery(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return this.#pooledQuery(this.#monitor, sql, params);
  }

  async close(): Promise<void> {
    const end = (p: Pool) => new Promise<void>((resolve) => p.end(() => resolve()));
    await Promise.allSettled([end(this.#work), end(this.#meta), end(this.#control), end(this.#monitor)]);
  }
}

class MysqlSession implements DbSession {
  readonly backendId: number;
  dirty: string | null = null;
  #inTransaction = false;
  /** Leading comment that shows the execution ID in the process list (digests ignore comments). */
  #label = '';
  readonly #onError = (error: Error) => this.markDirty(`connection error: ${error.message}`);

  constructor(
    private readonly connection: PoolConnection,
    private readonly adapter: MysqlAdapter,
  ) {
    this.backendId = connection.threadId ?? 0;
    connection.on('error', this.#onError);
  }

  markDirty(reason: string): void {
    this.dirty ??= reason;
  }

  #run(sql: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) =>
      this.connection.query({ sql }, (error, rows) =>
        error
          ? reject(mapMysqlError(error))
          : resolve((Array.isArray(rows) ? rows : []) as Record<string, unknown>[]),
      ),
    );
  }

  async tag(executionId: string): Promise<void> {
    this.#label = `/* database-workbench ${executionId.replace(/[^\w-]/g, '')} */ `;
  }

  async begin(options: { readOnly: boolean }): Promise<void> {
    await this.#run(options.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION READ WRITE');
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
    const batchSize = options.batchSize ?? 500;
    const outcome: StatementOutcome = {
      command: null,
      affectedRows: null,
      resultSets: 0,
      rowsDelivered: 0,
      stopped: false,
      notices: [],
    };
    let interrupted: 'timeout' | 'cancelled' | 'stopped' | null = null;
    let killed: Promise<boolean> | null = null;
    const interrupt = (why: 'timeout' | 'cancelled' | 'stopped') => {
      if (interrupted) return;
      interrupted = why;
      killed = this.adapter.cancel(this.backendId);
    };
    const timer = setTimeout(() => interrupt('timeout'), timeout);
    const onAbort = () => interrupt('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) interrupt('cancelled');

    let warnings = 0;
    let lost: ((error?: unknown) => void) | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        let columns: ColumnInfo[] = [];
        let batch: Cell[][] = [];
        let index = -1;
        let pending: Promise<void> = Promise.resolve();
        let failed: unknown = null;
        // `pause`: hold the socket while the sink catches up. Not after the last row: once the
        // statement has ended (or was cancelled), a paused connection can swallow the reply to the
        // next command, which then never returns.
        const flush = (pause = true) => {
          if (!batch.length) return;
          const rows = batch;
          const at = index;
          batch = [];
          if (pause) this.connection.pause();
          pending = pending
            .then(async () => {
              if (interrupted) return;
              outcome.rowsDelivered += rows.length;
              if ((await sink.rows(rows, at)) === 'stop') {
                outcome.stopped = true;
                interrupt('stopped');
              }
            })
            .catch((error: unknown) => {
              failed ??= error;
              interrupt('stopped');
            })
            .finally(() => {
              if (pause) this.connection.resume();
            });
        };
        const query = this.connection.query({
          sql: this.#label + sql,
          rowsAsArray: true,
          typeCast: RAW as never,
        });
        /** An exception inside a driver event handler would otherwise leave this promise pending. */
        const guard =
          <A extends unknown[]>(handler: (...args: A) => void) =>
          (...args: A) => {
            try {
              handler(...args);
            } catch (error) {
              failed ??= error;
            }
          };
        query.on(
          'fields',
          guard((fields: RawField[] | undefined) => {
            // Statements without a result set report an empty field list.
            if (!fields?.length) return;
            flush();
            index++;
            columns = fields.map(columnInfo);
            outcome.resultSets = index + 1;
            const cols = columns;
            const at = index;
            pending = pending.then(() => sink.start(cols, at));
          }),
        );
        query.on(
          'result',
          guard((row: unknown) => {
            if (Array.isArray(row)) {
              if (interrupted) return;
              batch.push(row.map((value, i) => toCell(value, columns[i]?.binary ?? false)));
              if (batch.length >= batchSize) flush();
            } else if (row && typeof row === 'object') {
              const header = row as { affectedRows?: number; warningStatus?: number };
              if (typeof header.affectedRows === 'number')
                outcome.affectedRows = (outcome.affectedRows ?? 0) + header.affectedRows;
              warnings += header.warningStatus ?? 0;
            }
          }),
        );
        query.on('error', (error: unknown) => {
          void pending.finally(() => reject(error));
        });
        query.on('end', () => {
          flush(false);
          void pending.then(() => (failed ? reject(failed) : resolve()));
        });
        // A dropped connection (KILL, a restart, the network) reaches mysql2's connection, not a
        // streaming query: without this, the statement would wait forever.
        lost = (error?: unknown) =>
          void pending.finally(() =>
            reject(
              error ??
                Object.assign(new Error('Connection lost: the server closed the connection.'), {
                  code: 'PROTOCOL_CONNECTION_LOST',
                  fatal: true,
                }),
            ),
          );
        this.connection.once('error', lost);
        this.connection.once('end', lost);
      });
    } catch (error) {
      const mapped = mapMysqlError(error);
      if (interrupted === 'stopped' && (mapped.code === '1317' || mapped.code === '3024')) {
        // The sink stopped reading and the server ended the statement on request.
      } else if (interrupted === 'cancelled') {
        throw new DbError('cancelled', 'The statement was cancelled.', {
          code: mapped.code,
          sqlState: mapped.sqlState,
        });
      } else if (interrupted === 'timeout') {
        throw new DbError('timeout', `The statement exceeded its time limit of ${timeout} ms.`, {
          code: mapped.code,
          sqlState: mapped.sqlState,
        });
      } else {
        if (mapped.category === 'connectivity') this.markDirty('connection lost');
        throw mapped;
      }
    } finally {
      if (lost) {
        this.connection.off('error', lost);
        this.connection.off('end', lost);
      }
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (killed) await this.#absorbKill(killed);
    }
    // An interrupted SLEEP() or BENCHMARK() ends without an error; the interruption still counts.
    if (interrupted === 'timeout') {
      throw new DbError('timeout', `The statement exceeded its time limit of ${timeout} ms.`);
    }
    if (interrupted === 'cancelled') throw new DbError('cancelled', 'The statement was cancelled.');
    // Result sets carry their warning count in the EOF packet, which mysql2 does not surface, so ask.
    if (!this.dirty) {
      try {
        const rows = warnings > 0 || outcome.resultSets > 0 ? await this.#run('SHOW WARNINGS LIMIT 20') : [];
        outcome.notices = rows.map((r) => `${String(r.Level)} ${String(r.Code)}: ${String(r.Message)}`);
      } catch {
        // Warnings are informative only.
      }
    }
    return outcome;
  }

  /**
   * After KILL QUERY, waits until the server has applied it and makes sure a late kill cannot hit
   * the next statement on this connection.
   */
  async #absorbKill(killed: Promise<boolean>): Promise<void> {
    await killed;
    try {
      await this.#run('SELECT 1');
    } catch (error) {
      if (error instanceof DbError && error.code === '1317') {
        try {
          await this.#run('SELECT 1');
          return;
        } catch {
          // fall through
        }
      }
      this.markDirty('connection state unknown after cancellation');
    }
  }

  async finish(): Promise<void> {
    try {
      if (this.#inTransaction && !this.dirty) {
        this.#inTransaction = false;
        await this.#run('ROLLBACK');
      }
    } catch {
      this.markDirty('could not roll back');
    } finally {
      this.connection.removeListener('error', this.#onError);
    }
  }
}
