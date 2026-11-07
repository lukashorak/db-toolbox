import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fixture, finished, human } from './helpers.js';
import { Workbench } from '../src/core/service.js';
import type { Adapter, Session, Execution } from '../src/core/types.js';

test('1200-row preview, full export, and separate MCP approval', async () => {
  const f = await fixture();
  try {
    const preview = await finished(
      f.core,
      f.core.submit(
        human,
        f.input('SELECT id,label,exact FROM sample ORDER BY id', { capture: 'preview' }),
      ).id,
    );
    assert.equal(preview.status, 'succeeded');
    assert.equal(preview.results[0]!.rows, 1000);
    assert.equal(preview.results[0]!.completeness, 'preview_limited');
    await assert.rejects(f.core.export(human, preview.results[0]!.id, 'json'), {
      code: 'RESULT_INCOMPLETE',
    });
    const full = await finished(
      f.core,
      f.core.submit(human, f.input('SELECT id,label,exact FROM sample ORDER BY id')).id,
    );
    const result = full.results[0]!;
    assert.equal(result.rows, 1200);
    assert.equal(result.completeness, 'complete');
    assert.equal(f.core.resultPage(human, result.id, 0, 1000).rows.length, 1000);
    assert.throws(() => f.core.resultPage(human, result.id, 1000), { code: 'PREVIEW_LIMIT' });
    assert.throws(() => f.core.resultPage(f.mcp, result.id, 1000), {
      code: 'DISCLOSURE_APPROVAL_REQUIRED',
    });
    assert.throws(() => f.core.approve(f.mcp, result.id, f.profile.id), {
      code: 'HUMAN_ACTION_REQUIRED',
    });
    const exported = await f.core.export(f.mcp, result.id, 'json');
    assert.equal(exported.rows, 1200);
    assert.throws(() => f.core.download(f.mcp, exported.id), {
      code: 'DISCLOSURE_APPROVAL_REQUIRED',
    });
    const json = JSON.parse(await readFile(f.core.download(human, exported.id).path, 'utf8'));
    assert.equal(json.rows.length, 1200);
    assert.deepEqual(json.rows[1199], [1200, 'Žluťoučký 1200', '9007199254740993.25']);
    const csvExport = await f.core.export(human, result.id, 'csv');
    const csv = await readFile(f.core.download(human, csvExport.id).path, 'utf8');
    assert.equal(csv.split('\r\n').length, 1202);
    assert.match(csv, /"1200","Žluťoučký 1200","9007199254740993.25"/);
    await f.db.exec('DELETE FROM sample');
    const repeated = await f.core.export(human, result.id, 'json');
    assert.equal(repeated.id, exported.id);
    assert.equal(
      JSON.parse(await readFile(f.core.download(human, exported.id).path, 'utf8')).rows.length,
      1200,
    );
    f.core.approve(human, result.id, f.profile.id);
    assert.equal(f.core.resultPage(f.mcp, result.id, 1000).rows.length, 200);
    assert.equal(f.core.download(f.mcp, exported.id).rows, 1200);
    f.core.revoke(human, result.id, f.profile.id);
    assert.throws(() => f.core.resultPage(f.mcp, result.id, 1000), {
      code: 'DISCLOSURE_APPROVAL_REQUIRED',
    });
  } finally {
    await f.close();
  }
});
test('atomic scripts roll back while per-statement mode preserves previous commits', async () => {
  const f = await fixture();
  try {
    const sql = 'INSERT INTO ledger VALUES (1,10); INSERT INTO ledger VALUES (1,20)';
    const atomic = await finished(
      f.core,
      f.core.submit(human, f.input(sql, { transaction: 'atomic' })).id,
    );
    assert.equal(atomic.status, 'failed');
    assert.equal(atomic.transactionOutcome, 'rolled_back');
    assert.equal((await f.db.query('SELECT * FROM ledger')).rows.length, 0);
    const separate = await finished(f.core, f.core.submit(human, f.input(sql)).id);
    assert.equal(separate.status, 'failed');
    assert.equal(separate.transactionOutcome, 'partial_commit');
    assert.deepEqual((await f.db.query('SELECT * FROM ledger')).rows, [{ id: 1, amount: 10 }]);
    assert.equal(separate.results[0]!.transactionOutcome, 'committed');
  } finally {
    await f.close();
  }
});
test('write RETURNING is not truncated or repeated just to export it', async () => {
  const f = await fixture();
  try {
    const sql = "UPDATE sample SET label='changed' RETURNING id";
    const job = await finished(
      f.core,
      f.core.submit(human, f.input(sql, { capture: 'preview' })).id,
    );
    assert.equal(job.status, 'succeeded');
    assert.equal(job.results[0]!.rows, 1000);
    assert.equal(job.results[0]!.completeness, 'preview_limited');
    assert.equal(
      (await f.db.query("SELECT count(*)::int AS n FROM sample WHERE label='changed'")).rows[0]!.n,
      1200,
    );
    await assert.rejects(f.core.export(human, job.results[0]!.id, 'csv'), {
      code: 'RESULT_INCOMPLETE',
    });
    assert.equal(
      (await f.db.query("SELECT count(*)::int AS n FROM sample WHERE label='changed'")).rows[0]!.n,
      1200,
    );
  } finally {
    await f.close();
  }
});
test('duplicate submissions, credential encryption and user isolation', async () => {
  const f = await fixture();
  try {
    const input = f.input('SELECT 1');
    const first = f.core.submit(human, input);
    const duplicate = f.core.submit(human, input);
    assert.equal(first.id, duplicate.id);
    assert.throws(() => f.core.submit(human, { ...input, sql: 'SELECT 2' }), {
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await finished(f.core, first.id);
    assert.throws(() => f.core.execution({ ...human, subject: 'another-user' }, first.id), {
      code: 'NOT_FOUND',
    });
    assert.equal(JSON.stringify(f.core.connections(human)).includes('test-secret'), false);
    assert.equal(
      String(f.store.db.prepare('SELECT payload FROM connections').get()!.payload).includes(
        'test-secret',
      ),
      false,
    );
    assert.equal(f.store.connection(f.connection.id)!.password, 'test-secret');
  } finally {
    await f.close();
  }
});
test('result quotas roll back atomic writes and never advertise complete exports', async () => {
  const f = await fixture({ maxResultBytes: 100 });
  try {
    const job = await finished(
      f.core,
      f.core.submit(
        human,
        f.input("UPDATE sample SET label='changed' RETURNING id", { transaction: 'atomic' }),
      ).id,
    );
    assert.equal(job.status, 'failed');
    assert.equal(job.transactionOutcome, 'rolled_back');
    assert.equal(job.results[0]!.completeness, 'quota_limited');
    assert.equal((await f.db.query("SELECT * FROM sample WHERE label='changed'")).rows.length, 0);
  } finally {
    await f.close();
  }
});
test('retention deletes result chunks and exports but preserves execution metadata', async () => {
  const f = await fixture();
  try {
    const job = await finished(f.core, f.core.submit(human, f.input('SELECT 1')).id);
    const result = job.results[0]!;
    const item = await f.core.export(human, result.id, 'json');
    const path = f.core.download(human, item.id).path;
    await f.core.cleanup(result.expiresAt + 1);
    assert.equal(f.store.result(result.id)!.completeness, 'expired');
    assert.equal(f.store.totalBytes(), 0);
    assert.ok(f.store.execution(job.id));
    await assert.rejects(readFile(path));
    assert.throws(() => f.core.resultPage(human, result.id), { code: 'RESULT_EXPIRED' });
  } finally {
    await f.close();
  }
});
test('large cells and multiple result sets cannot bypass the MCP preview budget', async () => {
  const f = await fixture({ previewBytes: 1000 });
  try {
    const job = await finished(
      f.core,
      f.core.submit(human, f.input('SELECT label FROM sample; SELECT label FROM sample')).id,
    );
    const page = f.core.resultPage(f.mcp, job.results[0]!.id, 0, 1000);
    assert.ok(page.rows.length < 1000);
    assert.ok(page.rows.length > 0);
    const second = f.core.resultPage(f.mcp, job.results[1]!.id);
    assert.equal(second.rows.length, 0);
    assert.throws(() => f.core.resultPage(f.mcp, job.results[0]!.id, 500), {
      code: 'DISCLOSURE_APPROVAL_REQUIRED',
    });
  } finally {
    await f.close();
  }
});
test('cancellation and timeout wait for rollback; uncertain commit stays unknown', async () => {
  const f = await fixture();
  let rollback = 0;
  try {
    const adapter: Adapter = {
      async open() {
        return {
          async begin() {},
          async commit() {
            throw new Error('commit acknowledgement lost');
          },
          async rollback() {
            rollback++;
          },
          async *query(_sql, signal) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 150);
              signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(new Error('cancelled'));
                },
                { once: true },
              );
            });
            yield { columns: [], rows: [] };
          },
          async cancel() {},
          async close() {},
        } satisfies Session;
      },
    };
    const core = new Workbench(f.store, { postgres: adapter, mysql: adapter }, f.directory, {
      concurrency: 1,
    });
    const cancelled = core.submit(human, f.input('SELECT 1'));
    await new Promise((r) => setTimeout(r, 25));
    core.cancel(human, cancelled.id);
    assert.equal((await finished(core, cancelled.id)).status, 'cancelled');
    const timed = core.submit(human, f.input('SELECT 1', { timeoutMs: 100 }));
    assert.equal((await finished(core, timed.id)).status, 'timed_out');
    const uncertain = core.submit(human, f.input('SELECT 1'));
    assert.equal((await finished(core, uncertain.id)).status, 'unknown');
    assert.equal(rollback, 3);
    await core.shutdown();
  } finally {
    await f.close();
  }
});
test('restart marks in-flight SQL interrupted without replay', async () => {
  const f = await fixture();
  try {
    const job: Execution = {
      ...f.input('INSERT INTO ledger VALUES(1,1)'),
      id: randomUUID(),
      owner: human.subject,
      actor: human,
      status: 'running',
      createdAt: Date.now(),
      transactionOutcome: 'pending',
    };
    f.store.addExecution(job, 'fixture');
    const row = f.store.addResult(job, 0, job.sql, job.sql);
    const recovered = new Workbench(
      f.store,
      { postgres: f.adapter, mysql: f.adapter },
      f.directory,
    );
    assert.equal(f.store.execution(job.id)!.status, 'interrupted');
    assert.equal(f.store.execution(job.id)!.transactionOutcome, 'unknown');
    assert.equal(f.store.result(row.id)!.completeness, 'interrupted');
    assert.equal((await f.db.query('SELECT * FROM ledger')).rows.length, 0);
    await recovered.shutdown();
  } finally {
    await f.close();
  }
});
