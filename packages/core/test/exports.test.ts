import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createCore, type Core } from '../src/core.js';
import { AppError } from '../src/domain/errors.js';
import { csvField, exportFailure, hexToBase64 } from '../src/execution/exports.js';
import { admin, limits, pgInput, reader, steppingClock, TEST_KEY, writer } from './helpers.js';

const root = await mkdtemp(join(tmpdir(), 'workbench-exports-'));
after(() => rm(root, { recursive: true, force: true }));
let n = 0;

const COLUMNS = [
  { name: 'id', type: 'int4', binary: false },
  { name: 'id', type: 'int4', binary: false },
  { name: 'note', type: 'text', binary: false },
  { name: 'big', type: 'int8', binary: false },
  { name: 'amount', type: 'numeric', binary: false },
  { name: 'raw', type: 'bytea', binary: true },
];
const ROWS = [
  ['1', '10', null, '9223372036854775807', '12345678901234567890.1234567890', '\\x00ff10'],
  ['2', '20', '', '-9223372036854775808', '-0.0000000001', null],
  ['3', '30', 'say "hi", then\r\nleave', '0', '0', '\\x'],
  ['4', '40', 'žluťoučký kůň 🐎', '1', '1.5', '\\xdeadbeef'],
];
const CSV =
  'id,id,note,big,amount,raw\r\n' +
  '1,10,,9223372036854775807,12345678901234567890.1234567890,\\x00ff10\r\n' +
  '2,20,"",-9223372036854775808,-0.0000000001,\r\n' +
  '3,30,"say ""hi"", then\r\nleave",0,0,\\x\r\n' +
  '4,40,žluťoučký kůň 🐎,1,1.5,\\xdeadbeef\r\n';

/** A core with one finished execution whose result set holds the fidelity fixture. */
async function fixture(completeness = 'complete'): Promise<{ core: Core; id: string; dir: string }> {
  const dir = join(root, `case-${++n}`);
  const core = createCore({
    databaseFile: ':memory:',
    encryptionKey: TEST_KEY,
    limits,
    clock: steppingClock(),
    executions: { globalCap: 0 },
    exportDir: dir,
  });
  for (const a of [admin, writer, reader]) core.users.touch(a);
  const connection = core.connections.create(admin, pgInput).id;
  const { id } = await core.executions.submit(writer, {
    connectionId: connection,
    sql: 'SELECT 1',
    title: 'Fidelity check',
  });
  core.db.run(
    "UPDATE executions SET status = 'succeeded', finished_at = '2026-11-07T10:00:00Z' WHERE id = :id",
    { id },
  );
  core.db.run(
    `INSERT INTO result_sets (execution_id, result_index, statement, columns, row_count, byte_count, more_available, completeness, expires_at)
     VALUES (:id, 0, 0, :columns, 4, 400, :more, :completeness, '2026-11-08T10:00:00Z')`,
    { id, columns: JSON.stringify(COLUMNS), more: completeness === 'complete' ? 0 : 1, completeness },
  );
  core.db.run(
    `INSERT INTO result_chunks (execution_id, result_index, chunk_index, row_start, row_count, byte_count, data)
     VALUES (:id, 0, 0, 0, 2, 200, :a), (:id, 0, 1, 2, 2, 200, :b)`,
    { id, a: Buffer.from(JSON.stringify(ROWS.slice(0, 2))), b: Buffer.from(JSON.stringify(ROWS.slice(2))) },
  );
  return { core, id, dir };
}

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

describe('export formats', () => {
  it('quotes CSV fields by RFC 4180 and keeps NULL apart from empty text', () => {
    assert.equal(csvField(null), '');
    assert.equal(csvField(''), '""');
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('a"b'), '"a""b"');
    assert.equal(csvField('line\nbreak'), '"line\nbreak"');
    assert.equal(csvField(' spaced '), ' spaced ');
    assert.equal(hexToBase64('\\x00ff10'), 'AP8Q');
  });

  it('writes the fidelity fixture byte for byte as CSV', async () => {
    const { core, id, dir } = await fixture();
    const created = await core.exports.create(writer, id, 0, { format: 'csv' });
    assert.equal(created.status, 'generating');
    assert.equal(created.fileName, null, 'the name is published only when complete');
    await core.exports.idle();
    const ready = core.exports.get(writer, created.id);
    assert.equal(ready.status, 'ready');
    assert.match(String(ready.fileName), /^fidelity-check-exp_[0-9A-Za-z]+\.csv$/);
    const file = await core.exports.download(writer, created.id);
    assert.equal(file.path, join(dir, id, String(ready.fileName)));
    assert.equal(await readFile(file.path, 'utf8'), CSV);
    assert.equal(ready.rowCount, 4);
    assert.equal(ready.byteCount, Buffer.byteLength(CSV));
    assert.deepEqual(await readdir(join(dir, id)), [ready.fileName], 'no partial file is left');
    core.close();
  });

  it('writes JSON with duplicate columns, nulls, exact numbers and base64 binary', async () => {
    const { core, id } = await fixture();
    const created = await core.exports.create(writer, id, 0, { format: 'json' });
    await core.exports.idle();
    const parsed = JSON.parse(await readFile((await core.exports.download(writer, created.id)).path, 'utf8'));
    assert.equal(parsed.completeness, 'complete');
    assert.deepEqual([parsed.capturedRows, parsed.exportedRows], [4, 4]);
    assert.deepEqual(
      parsed.columns.map((c: { name: string }) => c.name),
      ['id', 'id', 'note', 'big', 'amount', 'raw'],
    );
    assert.deepEqual(parsed.rows[0], [
      '1',
      '10',
      null,
      '9223372036854775807',
      '12345678901234567890.1234567890',
      { base64: 'AP8Q' },
    ]);
    assert.deepEqual(parsed.rows[1].slice(2), ['', '-9223372036854775808', '-0.0000000001', null]);
    assert.equal(parsed.rows[2][2], 'say "hi", then\r\nleave');
    assert.equal(parsed.rows[3][2], 'žluťoučký kůň 🐎');
    core.close();
  });
});

describe('export rules', () => {
  it('exports only complete results in full; previews are labelled', async () => {
    const { core, id } = await fixture('preview_limited');
    await assert.rejects(core.exports.create(writer, id, 0, { format: 'csv' }), code('not_complete'));
    const preview = await core.exports.create(writer, id, 0, { format: 'json', previewOnly: true });
    await core.exports.idle();
    const ready = core.exports.get(writer, preview.id);
    assert.match(String(ready.fileName), /-PREVIEW-ONLY\.json$/);
    const parsed = JSON.parse(await readFile((await core.exports.download(writer, preview.id)).path, 'utf8'));
    assert.deepEqual([parsed.completeness, parsed.moreAvailable], ['preview_only', true]);
    core.close();
  });

  it('never runs SQL: repeat exports and regeneration leave the execution count unchanged', async () => {
    const { core, id } = await fixture();
    const before = core.db.get('SELECT count(*) AS n FROM executions')?.n;
    const first = await core.exports.create(writer, id, 0, { format: 'csv' });
    await core.exports.create(writer, id, 0, { format: 'csv' });
    await core.exports.idle();
    const path = (await core.exports.download(writer, first.id)).path;
    await rm(path);
    await assert.rejects(core.exports.download(writer, first.id), code('export_missing'));
    assert.equal(core.exports.get(writer, first.id).status, 'ready', 'a download error does not regenerate');
    await core.exports.regenerate(writer, first.id);
    await core.exports.idle();
    assert.equal(await readFile((await core.exports.download(writer, first.id)).path, 'utf8'), CSV);
    assert.equal(core.db.get('SELECT count(*) AS n FROM executions')?.n, before);
    // The repeat export was the same export: one CSV per result.
    assert.equal(core.exports.list(writer, id).length, 1);
    core.close();
  });

  it('reuses the export of the same result, format and scope instead of writing more files', async () => {
    const { core, id, dir } = await fixture();
    const first = await core.exports.create(writer, id, 0, { format: 'csv' });
    await core.exports.idle();
    for (let i = 0; i < 5; i++) {
      assert.equal((await core.exports.create(writer, id, 0, { format: 'csv' })).id, first.id);
    }
    const json = await core.exports.create(writer, id, 0, { format: 'json' });
    assert.notEqual(json.id, first.id, 'another format is another export');
    await core.exports.idle();
    assert.equal((await readdir(join(dir, id))).length, 2);
    // A ready export whose file is gone is written again, under the same ID.
    await rm((await core.exports.download(writer, first.id)).path);
    assert.equal((await core.exports.create(writer, id, 0, { format: 'csv' })).id, first.id);
    await core.exports.idle();
    assert.equal(await readFile((await core.exports.download(writer, first.id)).path, 'utf8'), CSV);
    assert.equal(core.exports.list(writer, id).length, 2);
    core.close();
  });

  it('reports a failed generation and keeps no partial file', async () => {
    const { core, id, dir } = await fixture();
    // The execution's folder path is taken by a file, so the export cannot be written.
    await rm(dir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, id), 'occupied');
    const created = await core.exports.create(writer, id, 0, { format: 'csv' });
    await core.exports.idle();
    const failed = core.exports.get(writer, created.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'generation_failed');
    await assert.rejects(core.exports.download(writer, created.id), code('export_not_ready'));
    core.close();
  });

  it('fails exports a restart interrupted, removes their partial files, and lets them be regenerated', async () => {
    const { core, id, dir } = await fixture();
    const { mkdir } = await import('node:fs/promises');
    // Two records left `generating` by a process that stopped mid-write.
    for (const x of ['exp_a', 'exp_b']) {
      core.db.run(
        `INSERT INTO exports (id, execution_id, result_index, format, preview_only, status, created_by, created_at)
         VALUES (:x, :id, 0, 'csv', 0, 'generating', :by, '2026-11-07T10:00:00Z')`,
        { x, id, by: writer.subject },
      );
    }
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, 'exp_a.part'), 'half a fi');
    // Regenerating an abandoned record writes it again instead of waiting for a job that is gone.
    await core.exports.regenerate(writer, 'exp_b');
    await core.exports.idle();
    assert.equal(core.exports.get(writer, 'exp_b').status, 'ready');
    assert.equal(await core.exports.reconcile(), 1);
    const failed = core.exports.get(writer, 'exp_a');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error?.code, 'interrupted');
    assert.equal(existsSync(join(dir, id, 'exp_a.part')), false);
    // Two regenerate calls at once write the file once.
    await Promise.all([core.exports.regenerate(writer, 'exp_a'), core.exports.regenerate(writer, 'exp_a')]);
    await core.exports.idle();
    assert.equal(core.exports.get(writer, 'exp_a').status, 'ready');
    assert.equal(await readFile((await core.exports.download(writer, 'exp_a')).path, 'utf8'), CSV);
    assert.equal(
      core.db.get(
        "SELECT count(*) AS n FROM audit_events WHERE action = 'export.regenerate' AND target_id = 'exp_a'",
      )?.n,
      1,
    );
    assert.equal(await core.exports.reconcile(), 0);
    core.close();
  });

  it('maps disk-full and permission errors', () => {
    assert.equal(exportFailure(Object.assign(new Error('no space'), { code: 'ENOSPC' })).code, 'disk_full');
    assert.equal(
      exportFailure(Object.assign(new Error('denied'), { code: 'EACCES' })).code,
      'write_permission',
    );
    assert.equal(
      exportFailure(Object.assign(new Error('read-only'), { code: 'EROFS' })).code,
      'write_permission',
    );
  });

  it('allows exports and downloads only to those who can see the execution', async () => {
    const { core, id } = await fixture();
    await assert.rejects(core.exports.create(reader, id, 0, { format: 'csv' }), code('not_found'));
    const created = await core.exports.create(writer, id, 0, { format: 'csv' });
    await core.exports.idle();
    await assert.rejects(core.exports.download(reader, created.id), code('not_found'));
    assert.ok(await core.exports.download(admin, created.id));
    core.close();
  });
});

describe('result deletion and retention', () => {
  it('deleting a result removes rows, export files and disclosure, and keeps the execution', async () => {
    const { core, id, dir } = await fixture();
    const created = await core.exports.create(writer, id, 0, { format: 'csv' });
    await core.exports.idle();
    core.db.run(
      `INSERT INTO disclosure_approvals (id, execution_id, result_index, profile_name, status, requested_rows, requested_bytes, requested_at)
       VALUES ('apr_1', :id, 0, 'Claude', 'active', 4, 400, '2026-11-07T10:00:00Z')`,
      { id },
    );
    const freed = await core.exports.deleteResults(writer, id);
    assert.equal(freed, 400);
    assert.equal(core.executions.view(id).resultSets[0]?.completeness, 'deleted');
    assert.equal(core.exports.get(writer, created.id).status, 'deleted');
    assert.deepEqual(await readdir(join(dir, id)), []);
    assert.equal(
      core.db.get('SELECT count(*) AS n FROM result_chunks WHERE execution_id = :id', { id })?.n,
      0,
    );
    assert.equal(
      core.db.get("SELECT status FROM disclosure_approvals WHERE id = 'apr_1'")?.status,
      'revoked',
    );
    assert.equal(core.executions.view(id).status, 'succeeded');
    assert.throws(() => core.executions.rows(writer, id, 0), code('result_expired'));
    await assert.rejects(core.exports.regenerate(writer, created.id), code('result_expired'));
    core.close();
  });

  it('does not give back the space of a result that retention already expired', async () => {
    const { core, id } = await fixture();
    core.db.run(
      `INSERT INTO result_sets (execution_id, result_index, statement, columns, row_count, byte_count, more_available, completeness, expires_at)
       VALUES (:id, 1, 0, :columns, 1, 100, 0, 'complete', '2027-01-01T00:00:00Z')`,
      { id, columns: JSON.stringify(COLUMNS) },
    );
    core.executions.reconcile();
    assert.equal(core.executions.storedBytes, 500);
    await core.cleanup(new Date('2026-11-09T00:00:00Z'));
    assert.equal(core.executions.storedBytes, 100, 'retention released the expired result');
    assert.equal(await core.exports.deleteResults(writer, id, 0), 0);
    assert.equal(core.executions.storedBytes, 100, 'the live result is still counted');
    assert.equal(core.executions.view(id).resultSets[0]?.completeness, 'expired');
    assert.equal(await core.exports.deleteResults(writer, id), 100);
    assert.equal(core.executions.storedBytes, 0);
    core.close();
  });

  it('releases the space of a result once when two deletions overlap', async () => {
    const { core, id } = await fixture();
    core.db.run(
      `INSERT INTO result_sets (execution_id, result_index, statement, columns, row_count, byte_count, more_available, completeness, expires_at)
       VALUES (:id, 1, 0, :columns, 1, 100, 0, 'complete', '2027-01-01T00:00:00Z')`,
      { id, columns: JSON.stringify(COLUMNS) },
    );
    core.executions.reconcile();
    // An export, so each deletion waits on removing its file before changing the database.
    await core.exports.create(writer, id, 0, { format: 'csv' });
    await core.exports.idle();
    const freed = await Promise.all([
      core.exports.deleteResults(writer, id, 0),
      core.exports.deleteResults(writer, id, 0),
    ]);
    assert.deepEqual(freed.sort(), [0, 400]);
    assert.equal(core.executions.storedBytes, 100, 'the other result is still counted');
    core.close();
  });

  it('cleanup does not turn an export deleted in the meantime into an expired one', async () => {
    const { core, id } = await fixture();
    const created = await core.exports.create(writer, id, 0, { format: 'csv' });
    await core.exports.idle();
    // Cleanup selects the export, then waits on removing its file…
    const cleaning = core.exports.cleanup(new Date('2026-11-09T00:00:00Z'));
    // …while a deletion of the result finishes (its database change).
    core.db.run("UPDATE exports SET status = 'deleted' WHERE id = :id", { id: created.id });
    await cleaning;
    assert.equal(core.exports.get(writer, created.id).status, 'deleted');
    core.close();
  });

  it('cleanup removes export files and chunks after retention and keeps metadata', async () => {
    const { core, id, dir } = await fixture();
    const created = await core.exports.create(writer, id, 0, { format: 'json' });
    await core.exports.idle();
    const path = (await core.exports.download(writer, created.id)).path;
    const removed = await core.cleanup(new Date('2026-11-09T00:00:00Z'));
    assert.deepEqual(removed, {
      exportsExpired: 1,
      resultsExpired: 1,
      bytesFreed: 400,
      executionsDeleted: 0,
    });
    assert.equal(existsSync(path), false);
    assert.equal(core.exports.get(writer, created.id).status, 'expired');
    assert.equal(core.executions.view(id).resultSets[0]?.completeness, 'expired');
    assert.equal(core.db.get('SELECT count(*) AS n FROM result_chunks')?.n, 0);
    const later = await core.cleanup(new Date('2027-06-01T00:00:00Z'));
    assert.equal(later.executionsDeleted, 1);
    assert.equal(existsSync(join(dir, id)), false);
    core.close();
  });
});
