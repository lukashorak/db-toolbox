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
import mysql from 'mysql2/promise';
import pg from 'pg';
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
        // After USE, unqualified names are the other database's: its wb_items is MyISAM.
        const moved = await submit(
          "INSERT INTO wb_items (name) VALUES ('run-use'); USE workbench_it_other; INSERT INTO wb_items (id, name) VALUES (1, 'run-use')",
          { transactionMode: 'atomic' },
        );
        assert.equal(moved.status, 'preflight_rejected');
        assert.match(String(moved.error?.message), /workbench_it_other\.wb_items, a MyISAM table/);
        assert.equal(await count("name = 'run-use'"), 0);
        // A view has no engine of its own: the MyISAM table beneath it decides.
        const throughView = await submit(
          "INSERT INTO wb_items (name) VALUES ('run-view'); INSERT INTO wb_legacy_notes (id, note) VALUES (97, 'x')",
          { transactionMode: 'atomic' },
        );
        assert.equal(throughView.status, 'preflight_rejected');
        assert.match(String(throughView.error?.message), /wb_legacy_notes, a MyISAM table/);
        // A view over InnoDB tables is fine.
        const innoView = await settle(
          core,
          (
            await submit("INSERT INTO wb_item_names (name) VALUES ('run-view-ok')", {
              transactionMode: 'atomic',
            })
          ).id,
        );
        assert.deepEqual([innoView.status, innoView.transactionOutcome], ['succeeded', 'committed']);
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

    /** Ends the database session that runs an execution, from a client outside the workbench. */
    async function killSession(executionId: string) {
      const t = targetFrom(url, engine);
      const options = {
        host: t.host,
        port: t.port,
        user: t.username,
        password: t.password,
        database: t.database,
      };
      if (engine === 'postgresql') {
        const client = new pg.Client({ ...options, ssl: { rejectUnauthorized: false } });
        await client.connect();
        try {
          const killed = await client.query(
            'SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE application_name = $1',
            [`database-workbench ${executionId}`],
          );
          assert.equal(killed.rowCount, 1);
        } finally {
          await client.end();
        }
      } else {
        const client = await mysql.createConnection({ ...options, ssl: { rejectUnauthorized: false } });
        try {
          const [rows] = await client.query(
            'SELECT id FROM information_schema.processlist WHERE info LIKE ? AND id <> CONNECTION_ID()',
            [`%database-workbench ${executionId}%`],
          );
          const ids = (rows as { id: number }[]).map((r) => r.id);
          assert.equal(ids.length, 1);
          await client.query(`KILL ${Number(ids[0])}`);
        } finally {
          await client.end();
        }
      }
    }

    it('a lost connection fails the execution with an honest outcome; the next one gets a fresh session (AC8)', async () => {
      const view = await submit(`INSERT INTO wb_items (name) VALUES ('run-lost'); ${sleep(10)}`, {
        transactionMode: 'per_statement',
      });
      await until(() => core.executions.view(view.id).statements[1]?.status === 'running');
      await new Promise((r) => setTimeout(r, 200));
      const started = Date.now();
      await killSession(view.id);
      const done = await settle(core, view.id);
      assert.ok(Date.now() - started < 5000, 'noticed at once, not at the end of the sleep');
      assert.deepEqual([done.status, done.transactionOutcome], ['failed', 'partial_commit']);
      assert.deepEqual(
        done.statements.map((s) => [s.status, s.transactionOutcome]),
        [
          ['succeeded', 'committed'],
          ['failed', 'none'],
        ],
      );
      assert.equal((done.error?.detail as { category?: string } | undefined)?.category, 'connectivity');
      assert.equal(await count("name = 'run-lost'"), 1, 'the committed statement stays');
      const after = await run('SELECT 1');
      assert.equal(after.status, 'succeeded', 'the pool hands out a working session');

      // In a single transaction the server discards the open transaction with the session.
      const atomic = await submit(`INSERT INTO wb_items (name) VALUES ('run-lost-atomic'); ${sleep(10)}`, {
        transactionMode: 'atomic',
      });
      await until(() => core.executions.view(atomic.id).statements[1]?.status === 'running');
      await new Promise((r) => setTimeout(r, 200));
      await killSession(atomic.id);
      const rolledBack = await settle(core, atomic.id);
      assert.deepEqual([rolledBack.status, rolledBack.transactionOutcome], ['failed', 'rolled_back']);
      assert.equal(await count("name = 'run-lost-atomic'"), 0);
    });

    it('discards a session after a statement that leaves session state, so the next run starts clean', async () => {
      // One session per connection, so the second run would get the same one from the pool.
      const single = makeCore(join(dir, 'session-state.sqlite'), { CONCURRENCY_PER_CONNECTION: '1' });
      try {
        const t = targetFrom(url, engine);
        const id = single.connections.create(writer, {
          name: 'One session',
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
        const runOn = async (sql: string) =>
          settle(single, (await single.executions.submit(writer, { connectionId: id, sql })).id);
        const set =
          engine === 'mysql'
            ? "SELECT @wb_secret := 'left behind'"
            : "SELECT set_config('wb.secret', 'left behind', false)";
        assert.equal((await runOn(set)).status, 'succeeded');
        const read =
          engine === 'mysql' ? 'SELECT @wb_secret AS v' : "SELECT current_setting('wb.secret', true) AS v";
        const view = await runOn(read);
        assert.equal(view.status, 'succeeded');
        const value = single.executions.rows(writer, view.id, 0).rows[0]?.[0];
        assert.ok(value === null || value === '', `the next run saw ${JSON.stringify(value)}`);

        // A temporary table lives with the session, and would shadow a permanent table of that name.
        const temp =
          engine === 'mysql'
            ? "CREATE TEMPORARY TABLE wb_items (name TEXT); INSERT INTO wb_items VALUES ('temporary')"
            : "CREATE TEMP TABLE wb_items (name TEXT); INSERT INTO wb_items VALUES ('temporary')";
        assert.equal((await runOn(temp)).status, 'succeeded');
        const next = await runOn("SELECT count(*) AS n FROM wb_items WHERE name = 'temporary'");
        assert.equal(next.status, 'succeeded');
        assert.equal(
          single.executions.rows(writer, next.id, 0).rows[0]?.[0],
          '0',
          'the next run reads the permanent table, not the temporary one',
        );

        // Session-level locks belong to the connection: discarding it releases them.
        const lock = engine === 'mysql' ? "SELECT GET_LOCK('wb_lock', 0)" : 'SELECT pg_advisory_lock(4242)';
        assert.equal((await runOn(lock)).status, 'succeeded');
        const held =
          engine === 'mysql'
            ? "SELECT IS_USED_LOCK('wb_lock') IS NOT NULL AS held"
            : "SELECT count(*) > 0 AS held FROM pg_locks WHERE locktype = 'advisory' AND objid = 4242 AND granted";
        const check = await runOn(held);
        assert.ok(
          ['0', 'false', 'f'].includes(String(single.executions.rows(writer, check.id, 0).rows[0]?.[0])),
          'the lock was released with the connection',
        );
        if (engine === 'mysql') {
          // The same for a lock taken inside a write.
          const write = "INSERT INTO wb_items (name) VALUES (CONCAT('lock-', GET_LOCK('wb_lock_2', 0)))";
          assert.equal((await runOn(write)).status, 'succeeded');
          const after = await runOn("SELECT IS_USED_LOCK('wb_lock_2') IS NOT NULL AS held");
          assert.equal(
            single.executions.rows(writer, after.id, 0).rows[0]?.[0],
            '0',
            'released after a write',
          );
        }
      } finally {
        await single.shutdown();
      }
    });

    if (engine === 'mysql') {
      it('checks storage engines again when the connection changes while a run is queued', async () => {
        const single = makeCore(join(dir, 'moved.sqlite'), { CONCURRENCY_PER_CONNECTION: '1' });
        try {
          const t = targetFrom(url, engine);
          const id = single.connections.create(writer, {
            name: 'Movable',
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
          const busy = await single.executions.submit(writer, { connectionId: id, sql: 'SELECT SLEEP(1)' });
          // Checked at submission against workbench_it, where wb_items is InnoDB.
          const queued = await single.executions.submit(writer, {
            connectionId: id,
            sql: "INSERT INTO wb_items (id, name) VALUES (7, 'run-moved')",
            transactionMode: 'atomic',
          });
          assert.equal(single.executions.view(queued.id).status, 'queued');
          // Now the connection points at a database whose wb_items is MyISAM.
          single.connections.update(writer, id, { database: 'workbench_it_other' });
          const done = await settle(single, queued.id);
          assert.deepEqual([done.status, done.transactionOutcome], ['rejected', 'not_started']);
          assert.match(String(done.error?.message), /MyISAM/);
          await settle(single, busy.id);

          // A storage-engine lookup that stalls at the start gives way to a cancel and to the time limit.
          single.connections.update(writer, id, { database: t.database });
          const adapter = await single.databases.adapterForConnection(id);
          const lookup = adapter.tableEngine.bind(adapter);
          const ahead = await single.executions.submit(writer, { connectionId: id, sql: 'SELECT SLEEP(1)' });
          const cancelled = await single.executions.submit(writer, {
            connectionId: id,
            sql: "INSERT INTO wb_items (name) VALUES ('run-stalled')",
            transactionMode: 'atomic',
          });
          const limited = await single.executions.submit(writer, {
            connectionId: id,
            sql: "INSERT INTO wb_items (name) VALUES ('run-stalled-2')",
            transactionMode: 'atomic',
            timeoutMs: 1500,
          });
          adapter.tableEngine = () => new Promise(() => undefined);
          try {
            await settle(single, ahead.id);
            await until(() => single.executions.view(cancelled.id).status === 'running');
            single.executions.cancel(writer, cancelled.id);
            const stopped = await settle(single, cancelled.id);
            assert.deepEqual([stopped.status, stopped.transactionOutcome], ['cancelled', 'not_started']);
            const timedOut = await settle(single, limited.id);
            assert.deepEqual([timedOut.status, timedOut.transactionOutcome], ['timed_out', 'not_started']);
          } finally {
            adapter.tableEngine = lookup;
          }
        } finally {
          await single.shutdown();
        }
      });
    }

    it('keeps results as long as Retain asked, even when chosen while the run was going', async () => {
      const started = await submit(`${sleep(1.5)}, 1 AS one`);
      await until(() => core.executions.view(started.id).status === 'running');
      core.executions.retain(writer, started.id, 7);
      const done = await settle(core, started.id);
      assert.equal(done.status, 'succeeded');
      const expires = Date.parse(String(done.resultSets[0]?.expiresAt));
      assert.ok(expires > Date.now() + 6 * 86_400_000, `results expire at ${done.resultSets[0]?.expiresAt}`);
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

      it('reports an unknown outcome when a write to a non-transactional table fails half way', async () => {
        assert.equal(
          (await run("INSERT INTO wb_legacy VALUES (60, 'first')", { connectionId: writable })).status,
          'succeeded',
        );
        // MyISAM keeps row 61 when the duplicate 60 fails the statement.
        const half = await run("INSERT INTO wb_legacy VALUES (61, 'kept'), (60, 'duplicate')", {
          connectionId: writable,
        });
        assert.deepEqual(
          [half.status, half.statements[0]?.transactionOutcome, half.transactionOutcome],
          ['failed', 'unknown', 'unknown'],
        );
        // A temporary MyISAM table is invisible to the metadata connection: unknown, not a rollback.
        const temp = await run(
          'CREATE TEMPORARY TABLE wb_tmp (id int PRIMARY KEY) ENGINE=MyISAM; INSERT INTO wb_tmp VALUES (1); INSERT INTO wb_tmp VALUES (2), (1)',
          { connectionId: writable },
        );
        assert.deepEqual([temp.status, temp.statements[2]?.transactionOutcome], ['failed', 'unknown']);
        // A write to a table that does not exist fails before writing anything.
        const missing = await run('INSERT INTO wb_no_such_table VALUES (1)', { connectionId: writable });
        assert.deepEqual(
          [missing.statements[0]?.transactionOutcome, missing.transactionOutcome],
          ['rolled_back', 'none'],
        );
        // InnoDB undoes the failed statement: that is still a rollback.
        const inno = await run("INSERT INTO wb_items (name) VALUES ('run-inno-ok'), ('alpha')", {
          connectionId: writable,
        });
        assert.deepEqual(
          [inno.status, inno.statements[0]?.transactionOutcome, inno.transactionOutcome],
          ['failed', 'rolled_back', 'none'],
        );
      });

      it('reports an unknown outcome, not a rollback, when a procedure fails after committing', async () => {
        const view = await run('CALL wb_commit_then_fail()', { connectionId: writable });
        assert.equal(view.status, 'failed');
        assert.deepEqual(
          [view.statements[0]?.status, view.statements[0]?.transactionOutcome, view.transactionOutcome],
          ['failed', 'unknown', 'unknown'],
        );
        assert.match(String(view.error?.message), /failed after a commit/);
        assert.equal(await count("name = 'proc-committed'"), 1, 'the committed part stays');
        // A "not found" error raised inside the procedure says nothing about what ran before it.
        const missing = await run('CALL wb_write_then_missing()', { connectionId: writable });
        assert.deepEqual(
          [missing.status, missing.statements[0]?.transactionOutcome, missing.transactionOutcome],
          ['failed', 'unknown', 'unknown'],
        );
        assert.equal(await count("name = 'proc-before-missing'"), 1);
      });

      it('lets a procedure finish its writes when its rows reach the preview limit', async () => {
        const view = await run('CALL wb_report_then_write()', { connectionId: writable });
        assert.deepEqual([view.status, view.statements[0]?.status], ['succeeded', 'succeeded']);
        const [set] = view.resultSets;
        assert.deepEqual(
          [set?.rowCount, set?.completeness, set?.moreAvailable],
          [1000, 'preview_limited', true],
        );
        assert.equal(
          await count("name = 'proc-after-report-5000000'"),
          1,
          'the write after the rows happened',
        );
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

    it('shares a total quota across retained results; retention cleanup frees it and keeps the history (AC10)', async () => {
      const probe = await run('SELECT n, label FROM wb_rows ORDER BY n', { captureMode: 'full' });
      const bytes = Number(probe.resultSets[0]?.byteCount);
      assert.ok(bytes > 10_000);
      // Room for about one and a half results (the budget keeps 5 % for metadata).
      const total = Math.ceil((bytes * 1.5) / 0.95);
      const small = makeCore(join(dir, 'total.sqlite'), {
        MAX_RESULT_BYTES: String(bytes + 1000),
        MAX_TOTAL_BYTES: String(total),
      });
      try {
        const t = targetFrom(url, engine);
        const id = small.connections.create(writer, {
          name: 'Total quota',
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
        const full = async () =>
          settle(
            small,
            (
              await small.executions.submit(writer, {
                connectionId: id,
                sql: 'SELECT n, label FROM wb_rows ORDER BY n',
                captureMode: 'full',
              })
            ).id,
          );
        const first = await full();
        assert.equal(first.resultSets[0]?.completeness, 'complete');
        const second = await full();
        assert.equal(second.status, 'succeeded');
        assert.equal(second.resultSets[0]?.completeness, 'quota_limited', 'never complete when cut short');
        assert.ok(Number(second.resultSets[0]?.rowCount) < 1200);

        // A day later the working results expire; their executions stay in history.
        await small.cleanup(new Date(Date.now() + 25 * 3600_000));
        const expired = small.executions.view(first.id);
        assert.deepEqual(
          [expired.status, expired.resultSets[0]?.completeness, expired.sql],
          ['succeeded', 'expired', 'SELECT n, label FROM wb_rows ORDER BY n'],
        );
        assert.equal(small.executions.storedBytes, 0);
        assert.equal((await full()).resultSets[0]?.completeness, 'complete', 'the space is free again');
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

    it('on shutdown, running work may finish within the grace period; the rest is interrupted, queued work waits', async () => {
      const file = join(dir, 'shutdown.sqlite');
      const open = () => makeCore(file, { CONCURRENCY_PER_CONNECTION: '1' });
      const first = open();
      const t = targetFrom(url, engine);
      const id = first.connections.create(writer, {
        name: 'Shutdown',
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
      const short = await first.executions.submit(writer, { connectionId: id, sql: sleep(1) });
      const waiting = await first.executions.submit(writer, { connectionId: id, sql: 'SELECT 1' });
      await until(() => first.executions.view(short.id).status === 'running');
      await first.shutdown({ graceMs: 10_000 });

      const second = open();
      let long: ExecutionView;
      try {
        assert.equal(second.executions.view(short.id).status, 'succeeded', 'finished within the grace');
        assert.equal(second.executions.view(waiting.id).status, 'queued', 'never started, still queued');
        assert.deepEqual(second.executions.reconcile(), { interrupted: 0, queued: 1 });
        second.executions.resume();
        assert.equal((await settle(second, waiting.id)).status, 'succeeded');
        long = await second.executions.submit(writer, { connectionId: id, sql: sleep(10) });
        await until(() => second.executions.view(long.id).status === 'running');
        const started = Date.now();
        await second.shutdown({ graceMs: 300 });
        assert.ok(Date.now() - started < 5000, 'the statement was cancelled in the database');
      } finally {
        await second.shutdown().catch(() => undefined);
      }

      const third = open();
      try {
        const view = third.executions.view(long.id);
        assert.deepEqual([view.status, view.transactionOutcome], ['interrupted', 'none']);
        assert.match(String(view.statusNote), /server shut down/);
        assert.deepEqual(third.executions.reconcile(), { interrupted: 0, queued: 0 });
      } finally {
        await third.shutdown();
      }
    });
  });
}
