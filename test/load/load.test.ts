/**
 * Load sanity (step 14), against PostgreSQL 16 and MySQL 8.4 with a table of one million rows:
 * a preview that stops reading early, a full capture and CSV export with bounded memory,
 * concurrent executions on one connection that respect the per-connection limit in order, and
 * cancellation of a large capture.
 *
 *   npm run test:load   (needs POSTGRES_TEST_URL and/or MYSQL_TEST_URL)
 */
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, it } from 'node:test';
import {
  createCore,
  loadConfig,
  type Actor,
  type Core,
  type Engine,
  type ExecutionView,
} from '@workbench/core';
import { targetFrom } from '../support/databases.js';
import { skipUnless } from '../support/services.js';

const ROWS = 1_000_000;
const owner: Actor = {
  subject: 'load',
  username: 'load',
  displayName: 'Load',
  roles: ['query:read', 'query:write', 'admin'],
  source: 'gui',
  clientId: 'workbench-gui',
};

async function settle(core: Core, id: string, timeoutMs = 120_000): Promise<ExecutionView> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const view = core.executions.view(id);
    if (!['queued', 'running', 'cancel_requested'].includes(view.status)) return view;
    if (Date.now() > end) throw new Error(`execution ${id} still ${view.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Samples the heap while `work` runs and returns the peak growth in MiB. */
async function peakHeapGrowth(work: () => Promise<void>): Promise<number> {
  global.gc?.();
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().heapUsed)), 20);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
  return (peak - base) / 1024 / 1024;
}

const SETUP: Record<Engine, string> = {
  postgresql: `DROP TABLE IF EXISTS wb_million;
    CREATE TABLE wb_million AS SELECT n, md5(n::text) AS label FROM generate_series(1, ${ROWS}) AS n;
    ANALYZE wb_million`,
  mysql: `DROP TABLE IF EXISTS wb_million;
    CREATE TABLE wb_million (n INT PRIMARY KEY, label CHAR(32) CHARACTER SET ascii NOT NULL);
    INSERT INTO wb_million
      SELECT n, md5(n) FROM (
        SELECT a.d + b.d * 10 + c.d * 100 + e.d * 1000 + f.d * 10000 + g.d * 100000 + 1 AS n
        FROM (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a,
             (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b,
             (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c,
             (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e,
             (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) f,
             (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) g
      ) AS numbers`,
};

for (const { engine, variable } of [
  { engine: 'postgresql' as Engine, variable: 'POSTGRES_TEST_URL' },
  { engine: 'mysql' as Engine, variable: 'MYSQL_TEST_URL' },
]) {
  describe(`${engine} under load`, { skip: skipUnless(variable) }, () => {
    const url = String(process.env[variable]);
    const sleep = (s: number) => (engine === 'postgresql' ? `SELECT pg_sleep(${s})` : `SELECT SLEEP(${s})`);
    let dir: string;
    let core: Core;
    let connection: string;
    const submit = (sql: string, extra: Partial<Parameters<Core['executions']['submit']>[1]> = {}) =>
      core.executions.submit(owner, { connectionId: connection, sql, ...extra });

    before(async () => {
      dir = await mkdtemp(join(tmpdir(), `workbench-load-${engine}-`));
      const config = loadConfig({
        PUBLIC_URL: 'https://db.example.test',
        KEYCLOAK_ISSUER: 'https://auth.example.test/realms/workbench',
        ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        CONCURRENCY_PER_CONNECTION: '2',
        ORDINARY_TIMEOUT_MS: '300000',
        FULL_TIMEOUT_MAX_MS: '600000',
      });
      core = createCore({
        databaseFile: join(dir, 'workbench.sqlite'),
        encryptionKey: config.encryptionKey,
        limits: config.limits,
        exportDir: join(dir, 'exports'),
      });
      core.users.touch(owner);
      const t = targetFrom(url, engine);
      connection = core.connections.create(owner, {
        name: 'Load',
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
      const setup = await settle(core, (await submit(SETUP[engine], { timeoutMs: 300_000 })).id, 300_000);
      assert.equal(setup.status, 'succeeded', JSON.stringify(setup.error));
    });
    after(async () => {
      await core?.shutdown();
      await rm(dir, { recursive: true, force: true });
    });

    it('previews a million-row table quickly, without reading it all', async () => {
      const started = Date.now();
      const view = await settle(core, (await submit('SELECT n, label FROM wb_million ORDER BY n')).id);
      const ms = Date.now() - started;
      assert.equal(view.status, 'succeeded');
      assert.deepEqual(
        [view.resultSets[0]?.rowCount, view.resultSets[0]?.completeness],
        [1000, 'preview_limited'],
      );
      assert.ok(ms < 5000, `preview took ${ms} ms`);
    });

    it('captures and exports a million rows completely with bounded memory', async () => {
      let view: ExecutionView | undefined;
      let file = '';
      const growth = await peakHeapGrowth(async () => {
        view = await settle(
          core,
          (
            await submit('SELECT n, label FROM wb_million ORDER BY n', {
              captureMode: 'full',
              timeoutMs: 300_000,
            })
          ).id,
          300_000,
        );
        assert.equal(view.status, 'succeeded', JSON.stringify(view.error));
        assert.deepEqual(
          [view.resultSets[0]?.rowCount, view.resultSets[0]?.completeness],
          [ROWS, 'complete'],
        );
        const created = await core.exports.create(owner, view.id, 0, { format: 'csv' });
        await core.exports.idle();
        const ready = core.exports.get(owner, created.id);
        assert.equal(ready.status, 'ready');
        file = (await core.exports.download(owner, created.id)).path;
      });
      let lines = 0;
      for await (const _ of createInterface({ input: createReadStream(file) })) lines++;
      assert.equal(lines, ROWS + 1, 'header and one line per row');
      // About 45 MB of rows passed through: memory stays far below that.
      assert.ok(growth < 160, `heap grew by ${growth.toFixed(0)} MiB`);
    });

    it('runs ten concurrent executions on one connection, at most two at a time, first in first out', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push((await submit(`${sleep(0.3)}`, { title: `job ${i}` })).id);
      let maxRunning = 0;
      const started: string[] = [];
      for (;;) {
        const views = ids.map((id) => core.executions.view(id));
        const running = views.filter((v) => v.status === 'running');
        maxRunning = Math.max(maxRunning, running.length);
        for (const v of running) if (!started.includes(v.id)) started.push(v.id);
        if (views.every((v) => v.status === 'succeeded')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(maxRunning, 2);
      const startOrder = ids
        .map((id) => core.executions.view(id))
        .sort(
          (a, b) =>
            Date.parse(String(a.startedAt)) - Date.parse(String(b.startedAt)) ||
            ids.indexOf(a.id) - ids.indexOf(b.id),
        )
        .map((v) => ids.indexOf(v.id));
      assert.deepEqual(startOrder, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });

    it('stops a long streaming capture at its time limit', async () => {
      const started = Date.now();
      const view = await settle(
        core,
        (
          await submit('SELECT a.n, a.label FROM wb_million a CROSS JOIN (SELECT 1 UNION ALL SELECT 2) b', {
            captureMode: 'full',
            timeoutMs: 1000,
          })
        ).id,
      );
      // PostgreSQL's statement_timeout counts per fetch, so the workbench's own limit has to apply.
      assert.equal(view.status, 'timed_out');
      assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
      assert.notEqual(view.resultSets[0]?.completeness, 'complete');
      await core.exports.deleteResults(owner, view.id);
    });

    it('cancels a large capture promptly and frees its storage', async () => {
      const storedBefore = core.executions.storedBytes;
      const view = await submit(
        'SELECT a.n, a.label FROM wb_million a CROSS JOIN (SELECT 1 UNION ALL SELECT 2) b',
        {
          captureMode: 'full',
          timeoutMs: 300_000,
        },
      );
      // Two million rows take a few seconds to capture; cancel half a second into it.
      const end = Date.now() + 30_000;
      while (core.executions.view(view.id).statements[0]?.status !== 'running') {
        if (Date.now() > end) throw new Error('capture did not start');
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 500));
      const started = Date.now();
      await core.executions.cancel(owner, view.id);
      const done = await settle(core, view.id);
      assert.ok(Date.now() - started < 5000, `cancel took ${Date.now() - started} ms`);
      assert.equal(done.status, 'cancelled');
      assert.notEqual(done.resultSets[0]?.completeness, 'complete');
      assert.ok(core.executions.storedBytes > storedBefore, 'the partial capture is kept until deleted');
      await core.exports.deleteResults(owner, view.id);
      assert.equal(core.executions.storedBytes, storedBefore, 'deleting it frees its storage');
      const next = await settle(core, (await submit('SELECT 1')).id);
      assert.equal(next.status, 'succeeded', 'the connection still works');
    });
  });
}
