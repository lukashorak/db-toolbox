import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCore } from '../src/core.js';
import { AppError } from '../src/domain/errors.js';
import { actor, admin, limits, pgInput, reader, TEST_KEY, writer } from './helpers.js';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

/** One execution owned by `writer` with a 50-row result, and an MCP profile allowing 20 rows. */
async function setup() {
  let now = Date.UTC(2026, 10, 7, 10, 0, 0);
  const clock = { now: () => new Date(now) };
  const core = createCore({
    databaseFile: ':memory:',
    encryptionKey: TEST_KEY,
    limits,
    clock,
    executions: { globalCap: 0 },
  });
  for (const a of [admin, writer, reader]) core.users.touch(a);
  const connection = core.connections.create(admin, pgInput).id;
  const profile = core.profiles.create(admin, {
    name: 'Claude',
    clientId: 'workbench-mcp',
    connectionIds: [connection],
    previewRows: 20,
  });
  const mcp = actor('writer', ['query:read'], {
    source: 'mcp',
    clientId: 'workbench-mcp',
    profileId: profile.id,
  });
  const { id } = await core.executions.submit(mcp, { connectionId: connection, sql: 'SELECT n FROM t' });
  const rows = Array.from({ length: 50 }, (_, i) => [String(i + 1)]);
  core.db.run("UPDATE executions SET status = 'succeeded' WHERE id = :id", { id });
  core.db.run(
    `INSERT INTO result_sets (execution_id, result_index, statement, columns, row_count, byte_count, completeness, expires_at)
     VALUES (:id, 0, 0, '[{"name":"n","type":"int4","binary":false}]', 50, 300, 'complete', '2026-11-07T10:30:00.000Z')`,
    { id },
  );
  core.db.run(
    'INSERT INTO result_chunks (execution_id, result_index, chunk_index, row_start, row_count, byte_count, data) VALUES (:id, 0, 0, 0, 50, 300, :d)',
    { id, d: Buffer.from(JSON.stringify(rows)) },
  );
  return { core, id, mcp, profile, advance: (ms: number) => (now += ms) };
}

describe('MCP disclosure', () => {
  it('delivers up to the allowance and opens one pending request beyond it', async () => {
    const { core, id, mcp } = await setup();
    const first = core.disclosure.page(mcp, id, 0, { limit: 15 });
    assert.deepEqual([first.rows.length, first.truncated, first.allowance.rowsRemaining], [15, false, 5]);
    const second = core.disclosure.page(mcp, id, 0, { offset: 15, limit: 15 });
    assert.deepEqual([second.rows.length, second.truncated, second.approval?.status], [5, true, 'pending']);
    const third = core.disclosure.page(mcp, id, 0, { offset: 20, limit: 15 });
    assert.equal(third.approval?.id, second.approval?.id);
    const [request] = core.disclosure.list(writer, { status: 'pending' });
    assert.deepEqual(
      [request?.requested.rows, request?.requested.by, request?.profile.name],
      [30, 'writer', 'Claude'],
    );
    assert.throws(
      () => core.disclosure.page(writer, id, 0),
      code('forbidden'),
      'GUI users read rows through the API',
    );
    core.close();
  });

  it('only the owner approves, in the GUI; the approval expires within the result retention', async () => {
    const { core, id, mcp, advance } = await setup();
    core.disclosure.page(mcp, id, 0, { limit: 20 });
    const approvalId = String(core.disclosure.page(mcp, id, 0, { offset: 20, limit: 10 }).approval?.id);
    assert.throws(() => core.disclosure.approve(mcp, approvalId), code('forbidden'));
    assert.throws(
      () => core.disclosure.approve(admin, approvalId),
      code('forbidden'),
      'an administrator cannot approve for someone else',
    );
    assert.throws(() => core.disclosure.approve(reader, approvalId), code('not_found'));
    const approved = core.disclosure.approve(writer, approvalId, { rows: 10, minutes: 120 });
    assert.equal(
      approved.expiresAt,
      '2026-11-07T10:30:00.000Z',
      'bounded by the result retention, not 2 hours',
    );
    const page = core.disclosure.page(mcp, id, 0, { offset: 20, limit: 30 });
    assert.deepEqual([page.rows.length, page.truncated, page.allowance.approvedRowsRemaining], [10, true, 0]);
    advance(31 * 60_000);
    // Past the result's retention nothing is readable, even before the periodic cleanup runs.
    assert.throws(() => core.disclosure.page(mcp, id, 0, { offset: 30, limit: 5 }), code('result_expired'));
    assert.equal(core.disclosure.view(approvalId).status, 'expired');
    core.close();
  });

  it('a default approval covers the requested rows even when they are wider than average', async () => {
    const { core, id, mcp } = await setup();
    const changes: string[] = [];
    core.disclosure.events.on('change', (e: { id: string }) => changes.push(e.id));
    core.disclosure.page(mcp, id, 0, { limit: 20 });
    const approvalId = String(core.disclosure.page(mcp, id, 0, { offset: 20, limit: 30 }).approval?.id);
    // Rows 21-50 have two digits; the request estimates its bytes from the average row of the set.
    const approved = core.disclosure.approve(writer, approvalId);
    assert.deepEqual(
      [approved.requested.rows, approved.granted?.rows, approved.granted?.bytes],
      [30, 30, 300],
    );
    const page = core.disclosure.page(mcp, id, 0, { offset: 20, limit: 30 });
    assert.deepEqual([page.rows.length, page.rows.at(-1)?.[0], page.truncated], [30, '50', false]);
    assert.deepEqual(changes, [approvalId, approvalId, approvalId], 'requested, approved, used');
    core.close();
  });

  it('closes results on connections the profile no longer allows', async () => {
    const { core, id, mcp, profile } = await setup();
    assert.equal(core.disclosure.page(mcp, id, 0, { limit: 5 }).rows.length, 5);
    const other = core.connections.create(admin, { ...pgInput, name: 'Elsewhere' }).id;
    core.profiles.update(admin, profile.id, { connectionIds: [other] });
    assert.throws(() => core.disclosure.page(mcp, id, 0, { limit: 5 }), code('not_found'));
    assert.throws(() => core.executions.get(mcp, id), code('not_found'));
    await assert.rejects(
      core.exports.create(mcp, id, 0, { format: 'csv', previewOnly: true }),
      code('not_found'),
    );
    core.close();
  });

  it('deny and revoke stop further pages; disabled profiles get nothing', async () => {
    const { core, id, mcp, profile } = await setup();
    const pending = String(core.disclosure.page(mcp, id, 0, { offset: 0, limit: 30 }).approval?.id);
    assert.equal(core.disclosure.deny(writer, pending, 'Too much').status, 'denied');
    const next = String(core.disclosure.page(mcp, id, 0, { offset: 20, limit: 5 }).approval?.id);
    assert.notEqual(next, pending);
    core.disclosure.approve(writer, next);
    assert.equal(core.disclosure.page(mcp, id, 0, { offset: 20, limit: 5 }).rows.length, 5);
    assert.equal(core.disclosure.revoke(admin, next).status, 'revoked');
    assert.equal(core.disclosure.page(mcp, id, 0, { offset: 25, limit: 5 }).rows.length, 0);
    core.profiles.update(admin, profile.id, { enabled: false });
    assert.throws(() => core.disclosure.page(mcp, id, 0), code('profile_disabled'));
    core.close();
  });
});
