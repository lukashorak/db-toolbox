import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCore, type Core } from '../src/core.js';
import { AppError } from '../src/domain/errors.js';
import { actor, admin, limits, pgInput, reader, steppingClock, TEST_KEY, writer } from './helpers.js';

/** A core whose scheduler never starts anything, so queued state can be inspected. */
function pausedCore(): { core: Core; connection: string; readOnly: string } {
  const core = createCore({
    databaseFile: ':memory:',
    encryptionKey: TEST_KEY,
    limits,
    clock: steppingClock(),
    executions: { globalCap: 0 },
  });
  for (const a of [admin, writer, reader]) core.users.touch(a);
  const connection = core.connections.create(admin, { ...pgInput, name: 'Writable', readOnly: false }).id;
  const readOnly = core.connections.create(admin, { ...pgInput, name: 'Read only', readOnly: true }).id;
  return { core, connection, readOnly };
}

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

describe('execution submission', () => {
  it('stores the execution and its statements before acknowledging', async () => {
    const { core, connection } = pausedCore();
    const view = await core.executions.submit(writer, {
      connectionId: connection,
      sql: 'SELECT 1;\nUPDATE t SET a = 1',
      requestKey: 'key-00000001',
    });
    assert.equal(view.status, 'queued');
    assert.equal(view.sql, 'SELECT 1;\nUPDATE t SET a = 1');
    assert.equal(view.transactionOutcome, 'not_started');
    assert.deepEqual(
      view.statements.map((s) => [s.kind, s.command, s.range.startLine, s.status]),
      [
        ['read', 'SELECT', 1, 'not_run'],
        ['write', 'UPDATE', 2, 'not_run'],
      ],
    );
    assert.equal(view.readOnly, false);
    assert.equal(view.timeoutMs, limits.ordinaryTimeoutMs);
    assert.equal(core.audit.list(admin, { actionPrefix: 'execution.submit' })[0]?.outcome, 'accepted');
    core.close();
  });

  it('is idempotent per request key and refuses a changed payload', async () => {
    const { core, connection } = pausedCore();
    const first = await core.executions.submit(writer, {
      connectionId: connection,
      sql: 'SELECT 1',
      requestKey: 'key-00000002',
    });
    const again = await core.executions.submit(writer, {
      connectionId: connection,
      sql: 'SELECT 1',
      requestKey: 'key-00000002',
    });
    assert.equal(again.id, first.id);
    await assert.rejects(
      core.executions.submit(writer, {
        connectionId: connection,
        sql: 'SELECT 1',
        requestKey: 'key-00000002',
        captureMode: 'full',
      }),
      code('idempotency_conflict'),
    );
    // Keys are per owner.
    const other = await core.executions.submit(admin, {
      connectionId: connection,
      sql: 'SELECT 1',
      requestKey: 'key-00000002',
    });
    assert.notEqual(other.id, first.id);
    core.close();
  });

  it('records a preflight rejection with its problems and never queues it', async () => {
    const { core, readOnly } = pausedCore();
    const view = await core.executions.submit(writer, {
      connectionId: readOnly,
      sql: 'select 1; delete from t',
    });
    assert.equal(view.status, 'preflight_rejected');
    assert.deepEqual(view.policySources, ['connection']);
    const detail = view.error?.detail as { problems: { code: string; statement: number }[] };
    assert.deepEqual(
      detail.problems.map((p) => [p.code, p.statement]),
      [['read_only_violation', 1]],
    );
    assert.ok(view.finishedAt);
    assert.equal(core.audit.list(admin, { actionPrefix: 'execution.submit' })[0]?.outcome, 'denied');
    core.close();
  });

  it('applies the user layer: a reader cannot write even on a writable connection', async () => {
    const { core, connection } = pausedCore();
    const view = await core.executions.submit(reader, {
      connectionId: connection,
      sql: 'update t set a = 1',
    });
    assert.equal(view.status, 'preflight_rejected');
    assert.deepEqual(view.policySources, ['user']);
    core.close();
  });

  it('bounds the timeout by capture mode', async () => {
    const { core, connection } = pausedCore();
    await assert.rejects(
      core.executions.submit(writer, {
        connectionId: connection,
        sql: 'SELECT 1',
        timeoutMs: limits.ordinaryTimeoutMs + 1,
      }),
      code('validation_failed'),
    );
    const full = await core.executions.submit(writer, {
      connectionId: connection,
      sql: 'SELECT 1',
      captureMode: 'full',
      timeoutMs: limits.fullTimeoutMaxMs,
    });
    assert.equal(full.timeoutMs, limits.fullTimeoutMaxMs);
    core.close();
  });

  it('limits MCP to its profile: connections, timeout and read-only', async () => {
    const { core, connection, readOnly } = pausedCore();
    const profile = core.profiles.create(admin, {
      name: 'Claude',
      clientId: 'workbench-mcp',
      connectionIds: [connection],
      readOnly: true,
      timeoutMs: 5000,
    });
    const mcp = actor('writer', ['query:read', 'query:write'], {
      source: 'mcp',
      clientId: 'workbench-mcp',
      profileId: profile.id,
    });
    await assert.rejects(
      core.executions.submit(mcp, { connectionId: readOnly, sql: 'SELECT 1' }),
      code('forbidden'),
    );
    const view = await core.executions.submit(mcp, { connectionId: connection, sql: 'SELECT 1' });
    assert.deepEqual([view.timeoutMs, view.profile?.name, view.source], [5000, 'Claude', 'mcp']);
    const write = await core.executions.submit(mcp, { connectionId: connection, sql: 'UPDATE t SET a = 1' });
    assert.deepEqual([write.status, write.policySources], ['preflight_rejected', ['profile']]);
    core.close();
  });

  it('shows executions to their owner and to administrators only', async () => {
    const { core, connection } = pausedCore();
    const view = await core.executions.submit(writer, { connectionId: connection, sql: 'SELECT 1' });
    assert.throws(() => core.executions.get(reader, view.id), code('not_found'));
    assert.equal(core.executions.get(admin, view.id).id, view.id);
    assert.deepEqual(
      core.executions.list(writer).map((e) => e.id),
      [view.id],
    );
    assert.deepEqual(core.executions.list(reader), []);
    core.close();
  });

  it('reports queue position and cancels queued work immediately', async () => {
    const { core, connection } = pausedCore();
    const a = await core.executions.submit(writer, { connectionId: connection, sql: 'SELECT 1' });
    const b = await core.executions.submit(writer, { connectionId: connection, sql: 'SELECT 2' });
    assert.equal(core.executions.view(a.id).queue?.position, 1);
    assert.equal(core.executions.view(b.id).queue?.position, 2);
    assert.match(String(core.executions.view(b.id).queue?.reason), /maximum of 0 executions/);
    const cancelled = core.executions.cancel(writer, a.id);
    assert.deepEqual([cancelled.status, cancelled.transactionOutcome], ['cancelled', 'not_started']);
    assert.equal(core.executions.view(b.id).queue?.position, 1);
    assert.throws(() => core.executions.cancel(reader, b.id), code('not_found'));
    core.close();
  });
});

describe('restart reconciliation and retention', () => {
  it('marks in-flight work interrupted with honest outcomes and leaves queued work queued', async () => {
    const { core, connection } = pausedCore();
    const perStatement = await core.executions.submit(writer, {
      connectionId: connection,
      sql: 'insert into t values (1); update t set a = 2',
    });
    const atomicCommitting = await core.executions.submit(writer, {
      connectionId: connection,
      sql: 'insert into t values (1)',
      transactionMode: 'atomic',
    });
    const atomicRunning = await core.executions.submit(writer, {
      connectionId: connection,
      sql: 'insert into t values (1)',
      transactionMode: 'atomic',
    });
    const queued = await core.executions.submit(writer, { connectionId: connection, sql: 'SELECT 1' });
    const db = core.db;
    db.run("UPDATE executions SET status = 'running' WHERE id IN (:a, :b, :c)", {
      a: perStatement.id,
      b: atomicCommitting.id,
      c: atomicRunning.id,
    });
    db.run(
      "UPDATE statements SET status = 'succeeded', transaction_outcome = 'committed' WHERE execution_id = :id AND ordinal = 0",
      {
        id: perStatement.id,
      },
    );
    db.run("UPDATE statements SET status = 'running' WHERE execution_id = :id AND ordinal = 1", {
      id: perStatement.id,
    });
    db.run("UPDATE executions SET transaction_outcome = 'unknown' WHERE id = :id", {
      id: atomicCommitting.id,
    });

    assert.deepEqual(core.executions.reconcile(), { interrupted: 3, queued: 1 });
    const ps = core.executions.view(perStatement.id);
    assert.deepEqual([ps.status, ps.transactionOutcome], ['interrupted', 'unknown']);
    assert.deepEqual(
      ps.statements.map((s) => [s.status, s.transactionOutcome]),
      [
        ['succeeded', 'committed'],
        ['interrupted', 'unknown'],
      ],
    );
    assert.equal(core.executions.view(atomicCommitting.id).transactionOutcome, 'unknown');
    assert.equal(core.executions.view(atomicRunning.id).transactionOutcome, 'rolled_back');
    assert.match(String(ps.statusNote), /not run again/);
    assert.equal(core.executions.view(queued.id).status, 'queued');
    core.close();
  });

  it('keeps chunks captured before a crash countable, readable and expiring', async () => {
    const { core, connection } = pausedCore();
    const view = await core.executions.submit(writer, { connectionId: connection, sql: 'SELECT n FROM t' });
    const db = core.db;
    db.run("UPDATE executions SET status = 'running' WHERE id = :id", { id: view.id });
    db.run("UPDATE statements SET status = 'running' WHERE execution_id = :id", { id: view.id });
    // As a crash leaves it: chunks flushed, the result set still 'capturing' with zero counts.
    db.run(
      `INSERT INTO result_sets (execution_id, result_index, statement, columns, completeness, captured_at)
       VALUES (:id, 0, 0, '[{"name":"n","type":"int4","binary":false}]', 'capturing', '2026-11-07T10:00:00.000Z')`,
      { id: view.id },
    );
    for (const [chunk, start] of [
      [0, 0],
      [1, 2],
    ] as const)
      db.run(
        `INSERT INTO result_chunks (execution_id, result_index, chunk_index, row_start, row_count, byte_count, data)
         VALUES (:id, 0, :chunk, :start, 2, 12, :data)`,
        {
          id: view.id,
          chunk,
          start,
          data: Buffer.from(JSON.stringify([[String(start + 1)], [String(start + 2)]])),
        },
      );
    const storedBefore = core.executions.storedBytes;
    core.executions.reconcile();
    const [set] = core.executions.view(view.id).resultSets;
    assert.deepEqual([set?.completeness, set?.rowCount, set?.byteCount], ['interrupted', 4, 24]);
    const stored = db.get('SELECT expires_at FROM result_sets WHERE execution_id = :id', { id: view.id });
    assert.ok(stored?.expires_at, 'cleanup can expire it');
    assert.equal(core.executions.storedBytes, storedBefore + 24, 'counted in the storage quota');
    assert.deepEqual(
      core.executions.rows(writer, view.id, 0).rows.map((r) => r[0]),
      ['1', '2', '3', '4'],
    );
    core.close();
  });

  it('pages through executions submitted in the same millisecond without skipping any', async () => {
    const at = new Date(Date.UTC(2026, 10, 8, 9));
    const core = createCore({
      databaseFile: ':memory:',
      encryptionKey: TEST_KEY,
      limits,
      clock: { now: () => at },
      executions: { globalCap: 0 },
    });
    core.users.touch(admin);
    core.users.touch(writer);
    const connection = core.connections.create(admin, { ...pgInput, name: 'Same ms' }).id;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await core.executions.submit(writer, { connectionId: connection, sql: `SELECT ${i}` })).id);
    const seen: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = core.executions.list(writer, { limit: 1, ...(before ? { before } : {}) });
      if (!page.length) break;
      seen.push(page[0]!.id);
      before = page[0]!.id;
    }
    assert.deepEqual(seen, [...ids].reverse());
    core.close();
  });

  it('rechecks read-only safety at dispatch, not only the statement kind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workbench-dispatch-'));
    try {
      const file = join(dir, 'workbench.sqlite');
      const paused = createCore({
        databaseFile: file,
        encryptionKey: TEST_KEY,
        limits,
        executions: { globalCap: 0 },
      });
      for (const a of [admin, writer]) paused.users.touch(a);
      const connection = paused.connections.create(admin, {
        ...pgInput,
        name: 'Tightened',
        readOnly: false,
      }).id;
      // A read by kind that a read-only transaction does not stop.
      const queued = await paused.executions.submit(writer, {
        connectionId: connection,
        sql: 'SELECT pg_terminate_backend(42)',
      });
      assert.equal(queued.status, 'queued');
      paused.connections.update(admin, connection, { readOnly: true });
      paused.close();

      const running = createCore({ databaseFile: file, encryptionKey: TEST_KEY, limits });
      running.executions.reconcile();
      running.executions.resume();
      const view = running.executions.view(queued.id);
      assert.equal(view.status, 'rejected');
      assert.match(String(view.error?.message), /became read-only/);
      await running.shutdown();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses rows past their retention even before cleanup runs', async () => {
    const { core, connection } = pausedCore();
    const view = await core.executions.submit(writer, { connectionId: connection, sql: 'SELECT n FROM t' });
    core.db.run("UPDATE executions SET status = 'succeeded' WHERE id = :id", { id: view.id });
    core.db.run(
      `INSERT INTO result_sets (execution_id, result_index, statement, columns, row_count, byte_count, completeness, expires_at)
       VALUES (:id, 0, 0, '[]', 0, 0, 'complete', '2000-01-01T00:00:00.000Z')`,
      { id: view.id },
    );
    assert.throws(() => core.executions.rows(writer, view.id, 0), code('result_expired'));
    core.close();
  });

  it('returns the same execution for overlapping submissions with one request key', async () => {
    const { core, connection } = pausedCore();
    const input = { connectionId: connection, sql: 'SELECT 1', requestKey: 'overlap-0001' };
    const [a, b] = await Promise.all([
      core.executions.submit(writer, input),
      core.executions.submit(writer, input),
    ]);
    assert.equal(a.id, b.id);
    await assert.rejects(
      Promise.all([
        core.executions.submit(writer, { ...input, requestKey: 'overlap-0002' }),
        core.executions.submit(writer, { ...input, requestKey: 'overlap-0002', sql: 'SELECT 2' }),
      ]),
      code('idempotency_conflict'),
    );
    core.close();
  });

  it('expires results after their retention and deletes old metadata', async () => {
    const { core, connection } = pausedCore();
    const view = await core.executions.submit(writer, { connectionId: connection, sql: 'SELECT 1' });
    const db = core.db;
    db.run(
      "UPDATE executions SET status = 'succeeded', result_expires_at = '2026-11-08T10:00:00Z' WHERE id = :id",
      { id: view.id },
    );
    db.run(
      `INSERT INTO result_sets (execution_id, result_index, statement, columns, row_count, byte_count, completeness, expires_at)
       VALUES (:id, 0, 0, '[]', 1, 10, 'complete', '2026-11-08T10:00:00Z')`,
      { id: view.id },
    );
    db.run(
      `INSERT INTO result_chunks (execution_id, result_index, chunk_index, row_start, row_count, byte_count, data)
       VALUES (:id, 0, 0, 0, 1, 10, :data)`,
      { id: view.id, data: Buffer.from('[["1"]]') },
    );
    assert.deepEqual(core.executions.rows(writer, view.id, 0).rows, [['1']]);
    assert.deepEqual(core.executions.cleanup(new Date('2026-11-08T09:00:00Z')), {
      resultsExpired: 0,
      bytesFreed: 0,
      executionsDeleted: 0,
    });
    assert.deepEqual(core.executions.cleanup(new Date('2026-11-08T11:00:00Z')), {
      resultsExpired: 1,
      bytesFreed: 10,
      executionsDeleted: 0,
    });
    assert.equal(core.executions.view(view.id).resultSets[0]?.completeness, 'expired');
    assert.throws(() => core.executions.rows(writer, view.id, 0), code('result_expired'));
    const removed = core.executions.cleanup(new Date('2027-06-01T00:00:00Z'));
    assert.equal(removed.executionsDeleted, 1);
    assert.throws(() => core.executions.view(view.id), code('not_found'));
    core.close();
  });
});
