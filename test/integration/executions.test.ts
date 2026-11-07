/**
 * The execution engine against PostgreSQL 16 and MySQL 8.4: capture, transaction modes, queue,
 * cancellation, timeouts, quotas and restart reconciliation.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  createCore,
  loadConfig,
  type Actor,
  type Core,
  type Engine,
  type ExecutionView,
} from '@workbench/core';
import { prepareMysql, preparePostgres, targetFrom } from '../support/databases.js';
import { skipUnless } from '../support/services.js';

const writer: Actor = {
  subject: 'writer',
  username: 'writer',
  displayName: 'Writer',
  roles: ['query:read', 'query:write', 'admin'],
  source: 'gui',
  clientId: 'workbench-gui',
};

function makeCore(file: string, overrides: Record<string, string> = {}): Core {
  const config = loadConfig({
    PUBLIC_URL: 'https://db.example.test',
    KEYCLOAK_ISSUER: 'https://auth.example.test/realms/workbench',
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    ...overrides,
  });
  const core = createCore({
    databaseFile: file,
    encryptionKey: config.encryptionKey,
    limits: config.limits,
    exportDir: join(dirname(file), 'exports'),
  });
  core.users.touch(writer);
  return core;
}

async function settle(core: Core, id: string, timeoutMs = 20_000): Promise<ExecutionView> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const view = core.executions.view(id);
    if (!['queued', 'running', 'cancel_requested'].includes(view.status)) return view;
    if (Date.now() > end) throw new Error(`execution ${id} still ${view.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function until(check: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const engines: { engine: Engine; variable: string; prepare: (url: string) => Promise<void> }[] = [
  { engine: 'postgresql', variable: 'POSTGRES_TEST_URL', prepare: preparePostgres },
  { engine: 'mysql', variable: 'MYSQL_TEST_URL', prepare: prepareMysql },
];

for (const { engine, variable, prepare } of engines) {
  describe(`${engine} executions`, { skip: skipUnless(variable) }, () => {
    const url = String(process.env[variable]);
    const sleep = (s: number) => (engine === 'postgresql' ? `SELECT pg_sleep(${s})` : `SELECT SLEEP(${s})`);
    let dir: string;
    let core: Core;
    let writable: string;
    let readOnly: string;

    const connect = (name: string, ro: boolean) => {
      const t = targetFrom(url, engine);
      return core.connections.create(writer, {
        name,
        engine,
        environment: 'development',
        host: t.host,
        port: t.port,
        database: t.database,
        schema: t.schema,
        username: t.username,
        password: t.password,
        tlsMode: 'verify-full',
        caPem: t.caPem,
        readOnly: ro,
      }).id;
    };
    const submit = (sql: string, extra: Partial<Parameters<Core['executions']['submit']>[1]> = {}) =>
      core.executions.submit(writer, { connectionId: writable, sql, ...extra });
    const run = async (sql: string, extra: Partial<Parameters<Core['executions']['submit']>[1]> = {}) =>
      settle(core, (await submit(sql, extra)).id);
    const count = async (where = "name LIKE 'run-%'") => {
      const view = await run(`SELECT count(*) FROM wb_items WHERE ${where}`);
      return Number(core.executions.rows(writer, view.id, 0).rows[0]?.[0]);
    };

    before(async () => {
      await prepare(url);
      dir = await mkdtemp(join(tmpdir(), `workbench-exec-${engine}-`));
      core = makeCore(join(dir, 'workbench.sqlite'));
      writable = connect('Writable', false);
      readOnly = connect('Read only', true);
      // 1,200-row fixture.
      await run(
        engine === 'postgresql'
          ? 'CREATE TABLE wb_rows AS SELECT n, md5(n::text) AS label FROM generate_series(1, 1200) AS n'
          : 'CREATE TABLE wb_rows AS SELECT n, md5(n) AS label FROM wb_numbers WHERE n <= 1200',
      );
    });
    after(async () => {
      await core.shutdown();
      await rm(dir, { recursive: true, force: true });
    });

    it('previews 1,000 of 1,200 rows with "more available", and a full run captures exactly 1,200', async () => {
      const preview = await run('SELECT n, label FROM wb_rows ORDER BY n');
      assert.equal(preview.status, 'succeeded');
      assert.equal(preview.transactionOutcome, 'none');
      const [set] = preview.resultSets;
      assert.deepEqual(
        [set?.rowCount, set?.moreAvailable, set?.completeness],
        [1000, true, 'preview_limited'],
      );
      const last = core.executions.rows(writer, preview.id, 0, { offset: 990, limit: 50 });
      assert.equal(last.rows.length, 10);
      assert.equal(last.rows.at(-1)?.[0], '1000');

      const full = await run('SELECT n, label FROM wb_rows ORDER BY n', { captureMode: 'full' });
      const [all] = full.resultSets;
      assert.deepEqual([all?.rowCount, all?.moreAvailable, all?.completeness], [1200, false, 'complete']);
      const page = core.executions.rows(writer, full.id, 0, { offset: 1150, limit: 1000 });
      assert.equal(page.rows.length, 50);
      assert.equal(page.rows.at(-1)?.[0], '1200');
      assert.ok(all && all.expiresAt && Date.parse(all.expiresAt) > Date.now());
    });

    it('exports the full 1,200 rows as CSV and JSON without running SQL again', async () => {
      const full = await run('SELECT n, label FROM wb_rows ORDER BY n', { captureMode: 'full' });
      const executions = core.executions.list(writer, { limit: 200 }).length;
      const csv = await core.exports.create(writer, full.id, 0, { format: 'csv' });
      const json = await core.exports.create(writer, full.id, 0, { format: 'json' });
      await core.exports.idle();
      const csvText = await readFile((await core.exports.download(writer, csv.id)).path, 'utf8');
      const lines = csvText.split('\r\n').filter(Boolean);
      assert.equal(lines[0], 'n,label');
      assert.equal(lines.length, 1201);
      assert.match(lines[1200] ?? '', /^1200,[0-9a-f]{32}$/);
      const parsed = JSON.parse(await readFile((await core.exports.download(writer, json.id)).path, 'utf8'));
      assert.deepEqual(
        [parsed.completeness, parsed.capturedRows, parsed.exportedRows, parsed.rows.length],
        ['complete', 1200, 1200, 1200],
      );
      assert.equal(core.executions.list(writer, { limit: 200 }).length, executions);
    });

    it('exports values exactly as the database returned them', async () => {
      const sql =
        engine === 'postgresql'
          ? `SELECT 1 AS id, 2 AS id, NULL::text AS a, ''::text AS b, 'say "hi", then' || chr(10) || 'go' AS c, 'žluť 🐎' AS d,
               9223372036854775807::int8 AS e, (-9223372036854775808)::int8 AS f, 12345678901234567890.1234567890::numeric(38,10) AS g,
               '\\x00ff'::bytea AS h`
          : `SELECT 1 AS id, 2 AS id, NULL AS a, '' AS b, CONCAT('say "hi", then', CHAR(10 USING utf8mb4), 'go') AS c, 'žluť 🐎' AS d,
               9223372036854775807 AS e, -9223372036854775808 AS f, CAST(12345678901234567890.1234567890 AS DECIMAL(38,10)) AS g,
               X'00ff' AS h`;
      const view = await run(sql);
      const exported = await core.exports.create(writer, view.id, 0, { format: 'csv' });
      await core.exports.idle();
      const text = await readFile((await core.exports.download(writer, exported.id)).path, 'utf8');
      assert.equal(
        text,
        'id,id,a,b,c,d,e,f,g,h\r\n1,2,,"","say ""hi"", then\ngo",žluť 🐎,9223372036854775807,-9223372036854775808,12345678901234567890.1234567890,\\x00ff\r\n',
      );
    });

    it('keeps duplicate column names and separate result sets per statement', async () => {
      const view = await run('SELECT 1 AS a, 2 AS a; SELECT 3 AS b');
      assert.deepEqual(
        view.resultSets.map((s) => [s.statement, s.columns.map((c) => c.name)]),
        [
          [0, ['a', 'a']],
          [1, ['b']],
        ],
      );
    });

    it('per statement: statement 2 failing leaves a partial commit and statement 3 not run', async () => {
      const view = await run(
        "INSERT INTO wb_items (name) VALUES ('run-ps-1'); INSERT INTO wb_items (name) VALUES ('alpha'); INSERT INTO wb_items (name) VALUES ('run-ps-3')",
      );
      assert.equal(view.status, 'failed');
      assert.equal(view.transactionOutcome, 'partial_commit');
      assert.deepEqual(
        view.statements.map((s) => [s.status, s.transactionOutcome]),
        [
          ['succeeded', 'committed'],
          ['failed', 'rolled_back'],
          ['not_run', 'not_started'],
        ],
      );
      assert.equal(view.statements[0]?.affectedRows, 1);
      assert.match(String(view.error?.message), /^Statement 2:/);
      assert.equal(await count("name LIKE 'run-ps-%'"), 1);
    });

    it('per statement with continue after error runs statement 3', async () => {
      const view = await run(
        "INSERT INTO wb_items (name) VALUES ('run-ce-1'); INSERT INTO wb_items (name) VALUES ('alpha'); INSERT INTO wb_items (name) VALUES ('run-ce-3')",
        { continueOnError: true },
      );
      assert.equal(view.status, 'failed');
      assert.equal(view.transactionOutcome, 'partial_commit');
      assert.deepEqual(
        view.statements.map((s) => s.status),
        ['succeeded', 'failed', 'succeeded'],
      );
      assert.equal(await count("name LIKE 'run-ce-%'"), 2);
    });

    it('single transaction: statement 2 failing rolls everything back', async () => {
      const view = await run(
        "INSERT INTO wb_items (name) VALUES ('run-at-1'); INSERT INTO wb_items (name) VALUES ('alpha'); INSERT INTO wb_items (name) VALUES ('run-at-3')",
        { transactionMode: 'atomic' },
      );
      assert.equal(view.status, 'failed');
      assert.equal(view.transactionOutcome, 'rolled_back');
      assert.deepEqual(
        view.statements.map((s) => [s.status, s.transactionOutcome]),
        [
          ['succeeded', 'rolled_back'],
          ['failed', 'rolled_back'],
          ['not_run', 'not_started'],
        ],
      );
      assert.equal(await count("name LIKE 'run-at-%'"), 0);

      const ok = await run(
        "INSERT INTO wb_items (name) VALUES ('run-at-ok'); UPDATE wb_items SET price = 1 WHERE name = 'run-at-ok'",
        {
          transactionMode: 'atomic',
        },
      );
      assert.deepEqual([ok.status, ok.transactionOutcome], ['succeeded', 'committed']);
    });

    it('rejects before running what single-transaction mode cannot honour', async () => {
      const sql =
        engine === 'mysql'
          ? "INSERT INTO wb_items (name) VALUES ('run-ic'); CREATE TABLE wb_ic (id int)"
          : "INSERT INTO wb_items (name) VALUES ('run-ic'); CREATE INDEX CONCURRENTLY wb_ic ON wb_items (price)";
      const view = await submit(sql, { transactionMode: 'atomic' });
      assert.equal(view.status, 'preflight_rejected');
      const problems = (view.error?.detail as { problems: { code: string }[] }).problems.map((p) => p.code);
      assert.deepEqual(problems, [engine === 'mysql' ? 'implicit_commit' : 'no_transaction_block']);
      assert.equal(await count("name = 'run-ic'"), 0);
      if (engine === 'mysql') {
        const legacy = await submit("INSERT INTO wb_legacy VALUES (99, 'x')", { transactionMode: 'atomic' });
        assert.equal(legacy.status, 'preflight_rejected');
        assert.match(String(legacy.error?.message), /MyISAM/);
      }
    });

    it('a read-only connection rejects writes before running and runs reads read-only', async () => {
      const rejected = await core.executions.submit(writer, {
        connectionId: readOnly,
        sql: "DELETE FROM wb_items WHERE name = 'beta'",
      });
      assert.equal(rejected.status, 'preflight_rejected');
      assert.deepEqual(rejected.policySources, ['connection']);
      assert.match(String(rejected.error?.message), /read-only from: connection/);
      const read = await settle(
        core,
        (
          await core.executions.submit(writer, {
            connectionId: readOnly,
            sql: 'SELECT count(*) FROM wb_items',
          })
        ).id,
      );
      assert.deepEqual([read.status, read.readOnly, read.transactionOutcome], ['succeeded', true, 'none']);
    });

    it('returns the existing execution for a repeated request key and refuses a changed payload', async () => {
      const key = `key-${engine}-${Date.now()}`;
      const first = await submit('SELECT 1', { requestKey: key });
      const again = await submit('SELECT 1', { requestKey: key });
      assert.equal(again.id, first.id);
      await assert.rejects(submit('SELECT 2', { requestKey: key }), { code: 'idempotency_conflict' });
    });

    it('queues beyond two running executions per connection, first in first out, with a visible reason', async () => {
      await core.executions.idle();
      const a = await submit(sleep(1));
      const b = await submit(sleep(1));
      const c = await submit('SELECT 3');
      const queued = core.executions.view(c.id);
      assert.equal(queued.status, 'queued');
      assert.equal(queued.queue?.position, 1);
      assert.match(String(queued.queue?.reason), /2 of 2 in use/);
      const done = await settle(core, c.id);
      assert.equal(done.status, 'succeeded');
      const [va, vb] = [await settle(core, a.id), await settle(core, b.id)];
      assert.ok(
        Date.parse(String(done.startedAt)) >=
          Math.min(Date.parse(String(va.finishedAt)), Date.parse(String(vb.finishedAt))),
        JSON.stringify([
          va.status,
          va.startedAt,
          va.finishedAt,
          va.error,
          vb.status,
          vb.startedAt,
          vb.finishedAt,
          done.startedAt,
        ]),
      );
    });

    it('cancels a running statement once the database confirms, and the next execution still works', async () => {
      const view = await submit(sleep(10));
      await until(() => core.executions.view(view.id).statements[0]?.status === 'running');
      await new Promise((r) => setTimeout(r, 200));
      const requested = core.executions.cancel(writer, view.id);
      assert.equal(requested.status, 'cancel_requested');
      const done = await settle(core, view.id);
      assert.deepEqual([done.status, done.statements[0]?.status], ['cancelled', 'cancelled']);
      assert.ok(Date.parse(String(done.finishedAt)) - Date.parse(String(done.cancelRequestedAt)) < 3000);
      assert.equal((await run('SELECT 1')).status, 'succeeded');
    });

    it('cancels a queued execution before it starts', async () => {
      await core.executions.idle();
      const a = await submit(sleep(1));
      const b = await submit(sleep(1));
      const c = await submit("INSERT INTO wb_items (name) VALUES ('run-never')");
      assert.equal(core.executions.cancel(writer, c.id).status, 'cancelled');
      await Promise.all([settle(core, a.id), settle(core, b.id)]);
      const view = core.executions.view(c.id);
      assert.deepEqual(
        [view.status, view.transactionOutcome, view.statements[0]?.status],
        ['cancelled', 'not_started', 'not_run'],
      );
      assert.equal(await count("name = 'run-never'"), 0);
    });

    it('times out with the configured limit', async () => {
      const view = await run(sleep(5), { timeoutMs: 500 });
      assert.deepEqual([view.status, view.statements[0]?.status], ['timed_out', 'timed_out']);
      assert.equal((await run('SELECT 1')).status, 'succeeded');
    });

    if (engine === 'mysql') {
      it('keeps every result set of a procedure', async () => {
        const view = await run('CALL wb_proc()', { connectionId: writable });
        assert.equal(view.resultSets.length, 2);
        assert.deepEqual(core.executions.rows(writer, view.id, 1).rows, [['2', 'x']]);
      });
    }

    it('reports quota_limited, never complete, when the per-execution limit is reached', async () => {
      const small = makeCore(join(dir, 'quota.sqlite'), { MAX_RESULT_BYTES: '20000' });
      try {
        const t = targetFrom(url, engine);
        const id = small.connections.create(writer, {
          name: 'Quota',
          engine,
          environment: 'development',
          host: t.host,
          port: t.port,
          database: t.database,
          schema: t.schema,
          username: t.username,
          password: t.password,
          tlsMode: 'verify-full',
          caPem: t.caPem,
          readOnly: true,
        }).id;
        const view = await settle(
          small,
          (
            await small.executions.submit(writer, {
              connectionId: id,
              sql: 'SELECT n, label FROM wb_rows',
              captureMode: 'full',
            })
          ).id,
        );
        assert.equal(view.status, 'succeeded');
        const [set] = view.resultSets;
        assert.equal(set?.completeness, 'quota_limited');
        assert.ok(set && set.rowCount > 0 && set.rowCount < 1200 && set.byteCount <= 20000);
      } finally {
        await small.shutdown();
      }
    });

    it('after a restart, running work is interrupted and not replayed', async () => {
      const file = join(dir, 'restart.sqlite');
      const first = makeCore(file);
      const t = targetFrom(url, engine);
      const id = first.connections.create(writer, {
        name: 'Restart',
        engine,
        environment: 'development',
        host: t.host,
        port: t.port,
        database: t.database,
        schema: t.schema,
        username: t.username,
        password: t.password,
        tlsMode: 'verify-full',
        caPem: t.caPem,
        readOnly: false,
      }).id;
      const view = await first.executions.submit(writer, {
        connectionId: id,
        sql: `INSERT INTO wb_items (name) VALUES ('run-restart'); ${sleep(2)}`,
      });
      await until(() => first.executions.view(view.id).statements[1]?.status === 'running');
      // Simulate a crash: the application database goes away while the statement runs.
      first.db.close();

      const second = makeCore(file);
      try {
        assert.deepEqual(second.executions.reconcile(), { interrupted: 1, queued: 0 });
        second.executions.resume();
        const after = second.executions.view(view.id);
        assert.equal(after.status, 'interrupted');
        assert.equal(after.transactionOutcome, 'partial_commit');
        assert.deepEqual(
          after.statements.map((s) => [s.status, s.transactionOutcome]),
          [
            ['succeeded', 'committed'],
            ['interrupted', 'none'],
          ],
        );
        await new Promise((r) => setTimeout(r, 2500));
        assert.equal(await count("name = 'run-restart'"), 1);
      } finally {
        await second.shutdown();
        // The "crashed" instance still holds pools; close them (its database is already closed).
        await first.shutdown().catch(() => undefined);
      }
    });
  });
}
