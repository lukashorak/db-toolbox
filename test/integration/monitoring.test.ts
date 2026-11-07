/**
 * Monitoring against PostgreSQL 16 and MySQL 8.4 (AC12): a second client creates real lock waits,
 * this tool's sessions carry their execution ID, counters turn into rates, and missing extensions
 * or privileges show as limited or unavailable — never as zero.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { createCore, loadConfig, type Actor, type Core, type Engine } from '@workbench/core';
import { prepareMysql, preparePostgres, READER, targetFrom } from '../support/databases.js';
import { skipUnless } from '../support/services.js';

const operator: Actor = {
  subject: 'operator',
  username: 'operator',
  displayName: 'Operator',
  roles: ['query:read', 'query:write', 'monitor:read', 'admin'],
  source: 'gui',
  clientId: 'workbench-gui',
};

const until = async (check: () => Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 200));
  }
};

/** A second client outside the workbench, to hold locks. */
async function rawClient(engine: Engine, url: string) {
  const t = targetFrom(url, engine);
  if (engine === 'postgresql') {
    const c = new pg.Client({
      host: t.host,
      port: t.port,
      user: t.username,
      password: t.password,
      database: t.database,
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    const pid = Number((await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    return { id: String(pid), query: (sql: string) => c.query(sql), close: () => c.end() };
  }
  const c = await mysql.createConnection({
    host: t.host,
    port: t.port,
    user: t.username,
    password: t.password,
    database: t.database,
    ssl: { rejectUnauthorized: false },
  });
  return { id: String(c.threadId), query: (sql: string) => c.query(sql), close: () => c.end() };
}

for (const { engine, variable, prepare } of [
  { engine: 'postgresql' as Engine, variable: 'POSTGRES_TEST_URL', prepare: preparePostgres },
  { engine: 'mysql' as Engine, variable: 'MYSQL_TEST_URL', prepare: prepareMysql },
]) {
  describe(`${engine} monitoring`, { skip: skipUnless(variable) }, () => {
    const url = String(process.env[variable]);
    let core: Core;
    const ids: Record<string, string> = {};
    const connect = (name: string, extra: Record<string, unknown> = {}) => {
      const t = targetFrom(url, engine);
      return core.connections.create(operator, {
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
        readOnly: false,
        ...extra,
      }).id;
    };

    before(async () => {
      await prepare(url);
      const config = loadConfig({
        PUBLIC_URL: 'https://db.example.test',
        KEYCLOAK_ISSUER: 'https://auth.example.test/realms/workbench',
        ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('base64'),
      });
      core = createCore({
        databaseFile: ':memory:',
        encryptionKey: config.encryptionKey,
        limits: config.limits,
      });
      core.users.touch(operator);
      ids.admin = connect('Admin account');
      ids.reader = connect('Reader account', { username: READER.username, password: READER.password });
      const t = targetFrom(url, engine);
      ids.withMonitor = connect('Reader with monitoring account', {
        username: READER.username,
        password: READER.password,
        monitorUsername: t.username,
        monitorPassword: t.password,
      });
    });
    after(() => core.shutdown());

    it('shows a lock wait between two outside sessions, with both queries', async () => {
      const holder = await rawClient(engine, url);
      const waiter = await rawClient(engine, url);
      try {
        await holder.query(engine === 'postgresql' ? 'BEGIN' : 'START TRANSACTION');
        await holder.query("UPDATE wb_items SET price = 5 WHERE name = 'alpha'");
        const blocked = waiter
          .query("UPDATE wb_items SET price = 6 WHERE name = 'alpha'")
          .catch(() => undefined);
        let found;
        await until(async () => {
          await new Promise((r) => setTimeout(r, 2100));
          const snapshot = await core.monitoring.activity(operator, ids.admin as string);
          found = snapshot.lockWaits.items.find((w) => w.waiting === waiter.id);
          return Boolean(found);
        });
        assert.equal(found!.blocking, holder.id);
        assert.match(String(found!.waitingQuery), /price = 6/);
        const snapshot = await core.monitoring.activity(operator, ids.admin as string);
        assert.equal(snapshot.lockWaits.availability, 'available');
        assert.deepEqual(snapshot.sessions.items.find((s) => s.id === waiter.id)?.blockedBy, [holder.id]);
        await holder.query('ROLLBACK');
        await blocked;
      } finally {
        await holder.close();
        await waiter.close();
      }
    });

    it('tags sessions of this tool with their execution ID', async () => {
      const sleep = engine === 'postgresql' ? 'SELECT pg_sleep(3)' : 'SELECT SLEEP(3)';
      const view = await core.executions.submit(operator, { connectionId: ids.admin as string, sql: sleep });
      let tagged;
      await until(async () => {
        await new Promise((r) => setTimeout(r, 2100));
        tagged = (await core.monitoring.activity(operator, ids.admin as string)).sessions.items.find(
          (s) => s.executionId === view.id,
        );
        return Boolean(tagged);
      });
      assert.ok(tagged);
      await core.executions.idle();
    });

    it('turns counters into rates and bounds polling', async () => {
      const first = await core.monitoring.activity(operator, ids.admin as string);
      const again = await core.monitoring.activity(operator, ids.admin as string);
      assert.equal(
        again.capturedAt,
        first.capturedAt,
        'a second call within the interval reuses the snapshot',
      );
      await new Promise((r) => setTimeout(r, 2100));
      const next = await core.monitoring.activity(operator, ids.admin as string);
      const counters = next.counters.data!;
      assert.equal(counters.reset, false);
      assert.ok(counters.intervalSeconds && counters.intervalSeconds >= 2);
      const key = engine === 'postgresql' ? 'xact_commit' : 'questions';
      assert.equal(typeof counters.perSecond[key], 'number');
      if (engine === 'postgresql') {
        await new Promise((r) => setTimeout(r, 2100));
        const raw = await rawClient(engine, url);
        await raw.query('SELECT pg_stat_reset()');
        await raw.close();
        await new Promise((r) => setTimeout(r, 600));
        const afterReset = await core.monitoring.activity(operator, ids.admin as string);
        assert.equal(afterReset.counters.data?.reset, true);
        assert.equal(afterReset.counters.data?.perSecond.xact_commit, null, 'no rate across a reset');
      }
    });

    it('reports statement statistics, or why they are unavailable', async () => {
      const stats = await core.monitoring.statements(operator, ids.admin as string);
      if (engine === 'postgresql') {
        assert.equal(stats.availability, 'unavailable');
        assert.match(String(stats.reason), /pg_stat_statements is not installed/);
        assert.deepEqual(stats.items, []);
      } else {
        assert.equal(stats.availability, 'available');
        assert.ok(stats.items.length > 0);
        assert.ok(stats.items.every((s) => s.calls > 0 && s.totalMs >= 0));
      }
    });

    it('shows limited visibility for an account without monitoring rights, never zeros', async () => {
      const holder = await rawClient(engine, url);
      try {
        await holder.query(engine === 'postgresql' ? 'SELECT pg_sleep(0.1)' : 'SELECT SLEEP(0.1)');
        const snapshot = await core.monitoring.activity(operator, ids.reader as string);
        assert.equal(snapshot.account, READER.username);
        assert.equal(snapshot.sessions.availability, 'limited');
        assert.ok(snapshot.sessions.reason);
        if (engine === 'postgresql') {
          const other = snapshot.sessions.items.find((s) => s.id === holder.id);
          assert.ok(other, 'other sessions are listed');
          assert.deepEqual(
            [other.query, other.queryVisible],
            [null, false],
            'their queries are hidden, not empty',
          );
        } else {
          assert.equal(snapshot.lockWaits.availability, 'unavailable');
          assert.equal(
            snapshot.sessions.items.some((s) => s.id === holder.id),
            false,
          );
          assert.equal(
            (await core.monitoring.statements(operator, ids.reader as string)).availability,
            'unavailable',
          );
        }
      } finally {
        await holder.close();
      }
    });

    it('uses the separate monitoring account when configured', async () => {
      const snapshot = await core.monitoring.activity(operator, ids.withMonitor as string);
      assert.equal(snapshot.account, targetFrom(url, engine).username);
      assert.equal(snapshot.sessions.availability, 'available');
      const view = core.connections.get(operator, ids.withMonitor as string);
      assert.equal(view.monitorUsername, targetFrom(url, engine).username);
      assert.doesNotMatch(JSON.stringify(view), /workbench-it/);
    });

    it('requires the monitor:read role', async () => {
      const reader: Actor = { ...operator, subject: 'reader', roles: ['query:read'] };
      core.users.touch(reader);
      await assert.rejects(core.monitoring.activity(reader, ids.admin as string), { code: 'forbidden' });
    });
  });
}
