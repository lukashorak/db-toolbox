import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { SecretBox } from '../src/core/secrets.js';
import { Store } from '../src/core/store.js';
import { Workbench } from '../src/core/service.js';
import { encodeCell } from '../src/core/adapters.js';
import type { Actor, Adapter, Batch, ExecutionInput, Limits, Session } from '../src/core/types.js';

export const human: Actor = {
  subject: 'test-user',
  roles: ['admin', 'query:read', 'query:write', 'monitor:read'],
  channel: 'gui',
  clientId: 'workbench-gui',
  expiresAt: Date.now() + 3600_000,
};
export const connectionSettings = {
  name: 'Test PostgreSQL',
  engine: 'postgres' as const,
  host: '127.0.0.1',
  port: 5432,
  database: 'test',
  username: 'test',
  password: 'test-secret',
  tls: false,
  readOnly: false,
  enabled: true,
};
// Real PostgreSQL query semantics via WASM; this is not a test of TCP drivers.
export class PGliteAdapter implements Adapter {
  constructor(readonly db: PGlite) {}
  async open(): Promise<Session> {
    return {
      begin: async (readOnly) => {
        await this.db.exec(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      },
      commit: async () => {
        await this.db.exec('COMMIT');
      },
      rollback: async () => {
        await this.db.exec('ROLLBACK');
      },
      query: async function* (
        this: PGliteAdapter,
        sql: string,
        signal: AbortSignal,
      ): AsyncIterable<Batch> {
        signal.throwIfAborted();
        const value = await this.db.query<unknown[]>(sql, [], { rowMode: 'array' });
        const columns = value.fields.map((f) => ({ name: f.name, type: String(f.dataTypeID) }));
        for (let i = 0; i < value.rows.length; i += 100)
          yield { columns, rows: value.rows.slice(i, i + 100).map((row) => row.map(encodeCell)) };
        yield { columns, rows: [], affectedRows: value.affectedRows ?? null };
      }.bind(this),
      cancel: async () => {},
      close: async () => {},
    };
  }
}
export async function fixture(limits: Partial<Limits> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'workbench-test-'));
  const key = randomBytes(32).toString('base64');
  const store = new Store(join(directory, 'state.sqlite'), new SecretBox(key));
  const db = new PGlite();
  await db.waitReady;
  await db.exec(
    "CREATE TABLE sample(id integer PRIMARY KEY, label text, exact numeric(25,2)); INSERT INTO sample SELECT i, 'Žluťoučký ' || i, 9007199254740993.25 FROM generate_series(1,1200) i; CREATE TABLE ledger(id integer PRIMARY KEY, amount integer);",
  );
  const adapter = new PGliteAdapter(db);
  const core = new Workbench(
    store,
    { postgres: adapter, mysql: adapter },
    join(directory, 'exports'),
    { concurrency: 1, ...limits },
  );
  const connection = core.saveConnection(human, connectionSettings);
  const profile = core.saveProfile(human, {
    name: 'Claude Code',
    clientId: 'workbench-mcp',
    connectionIds: [connection.id],
    readOnly: true,
    enabled: true,
  });
  const mcp: Actor = {
    ...human,
    channel: 'mcp',
    clientId: profile.clientId,
    profileId: profile.id,
  };
  const input = (sql: string, overrides: Partial<ExecutionInput> = {}): ExecutionInput => ({
    connectionId: connection.id,
    sql,
    capture: 'full',
    transaction: 'per_statement',
    timeoutMs: 5000,
    retentionHours: 24,
    requestKey: randomUUID(),
    ...overrides,
  });
  return {
    directory,
    key,
    store,
    db,
    adapter,
    core,
    connection,
    profile,
    mcp,
    input,
    async close() {
      await core.shutdown();
      store.close();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export async function finished(core: Workbench, id: string, actor = human) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const job = core.execution(actor, id);
    if (!['queued', 'running', 'cancel_requested'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Execution did not finish');
}
