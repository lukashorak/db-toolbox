/**
 * Adapters, read-only barriers, TLS, connection tests and metadata against PostgreSQL 16 and
 * MySQL 8.4 containers. The same expectations run on both engines where they mean the same thing.
 *
 *   scripts/integration/start.sh postgres mysql
 *   POSTGRES_TEST_URL=… MYSQL_TEST_URL=… npm run test:integration
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import mysql from 'mysql2/promise';
import { after, before, describe, it } from 'node:test';
import {
  AdapterRegistry,
  analyzeScript,
  analyzeStatement,
  DbError,
  preflight,
  type Cell,
  type ColumnInfo,
  type ConnectionTarget,
  type DbAdapter,
  type Engine,
  type ResultSink,
} from '@workbench/core';
import { MYSQL_CORPUS, POSTGRES_CORPUS } from '../fixtures/classification.js';
import {
  certs,
  DATABASE,
  prepareMysql,
  preparePostgres,
  PARTIAL_WRITER,
  READER,
  VIEW_ONLY,
  ROLE_WRITER,
  targetFrom,
  WRITER,
} from '../support/databases.js';
import { skipUnless } from '../support/services.js';

function collect(stopAfter?: number) {
  const sets: { columns: ColumnInfo[]; rows: Cell[][] }[] = [];
  let total = 0;
  const sink: ResultSink = {
    start(columns, index) {
      sets[index] = { columns, rows: [] };
    },
    rows(rows, index) {
      sets[index]?.rows.push(...rows);
      total += rows.length;
      return stopAfter !== undefined && total >= stopAfter ? 'stop' : undefined;
    },
  };
  return { sets, sink };
}

/** A TCP server that accepts connections and never speaks, to provoke connect timeouts. */
async function silentServer(): Promise<{ server: Server; port: number }> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, port: typeof address === 'object' && address ? address.port : 0 };
}

const engines: { engine: Engine; variable: string; prepare: (url: string) => Promise<void> }[] = [
  { engine: 'postgresql', variable: 'POSTGRES_TEST_URL', prepare: preparePostgres },
  { engine: 'mysql', variable: 'MYSQL_TEST_URL', prepare: prepareMysql },
];

for (const { engine, variable, prepare } of engines) {
  describe(`${engine} adapter`, { skip: skipUnless(variable) }, () => {
    const url = String(process.env[variable]);
    const target = (overrides: Partial<ConnectionTarget> = {}) => targetFrom(url, engine, overrides);
    const registry = new AdapterRegistry({
      sizes: { work: 2, metadata: 1, control: 1 },
      connectTimeoutMs: 5000,
    });
    let adapter: DbAdapter;
    const run = async (
      sql: string,
      options: { readOnly?: boolean; timeoutMs?: number; stopAfter?: number } = {},
    ) =>
      adapter.withSession(async (s) => {
        const { sets, sink } = collect(options.stopAfter);
        if (options.readOnly !== undefined) await s.begin({ readOnly: options.readOnly });
        try {
          const outcome = await s.execute(sql, sink, {
            timeoutMs: options.timeoutMs ?? 10_000,
            batchSize: 1000,
          });
          return { outcome, sets, backendId: s.backendId };
        } finally {
          if (options.readOnly !== undefined) await s.rollback().catch(() => undefined);
        }
      });

    before(async () => {
      await prepare(url);
      adapter = await registry.get({ ...target(), updatedAt: 'v1' });
    });
    after(() => registry.closeAll());

    it('clears what a run left on the connection before the next run uses it', async () => {
      // One work connection, so the second run gets the same one.
      const single = new AdapterRegistry({
        sizes: { work: 1, metadata: 1, control: 1 },
        connectTimeoutMs: 5000,
      });
      try {
        const one = await single.get({ ...target({ id: `cn_reset_${engine}` }), updatedAt: 'v1' });
        const runOn = (sql: string) =>
          one.withSession(async (s) => {
            const { sets, sink } = collect();
            await s.execute(sql, sink, { timeoutMs: 10_000, batchSize: 1000 });
            return { rows: sets[0]?.rows ?? [], backendId: s.backendId };
          });
        const first = await runOn('SELECT wb_fn_leave_state()');
        const second = await runOn(
          engine === 'mysql'
            ? "SELECT @wb_leak AS v, IS_USED_LOCK('wb_leak') AS l, @@collation_connection AS c"
            : "SELECT coalesce(current_setting('wb.leak', true), '') AS v, (SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()) AS l",
        );
        assert.equal(second.backendId, first.backendId, 'the same connection');
        assert.deepEqual(
          second.rows,
          engine === 'mysql' ? [[null, null, 'utf8mb4_general_ci']] : [['', '0']],
        );
      } finally {
        await single.closeAll();
      }
    });

    describe('connection test', () => {
      it('succeeds with verify-full against the custom CA and reports capabilities', async () => {
        const report = await registry.test(target());
        assert.equal(report.ok, true, JSON.stringify(report.failure));
        assert.deepEqual(
          report.steps.map((s) => [s.name, s.status]),
          [
            ['reach', 'ok'],
            ['tls', 'ok'],
            ['authenticate', 'ok'],
            ['probe', 'ok'],
          ],
        );
        assert.equal(report.tls.encrypted, true);
        assert.match(
          report.server?.version ?? '',
          engine === 'postgresql' ? /^(1[6-9]|[2-9]\d)\./ : /^8\.4\./,
        );
        const caps = Object.fromEntries(report.capabilities.map((c) => [c.name, c.available]));
        assert.equal(caps.read_only_transactions, true);
        assert.equal(caps.read_only_account, false, 'the admin account can write');
        assert.ok(report.warnings.length > 0, 'warns about the privileged account');
        assert.doesNotMatch(JSON.stringify(report), /workbench-it/, 'no password in the report');
      });

      it('recognises a read-only account without monitoring rights', async () => {
        const report = await registry.test(target({ username: READER.username, password: READER.password }));
        assert.equal(report.ok, true, JSON.stringify(report.failure));
        const caps = Object.fromEntries(report.capabilities.map((c) => [c.name, c.available]));
        assert.equal(caps.read_only_account, true);
        assert.equal(caps.monitoring, false);
      });

      it('separates connectivity, authentication, TLS, configuration and timeout failures', async () => {
        const { server, port } = await silentServer();
        try {
          const cases: [Partial<ConnectionTarget>, string, string, number?][] = [
            [{ port: 1, host: '127.0.0.1', tlsMode: 'require' }, 'connectivity', 'reach'],
            [{ host: 'no-such-host.invalid' }, 'connectivity', 'reach'],
            [{ password: 'wrong-password' }, 'authentication', 'authenticate'],
            [{ host: '127.0.0.1' }, 'tls', 'tls'],
            [{ caPem: certs().otherCa }, 'tls', 'tls'],
            [{ caPem: null }, 'tls', 'tls'],
            [{ database: 'no_such_database' }, 'configuration', 'authenticate'],
            [{ host: '127.0.0.1', port, tlsMode: 'disable' }, 'timeout', 'authenticate', 1500],
          ];
          for (const [overrides, category, step, timeout] of cases) {
            const report = await registry.test(target(overrides), timeout);
            const label = JSON.stringify(overrides).slice(0, 80);
            assert.equal(report.ok, false, label);
            assert.equal(report.failure?.category, category, `${label}: ${report.failure?.message}`);
            assert.equal(report.steps.find((s) => s.status === 'failed')?.name, step, label);
          }
        } finally {
          server.close();
        }
      });

      it('accepts a hostname mismatch only with verify-ca, and an unverified certificate only with require', async () => {
        assert.equal((await registry.test(target({ host: '127.0.0.1', tlsMode: 'verify-ca' }))).ok, true);
        const require = await registry.test(target({ host: '127.0.0.1', tlsMode: 'require', caPem: null }));
        assert.equal(require.ok, true);
        assert.match(require.tls.description, /not verified/);
      });
    });

    describe('read-only enforcement', () => {
      const corpus = engine === 'postgresql' ? POSTGRES_CORPUS : MYSQL_CORPUS;

      it('the database rejects every corpus write inside a read-only transaction (second barrier)', async () => {
        const accepted: string[] = [];
        for (const entry of corpus.filter((e) => e.databaseRejects)) {
          try {
            await run(entry.sql, { readOnly: true });
            accepted.push(entry.sql);
          } catch (error) {
            assert.ok(error instanceof DbError, entry.sql);
            assert.equal(error.category, 'read_only', `${entry.sql}: ${error.message}`);
          }
        }
        assert.deepEqual(accepted, []);
      });

      it('runs every corpus statement marked safe inside a read-only transaction', async () => {
        for (const entry of corpus.filter((e) => e.safe && e.kind !== 'transaction')) {
          await run(entry.sql, { readOnly: true });
        }
      });

      if (engine === 'mysql') {
        it('MySQL DDL is not stopped by a read-only transaction, so the workbench rejects it before running', async () => {
          // Decision 0022: DDL commits implicitly and runs even in START TRANSACTION READ ONLY.
          await run('CREATE TABLE wb_scratch (id int)', { readOnly: true });
          await run('DROP TABLE wb_scratch', { readOnly: true });
          const problems = await preflight(await analyzeScript('DROP TABLE wb_items', 'mysql'), {
            engine,
            transactionMode: 'per_statement',
            readOnly: true,
          });
          assert.equal(problems[0]?.code, 'read_only_violation');
        });

        it('a read-only transaction also stops writes to non-transactional tables', async () => {
          await assert.rejects(run("INSERT INTO wb_legacy VALUES (1, 'x')", { readOnly: true }), {
            category: 'read_only',
          });
        });

        it('finds non-transactional tables for single-transaction preflight', async () => {
          assert.equal(await adapter.tableEngine({ schema: null, name: 'wb_legacy' }), 'MyISAM');
          // Views report their base tables' engine; a view reached twice is not a cycle.
          assert.equal(await adapter.tableEngine({ schema: null, name: 'wb_legacy_notes' }), 'MyISAM');
          assert.equal(await adapter.tableEngine({ schema: null, name: 'wb_v_both' }), 'InnoDB');
          // A trigger's writes count: one into MyISAM cannot roll back, one into InnoDB can.
          assert.equal(
            await adapter.tableEngine({ schema: null, name: 'wb_audited' }),
            'MyISAM (written by a trigger)',
          );
          assert.equal(await adapter.tableEngine({ schema: null, name: 'wb_audited_inno' }), 'InnoDB');
          // Only triggers the write can fire count: a DELETE trigger does not concern an INSERT.
          assert.equal(
            await adapter.tableEngine({ schema: null, name: 'wb_del_trig', events: ['INSERT'] }),
            'InnoDB',
          );
          assert.equal(
            await adapter.tableEngine({ schema: null, name: 'wb_del_trig', events: ['DELETE'] }),
            'MyISAM (written by a trigger)',
          );
          assert.equal(
            await adapter.tableEngine({ schema: null, name: 'wb_del_trig', events: ['INSERT', 'DELETE'] }),
            'MyISAM (written by a trigger)',
            'REPLACE fires delete triggers too',
          );
          // An account without TRIGGER cannot see triggers: no triggers listed proves nothing.
          const writer = await registry.get({
            ...target({ id: 'cn_writer_mysql', username: WRITER.username, password: WRITER.password }),
            updatedAt: 'v1',
          });
          assert.equal(await writer.tableEngine({ schema: null, name: 'wb_audited' }), 'unresolved view');
          assert.equal(await writer.tableEngine({ schema: null, name: 'wb_orders' }), 'unresolved view');
          assert.equal(await writer.tableEngine({ schema: null, name: 'wb_items' }), 'InnoDB');
          // A function the account may run but did not define shows no body: its writes are unknown.
          assert.equal(await writer.functionEngine({ schema: null, name: 'wb_fn_inno' }), 'unresolved view');
          // TRIGGER through an active (default) role counts as well.
          const roleWriter = await registry.get({
            ...target({
              id: 'cn_role_writer_mysql',
              username: ROLE_WRITER.username,
              password: ROLE_WRITER.password,
            }),
            updatedAt: 'v1',
          });
          assert.equal(await roleWriter.tableEngine({ schema: null, name: 'wb_orders' }), 'InnoDB');
          assert.equal(
            await roleWriter.tableEngine({ schema: null, name: 'wb_audited' }),
            'MyISAM (written by a trigger)',
          );
          // A partial revoke on the schema hides triggers, except where TRIGGER is granted again on
          // the table.
          const partialWriter = await registry.get({
            ...target({
              id: 'cn_partial_writer_mysql',
              username: PARTIAL_WRITER.username,
              password: PARTIAL_WRITER.password,
            }),
            updatedAt: 'v1',
          });
          assert.equal(await partialWriter.tableEngine({ schema: null, name: 'wb_items' }), 'InnoDB');
          assert.equal(
            await partialWriter.tableEngine({ schema: null, name: 'wb_orders' }),
            'unresolved view',
          );
          // Stored functions: what they write, through other functions too; built-ins are not stored.
          const fn = (name: string) => adapter.functionEngine({ schema: null, name });
          assert.equal(await fn('wb_fn_legacy'), 'MyISAM');
          assert.equal(await fn('WB_FN_NESTED'), 'MyISAM');
          assert.equal(await fn('wb_fn_inno'), 'InnoDB');
          assert.equal(await fn('wb_item_count'), null);
          assert.equal(await fn('wb_fn_branch'), 'unresolved view');
          // A body that reads a view: the view's function writes MyISAM.
          assert.equal(await fn('wb_fn_reads_view'), 'MyISAM');
          assert.equal(await fn('now'), null);
          // Views: what the functions in their definitions write, through nested views too.
          const view = (name: string) => adapter.viewEngine({ schema: null, name });
          assert.equal(await view('wb_v_fn_legacy'), 'MyISAM');
          assert.equal(await view('wb_v_fn_legacy_nested'), 'MyISAM');
          assert.equal(await view('wb_v_fn_inno_nested'), 'InnoDB');
          assert.equal(await view('wb_item_names'), null);
          assert.equal(await view('wb_items'), null);
          // A definer view over a view the account cannot see: what lies beneath is unknown.
          const viewOnly = await registry.get({
            ...target({
              id: 'cn_view_only_mysql',
              username: VIEW_ONLY.username,
              password: VIEW_ONLY.password,
            }),
            updatedAt: 'v1',
          });
          assert.equal(
            await viewOnly.viewEngine({ schema: null, name: 'wb_v_fn_legacy_nested' }),
            'unresolved view',
          );
          // A trigger that only assigns NEW.v = wb_fn_legacy() still writes MyISAM.
          assert.equal(
            await adapter.tableEngine({ schema: null, name: 'wb_fn_trig', events: ['INSERT'] }),
            'MyISAM (written by a trigger)',
          );
          // A lookup whose signal has aborted starts no query.
          await assert.rejects(adapter.tableEngine({ schema: null, name: 'wb_items' }, AbortSignal.abort()), {
            name: 'AbortError',
          });
          // A graph that branches at every level is resolved with one lookup per view, not per path
          // (2^5 paths here). Questions counts the statements the server received.
          const u = new URL(url);
          const root = await mysql.createConnection({
            host: u.hostname,
            port: Number(u.port),
            user: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password),
            ssl: { rejectUnauthorized: false },
          });
          try {
            const questions = async () => {
              const [rows] = await root.query("SHOW GLOBAL STATUS LIKE 'Questions'");
              return Number((rows as { Value: string }[])[0]?.Value);
            };
            const before = await questions();
            assert.equal(await adapter.tableEngine({ schema: null, name: 'wb_g5' }), 'InnoDB');
            const asked = (await questions()) - before - 1;
            // Two queries per view, plus the base table, its triggers and the session's grants (2).
            assert.ok(asked <= 2 * 16 + 4, `${asked} metadata queries`);
          } finally {
            await root.end();
          }
          assert.equal(await adapter.tableEngine({ schema: DATABASE, name: 'wb_items' }), 'InnoDB');
          const problems = await preflight(
            await analyzeScript(
              "UPDATE wb_items SET name = 'a' WHERE id = 0; INSERT INTO wb_legacy VALUES (2, 'y')",
              'mysql',
            ),
            {
              engine,
              transactionMode: 'atomic',
              readOnly: false,
              tableEngine: (t) => adapter.tableEngine(t),
            },
          );
          assert.deepEqual(
            problems.map((p) => [p.code, p.statement]),
            [['non_transactional_engine', 1]],
          );
        });
      }
    });

    describe('execution', () => {
      it('returns values as lossless text, binary as hex, and NULL as null', async () => {
        const sql =
          engine === 'postgresql'
            ? 'SELECT id, name, price, created_at, payload, raw, big, tags FROM wb_items ORDER BY id'
            : 'SELECT id, name, price, created_at, payload, raw, big, flag FROM wb_items ORDER BY id';
        const { sets, outcome } = await run(sql);
        assert.equal(outcome.resultSets, 1);
        assert.equal(outcome.affectedRows, null);
        const [result] = sets;
        assert.ok(result);
        assert.deepEqual(
          result.columns.map((c) => c.name),
          [
            'id',
            'name',
            'price',
            'created_at',
            'payload',
            'raw',
            'big',
            engine === 'postgresql' ? 'tags' : 'flag',
          ],
        );
        assert.deepEqual(
          result.columns.map((c) => c.binary),
          [false, false, false, false, false, true, false, engine === 'mysql'],
        );
        const [alpha, beta] = result.rows;
        if (engine === 'postgresql') {
          assert.deepEqual(alpha, [
            '1',
            'alpha',
            '12.50',
            '2026-01-02 03:04:05+00',
            '{"a": [1, 2]}',
            '\\x00ff10',
            '9007199254740993',
            '{x,"y z"}',
          ]);
          assert.equal(result.columns[3]?.type, 'timestamptz');
        } else {
          assert.deepEqual(alpha, [
            '1',
            'alpha',
            '12.50',
            '2026-01-02 03:04:05.000',
            '{"a": [1, 2]}',
            '\\x00ff10',
            '9007199254740993',
            '\\x01',
          ]);
          assert.equal(result.columns[2]?.type, 'NEWDECIMAL');
        }
        assert.deepEqual(beta?.slice(2), [
          null,
          '2026-01-02 03:04:05' + (engine === 'postgresql' ? '+00' : '.000'),
          null,
          null,
          null,
          null,
        ]);
      });

      it('streams in batches and stops when the sink has enough, leaving the session usable', async () => {
        await adapter.withSession(async (s) => {
          const { sets, sink } = collect(1001);
          const outcome = await s.execute('SELECT n FROM wb_numbers ORDER BY n', sink, {
            timeoutMs: 10_000,
            batchSize: 1001,
          });
          assert.equal(outcome.stopped, true);
          assert.equal(sets[0]?.rows.length, 1001);
          const after = collect();
          await s.execute('SELECT 42', after.sink, { timeoutMs: 5000 });
          assert.equal(after.sets[0]?.rows[0]?.[0], '42');
        });
      });

      it('recovers when storing captured rows fails mid-stream, in and out of a transaction', async () => {
        for (const inTransaction of [false, true]) {
          const started = Date.now();
          const next = await adapter.withSession(async (s) => {
            if (inTransaction) await s.begin({ readOnly: true });
            let batches = 0;
            const failing: ResultSink = {
              start: () => undefined,
              rows: () => {
                // The second batch cannot be stored (for example, the application database is full).
                if (++batches === 2) throw new Error('capture failed');
              },
            };
            await assert.rejects(
              s.execute('SELECT n FROM wb_numbers ORDER BY n', failing, {
                timeoutMs: 10_000,
                batchSize: 100,
              }),
              /capture failed/,
            );
            if (inTransaction) await s.rollback();
            const after = collect();
            await s.execute('SELECT 7', after.sink, { timeoutMs: 5000 });
            return after.sets[0]?.rows[0]?.[0];
          });
          assert.equal(next, '7', `the session works afterwards (transaction: ${inTransaction})`);
          assert.ok(Date.now() - started < 5000, 'nothing waited behind an open cursor');
        }
        assert.equal((await run('SELECT 1')).sets[0]?.rows[0]?.[0], '1');
      });

      if (engine === 'postgresql') {
        it('keeps the command and row count of a write whose rows end on a batch boundary', async () => {
          // RETURNING rows in batches of 100. The command tag of a fetch counts only that fetch's rows,
          // and 300 rows end exactly on a batch boundary.
          for (const [total, onStop] of [
            [300, 'cancel'],
            [300, 'drain'],
            [250, 'cancel'],
            [250, 'drain'],
          ] as const) {
            const update = `UPDATE wb_numbers SET n = n WHERE n <= ${total} RETURNING n`;
            const outcome = await adapter.withSession(async (s) => {
              await s.begin({ readOnly: false });
              try {
                const { sink } = collect(onStop === 'drain' ? 100 : undefined);
                return await s.execute(update, sink, { timeoutMs: 10_000, batchSize: 100, onStop });
              } finally {
                await s.rollback();
              }
            });
            assert.deepEqual(
              [outcome.command, outcome.affectedRows],
              ['UPDATE', total],
              `${total} ${onStop}`,
            );
          }
          // Reads that return rows under another command tag change nothing.
          for (const sql of ['EXPLAIN SELECT 1', 'SHOW search_path', 'SELECT 1', 'VALUES (1), (2)']) {
            const { outcome } = await run(sql);
            assert.equal(outcome.affectedRows, null, sql);
          }
        });
      }

      if (engine === 'postgresql') {
        it('lets a slow cancel request settle before the backend runs anything else', async () => {
          // The control connection answers late: the cancelled read stops at a batch boundary first.
          const original = adapter.cancel.bind(adapter);
          adapter.cancel = (id: number) =>
            new Promise((resolve) => setTimeout(() => resolve(original(id)), 1500));
          try {
            const next = await adapter.withSession(async (s) => {
              await s.begin({ readOnly: true });
              const controller = new AbortController();
              let batches = 0;
              const sink: ResultSink = {
                start: () => undefined,
                rows: () => {
                  if (++batches === 2) controller.abort();
                },
              };
              await assert.rejects(
                s.execute('SELECT n FROM generate_series(1, 1000000) n', sink, {
                  timeoutMs: 30_000,
                  batchSize: 100,
                  signal: controller.signal,
                }),
                { category: 'cancelled' },
              );
              await s.rollback();
              // Would be cancelled by the late request if it reached this statement.
              const after = collect();
              await s.execute('SELECT pg_sleep(2), 7', after.sink, { timeoutMs: 10_000 });
              return after.sets[0]?.rows[0]?.[1];
            });
            assert.equal(next, '7');
          } finally {
            adapter.cancel = original;
          }
        });
      }

      it('reports affected rows of writes', async () => {
        const { outcome } = await run("UPDATE wb_items SET name = name WHERE name = 'alpha'", {
          readOnly: false,
        });
        assert.equal(outcome.resultSets, 0);
        assert.equal(outcome.affectedRows, engine === 'postgresql' ? 1 : 1);
      });

      it('enforces the time limit and keeps the session usable', async () => {
        const slow = engine === 'postgresql' ? 'SELECT pg_sleep(5)' : 'SELECT SLEEP(5)';
        await adapter.withSession(async (s) => {
          const started = Date.now();
          await assert.rejects(s.execute(slow, collect().sink, { timeoutMs: 400 }), { category: 'timeout' });
          assert.ok(Date.now() - started < 3500);
          const after = collect();
          await s.execute('SELECT 1', after.sink, { timeoutMs: 5000 });
          assert.equal(after.sets[0]?.rows[0]?.[0], '1');
        });
      });

      it('cancels on request over the reserved control connection, even when all work slots are busy', async () => {
        const slow = engine === 'postgresql' ? 'SELECT pg_sleep(10)' : 'SELECT SLEEP(10)';
        const controller = new AbortController();
        const busy = adapter.withSession((s) =>
          s.execute(slow, collect().sink, { timeoutMs: 30_000, signal: controller.signal }),
        );
        const other = adapter.withSession((s) =>
          s.execute(engine === 'postgresql' ? 'SELECT pg_sleep(1)' : 'SELECT SLEEP(1)', collect().sink, {
            timeoutMs: 30_000,
          }),
        );
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(adapter.activeSessions(), 2);
        const started = Date.now();
        controller.abort();
        await assert.rejects(busy, { category: 'cancelled' });
        assert.ok(Date.now() - started < 3000);
        await other;
      });

      it('maps errors with codes and positions', async () => {
        await assert.rejects(run('SELECT * FROM no_such_table'), (error: unknown) => {
          assert.ok(error instanceof DbError);
          assert.equal(error.category, 'not_found');
          assert.equal(error.code, engine === 'postgresql' ? '42P01' : '1146');
          return true;
        });
        await assert.rejects(run('SELECT 1 FROM wb_items WHERE'), (error: unknown) => {
          assert.ok(error instanceof DbError);
          assert.equal(error.category, 'syntax');
          if (engine === 'postgresql') assert.equal(error.position?.offset, 28);
          else assert.equal(error.position?.line, 1);
          return true;
        });
        await assert.rejects(run("INSERT INTO wb_items (name) VALUES ('alpha')", { readOnly: false }), {
          category: 'constraint',
        });
      });

      it('collects notices and warnings', async () => {
        const { outcome } =
          engine === 'postgresql'
            ? await run("DO $$ BEGIN RAISE NOTICE 'hello from the server'; END $$")
            : await run("SELECT CAST('12abc' AS SIGNED)");
        assert.match(
          outcome.notices.join('\n'),
          engine === 'postgresql' ? /NOTICE: hello from the server/ : /1292/,
        );
      });

      if (engine === 'mysql') {
        it('returns every result set of a procedure', async () => {
          const { sets, outcome } = await run('CALL wb_proc()');
          assert.equal(outcome.resultSets, 2);
          assert.deepEqual(
            sets.map((s) => s.columns.map((c) => c.name)),
            [['one'], ['two', 'label']],
          );
          assert.deepEqual(sets[1]?.rows, [['2', 'x']]);
        });
      }

      it('discards a session marked dirty instead of reusing it', async () => {
        const first = await adapter.withSession(async (s) => {
          s.markDirty('changed session settings');
          return s.backendId;
        });
        const ids = await Promise.all([
          adapter.withSession(async (s) => s.backendId),
          adapter.withSession(async (s) => s.backendId),
        ]);
        assert.ok(!ids.includes(first));
      });
    });

    describe('metadata', () => {
      it('lists databases and schemas', async () => {
        const databases = await adapter.metadata.databases();
        assert.equal(databases.status, 'ok');
        assert.deepEqual(databases.items[0], {
          name: DATABASE,
          current: true,
          browsable: true,
          system: false,
        });
        const schemas = await adapter.metadata.schemas();
        const names = schemas.items.map((s) => s.name);
        assert.ok(names.includes(engine === 'postgresql' ? 'public' : DATABASE));
      });

      it('lists tables, views and routines with their kinds', async () => {
        const schema = engine === 'postgresql' ? 'public' : DATABASE;
        const objects = await adapter.metadata.objects(schema);
        assert.equal(objects.status, 'ok');
        const kinds = Object.fromEntries(objects.items.map((o) => [o.name, o.kind]));
        assert.equal(kinds.wb_items, 'table');
        assert.equal(kinds.wb_item_names, 'view');
        assert.equal(kinds.wb_item_count, 'function');
        assert.equal(kinds.wb_proc, 'procedure');
        if (engine === 'postgresql') {
          assert.equal(kinds.wb_item_stats, 'materialized_view');
          assert.equal(objects.items.find((o) => o.name === 'wb_add')?.signature, 'a integer, b integer');
        } else {
          assert.equal(objects.items.find((o) => o.name === 'wb_legacy')?.engine, 'MyISAM');
        }
        assert.equal(objects.items.find((o) => o.name === 'wb_items')?.comment, 'Items for tests');
      });

      it('describes a table: columns, keys, indexes and definition', async () => {
        const schema = engine === 'postgresql' ? 'public' : DATABASE;
        const items = await adapter.metadata.table(schema, 'wb_items');
        assert.ok(items);
        const name = items.columns.items.find((c) => c.name === 'name');
        assert.deepEqual([name?.nullable, name?.comment], [false, 'Display name']);
        assert.equal(items.columns.items[0]?.identity, engine === 'postgresql' ? null : 'auto_increment');
        assert.match(
          String(items.columns.items[0]?.default ?? ''),
          engine === 'postgresql' ? /nextval/ : /^$/,
        );
        const keyTypes = items.keys.items.map((k) => k.type);
        assert.deepEqual(keyTypes.slice(0, 2), ['primary', 'unique']);
        assert.ok(keyTypes.includes('check'));
        assert.ok(items.indexes.items.some((i) => i.primary));
        if (engine === 'postgresql') {
          assert.deepEqual(items.indexes.items.find((i) => i.name === 'wb_items_lower_name')?.columns, [
            'lower(name)',
            'COALESCE(price, 0::numeric)',
          ]);
          assert.equal(items.definition.reconstructed, true);
        }
        assert.match(String(items.definition.text), /CREATE TABLE/);
        if (engine === 'postgresql') {
          // Reserved words stay quoted: the reconstructed definition recreates the table.
          const reserved = await adapter.metadata.table(schema, 'wb_reserved');
          const ddl = String(reserved?.definition.text);
          assert.match(ddl, /"order" text/);
          const copy = ddl.replace('"wb_reserved"', '"wb_reserved_copy"');
          assert.equal((await run(copy)).outcome.resultSets, 0);
          await run('DROP TABLE wb_reserved_copy');
        }

        const orders = await adapter.metadata.table(schema, 'wb_orders');
        const fk = orders?.keys.items.find((k) => k.type === 'foreign');
        assert.deepEqual(fk?.references, { schema, table: 'wb_items', columns: ['id'] });
        assert.deepEqual(fk?.columns, ['item_id']);
        if (engine === 'postgresql') {
          assert.equal(orders?.columns.items.find((c) => c.name === 'id')?.identity, 'always');
          assert.equal(orders?.columns.items.find((c) => c.name === 'total')?.generated, '(qty * 2)');
        }

        const view = await adapter.metadata.table(schema, 'wb_item_names');
        assert.equal(view?.kind, 'view');
        assert.match(String(view?.definition.text), /wb_items/);
        assert.equal(await adapter.metadata.table(schema, 'no_such_table'), null);
      });

      it('returns routine definitions', async () => {
        const schema = engine === 'postgresql' ? 'public' : DATABASE;
        const def = await adapter.metadata.routine(schema, 'wb_item_count');
        assert.equal(def.status, 'ok');
        assert.match(String(def.text), /count\(\*\)/i);
        assert.equal((await adapter.metadata.routine(schema, 'no_such_routine')).status, 'unavailable');
      });

      it('reports insufficient permission instead of an empty list', async () => {
        const reader = await registry.get({
          ...target({ id: `cn_reader_${engine}`, username: READER.username, password: READER.password }),
          updatedAt: 'v1',
        });
        if (engine === 'postgresql') {
          const restricted = await reader.metadata.objects('restricted');
          assert.equal(restricted.status, 'insufficient_permission');
          assert.deepEqual(
            restricted.items.map((o) => o.name),
            ['secret'],
          );
          const schemas = await reader.metadata.schemas();
          assert.equal(schemas.items.find((s) => s.name === 'restricted')?.usable, false);
          assert.equal((await reader.metadata.objects('no_such_schema')).status, 'unavailable');
        } else {
          // Without SHOW VIEW the view definition is withheld; without routine privileges MySQL hides the routine.
          const view = await reader.metadata.table(DATABASE, 'wb_item_names');
          assert.equal(view?.definition.status, 'insufficient_permission');
          const routine = await reader.metadata.routine(DATABASE, 'wb_proc');
          assert.equal(routine.status, 'unavailable');
          assert.match(String(routine.reason), /no privileges/);
          const hidden = await reader.metadata.objects('mysql');
          assert.equal(hidden.status, 'unavailable');
          assert.match(String(hidden.reason), /no privileges/);
        }
      });
    });

    it('classifies statements the same way the analysis module does for this engine', async () => {
      // Guards against drift between the corpus and the analyzer used by the executor.
      for (const entry of engine === 'postgresql' ? POSTGRES_CORPUS : MYSQL_CORPUS) {
        assert.equal((await analyzeStatement(entry.sql, engine)).readOnlySafe, entry.safe, entry.sql);
      }
    });
  });
}

describe('database service through core', { skip: skipUnless('POSTGRES_TEST_URL') }, () => {
  it('tests a stored connection, records the result and audits it without the password', async () => {
    const { createCore, loadConfig } = await import('@workbench/core');
    const config = loadConfig({
      PUBLIC_URL: 'https://db.example.test',
      KEYCLOAK_ISSUER: 'https://auth.example.test/realms/workbench',
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    const core = createCore({
      databaseFile: ':memory:',
      encryptionKey: config.encryptionKey,
      limits: config.limits,
    });
    const admin = {
      subject: 'admin',
      username: 'admin',
      displayName: 'Admin',
      roles: ['query:read', 'admin'] as ['query:read', 'admin'],
      source: 'gui' as const,
      clientId: 'workbench-gui',
    };
    core.users.touch(admin);
    const t = targetFrom(String(process.env.POSTGRES_TEST_URL), 'postgresql');
    const connection = core.connections.create(admin, {
      name: 'Integration',
      engine: 'postgresql',
      environment: 'development',
      host: t.host,
      port: t.port,
      database: t.database,
      schema: 'public',
      username: t.username,
      password: t.password,
      tlsMode: 'verify-full',
      caPem: t.caPem,
      readOnly: true,
    });
    try {
      const report = await core.databases.test(admin, connection.id);
      assert.equal(report.ok, true);
      const stored = core.connections.get(admin, connection.id);
      assert.equal((stored.lastTestResult as { ok: boolean }).ok, true);
      const [event] = core.audit.list(admin, { actionPrefix: 'connection.test' });
      assert.equal(event?.outcome, 'succeeded');
      assert.doesNotMatch(JSON.stringify([stored, event]), new RegExp(t.password));

      const adapter = await core.databases.adapter(admin, connection.id);
      const rows = await adapter.withSession(async (s) => {
        const { sets, sink } = collect();
        await s.execute('SELECT current_user', sink, { timeoutMs: 5000 });
        return sets[0]?.rows;
      });
      assert.deepEqual(rows, [[t.username]]);
      // A changed configuration replaces the adapter and its pools.
      core.connections.update(admin, connection.id, { name: 'Integration renamed' });
      assert.notEqual(await core.databases.adapter(admin, connection.id), adapter);
    } finally {
      await core.shutdown();
    }
  });
});
