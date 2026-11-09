import pg, { type ClientConfig, type QueryResult } from 'pg';
import Cursor from 'pg-cursor';
import mysql, { type ConnectionOptions, type FieldPacket } from 'mysql2';
import type { Readable } from 'node:stream';
import {
  assert,
  type Adapter,
  type Batch,
  type Cell,
  type Connection,
  type Row,
  type Session,
  type Statement,
} from './types.js';

export function encodeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return { base64: Buffer.from(value).toString('base64') };
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}
const pgTypes = {
  getTypeParser: (oid: number, format?: string) =>
    [20, 1700, 1082, 1114, 1184, 114, 3802].includes(oid)
      ? (value: string) => value
      : pg.types.getTypeParser(oid, format as 'text' | 'binary'),
};

export class PostgresAdapter implements Adapter {
  async open(connection: Connection, timeoutMs: number): Promise<Session> {
    const config: ClientConfig = {
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      ssl: connection.tls ? { rejectUnauthorized: true, ca: connection.ca } : false,
      connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
      query_timeout: Math.max(100, timeoutMs),
      application_name: 'db-workbench',
      types: pgTypes,
    };
    const client = new pg.Client(config);
    client.on('error', () => {});
    let disconnected = false;
    const ended = new Promise<void>((resolve) =>
      client.once('end', () => {
        disconnected = true;
        resolve();
      }),
    );
    let pid: number;
    try {
      await client.connect();
      await client.query(`SET statement_timeout = ${Math.max(100, Math.floor(timeoutMs))}`);
      pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
    let cancelPromise: Promise<void> | undefined;
    let closed = false;
    let cancelDeadline: NodeJS.Timeout | undefined;
    const cancel = async () => {
      if (closed) return;
      cancelDeadline ??= setTimeout(() => {
        void client.end().catch(() => {});
      }, 5000);
      cancelDeadline.unref();
      cancelPromise ??= (async () => {
        const control = new pg.Client({
          ...config,
          connectionTimeoutMillis: 3000,
          query_timeout: 3000,
        });
        control.on('error', () => {});
        try {
          await control.connect();
          await control.query('SELECT pg_cancel_backend($1)', [pid]);
        } finally {
          await control.end().catch(() => {});
        }
      })();
      await cancelPromise;
    };
    return {
      begin: async (readOnly) => {
        await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      },
      commit: async () => {
        await client.query('COMMIT');
      },
      rollback: async () => {
        await cancelPromise?.catch(() => {});
        await client.query('ROLLBACK');
      },
      async *query(sql: string, signal: AbortSignal): AsyncIterable<Batch> {
        signal.throwIfAborted();
        const onAbort = () => {
          void cancel().catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
        const cursor = client.query(
          new Cursor<unknown[]>(sql, [], { rowMode: 'array', types: pgTypes }),
        );
        try {
          while (true) {
            const batch = await new Promise<{ rows: unknown[][]; result?: QueryResult }>(
              (resolve, reject) =>
                cursor.read(250, (error, rows, result) =>
                  error ? reject(error) : resolve({ rows, result }),
                ),
            );
            signal.throwIfAborted();
            // pg-cursor omits the result on a read after the portal has closed,
            // notably when a result contains an exact multiple of the batch size.
            if (!batch.result) break;
            yield {
              columns: batch.result.fields.map((f) => ({
                name: f.name,
                type: String(f.dataTypeID),
              })),
              rows: batch.rows.map((row) => row.map(encodeCell)),
              affectedRows: batch.result.command === 'SELECT' ? null : batch.result.rowCount,
            };
            if (batch.rows.length < 250) break;
          }
        } finally {
          signal.removeEventListener('abort', onAbort);
          if (!disconnected) await Promise.race([cursor.close().catch(() => {}), ended]);
        }
      },
      cancel,
      close: async () => {
        closed = true;
        try {
          await cancelPromise?.catch(() => {});
          await client.end();
        } finally {
          clearTimeout(cancelDeadline);
        }
      },
    };
  }
}

export class MysqlAdapter implements Adapter {
  async open(connection: Connection, timeoutMs: number): Promise<Session> {
    const options: ConnectionOptions = {
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      ssl: connection.tls
        ? { rejectUnauthorized: true, verifyIdentity: true, ca: connection.ca }
        : undefined,
      connectTimeout: Math.min(timeoutMs, 10_000),
      multipleStatements: false,
      rowsAsArray: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      jsonStrings: true,
      flags: ['-LOCAL_FILES'],
    };
    const client = mysql.createConnection(options);
    client.on('error', () => {});
    try {
      await new Promise<void>((resolve, reject) =>
        client.connect((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      client.destroy();
      throw error;
    }
    const command = async (sql: string, values: unknown[] = []) => {
      const [rows] = await client
        .promise()
        .query({ sql, values, timeout: Math.max(100, Math.min(timeoutMs, 5000)) });
      return rows as unknown as unknown[][];
    };
    // Standard quoting prevents the lexer and database disagreeing about backslash escapes.
    try {
      const modes = await command('SELECT @@SESSION.sql_mode');
      assert(
        !String(modes[0]?.[0]).split(',').includes('NO_BACKSLASH_ESCAPES'),
        'UNSUPPORTED_SQL_MODE',
        'NO_BACKSLASH_ESCAPES is not supported by this milestone.',
      );
    } catch (error) {
      client.destroy();
      throw error;
    }
    let cancelPromise: Promise<void> | undefined;
    let closed = false;
    let cancelDeadline: NodeJS.Timeout | undefined;
    let activeStream: Readable | undefined;
    const cancel = async () => {
      if (closed) return;
      cancelDeadline ??= setTimeout(() => {
        activeStream?.destroy(new Error('Cancellation grace period expired.'));
        client.destroy();
      }, 5000);
      cancelDeadline.unref();
      cancelPromise ??= (async () => {
        const control = mysql.createConnection({ ...options, connectTimeout: 3000 });
        control.on('error', () => {});
        try {
          await control
            .promise()
            .query({ sql: `KILL QUERY ${Number(client.threadId)}`, timeout: 3000 });
        } finally {
          control.destroy();
        }
      })();
      await cancelPromise;
    };
    return {
      begin: async (readOnly) => {
        await command(readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
      },
      commit: async () => {
        await command('COMMIT');
      },
      rollback: async () => {
        await cancelPromise?.catch(() => {});
        await command('ROLLBACK');
      },
      async validateAtomic(statements: Statement[]) {
        for (const statement of statements)
          for (const table of statement.writeTables) {
            const rows = await command(
              'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
              [table.database ?? connection.database, table.table],
            );
            assert(
              rows.length === 1 && String(rows[0]?.[0]).toLowerCase() === 'innodb',
              'NON_TRANSACTIONAL_TABLE',
              `Atomic mode requires an InnoDB table: ${table.table}.`,
            );
          }
      },
      async *query(sql: string, signal: AbortSignal): AsyncIterable<Batch> {
        signal.throwIfAborted();
        const onAbort = () => {
          void cancel().catch(() => {});
        };
        signal.addEventListener('abort', onAbort, { once: true });
        let fields: FieldPacket[] = [];
        let rows: Row[] = [];
        let affectedRows: number | null = null;
        const query = client.query(sql);
        query.on('fields', (value: FieldPacket[]) => {
          fields = value ?? [];
        });
        const stream = query.stream({ highWaterMark: 250 });
        activeStream = stream;
        try {
          for await (const value of stream) {
            signal.throwIfAborted();
            if (Array.isArray(value)) rows.push(value.map(encodeCell));
            else if (value && typeof value.affectedRows === 'number')
              affectedRows = value.affectedRows;
            if (rows.length >= 250) {
              yield {
                columns: fields.map((f) => ({
                  name: f.name,
                  type: String(f.columnType ?? f.type),
                })),
                rows,
              };
              rows = [];
            }
          }
          yield {
            columns: fields.map((f) => ({ name: f.name, type: String(f.columnType ?? f.type) })),
            rows,
            affectedRows,
          };
        } finally {
          activeStream = undefined;
          signal.removeEventListener('abort', onAbort);
        }
      },
      cancel,
      close: async () => {
        closed = true;
        await cancelPromise?.catch(() => {});
        clearTimeout(cancelDeadline);
        client.destroy();
      },
    };
  }
}
