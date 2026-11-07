import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/domain/errors.js';
import { admin, adminWithoutWrite, insertExecution, limits, pgInput, testCore, writer } from './helpers.js';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

function setup() {
  const core = testCore();
  const prod = core.connections.create(admin, pgInput).id;
  const dev = core.connections.create(admin, {
    ...pgInput,
    name: 'Development',
    environment: 'development',
    database: 'commerce_dev',
    readOnly: false,
  }).id;
  return { core, prod, dev };
}

describe('ProfileService', () => {
  it('binds one OAuth client to one profile and defaults to read-only', () => {
    const { core, prod } = setup();
    const p = core.profiles.create(admin, {
      name: 'Claude Code analytics',
      clientId: 'workbench-mcp',
      connectionIds: [prod],
    });
    assert.equal(p.readOnly, true);
    assert.equal(p.previewRows, limits.mcpPreviewRows);
    assert.equal(core.profiles.findByClientId('workbench-mcp')?.id, p.id);
    assert.throws(
      () => core.profiles.create(admin, { name: 'Other', clientId: 'workbench-mcp', connectionIds: [prod] }),
      code('client_id_conflict'),
    );
    assert.throws(
      () => core.profiles.create(writer, { name: 'x', clientId: 'x-1', connectionIds: [prod] }),
      code('forbidden'),
    );
  });

  it('keeps limits within the deployment maximums and requires existing connections', () => {
    const { core, prod } = setup();
    assert.throws(
      () =>
        core.profiles.create(admin, {
          name: 'x',
          clientId: 'c-1',
          connectionIds: [prod],
          previewRows: limits.mcpPreviewRows + 1,
        }),
      code('validation_failed'),
    );
    assert.throws(
      () => core.profiles.create(admin, { name: 'x', clientId: 'c-1', connectionIds: ['cn_missing'] }),
      code('validation_failed'),
    );
  });

  it('reports effective access per connection, strongest restriction first', () => {
    const { core, prod, dev } = setup();
    const writable = core.profiles.create(admin, {
      name: 'Claude Code development',
      clientId: 'workbench-mcp-dev',
      connectionIds: [dev],
      readOnly: false,
    });
    const access = core.profiles.effectiveAccess(writer, writable.id);
    const byName = Object.fromEntries(access.map((a) => [a.connectionName, a]));
    assert.equal(byName['Production analytics']?.allowed, false);
    assert.equal(byName['Development']?.policy?.readOnly, false);
    const noWrite = core.profiles.effectiveAccess(adminWithoutWrite, writable.id);
    assert.deepEqual(noWrite.find((a) => a.connectionId === dev)?.policy?.sources, ['user']);
    void prod;
  });

  it('denies pending disclosure requests the profile can no longer satisfy', () => {
    const { core, prod, dev } = setup();
    const p = core.profiles.create(admin, {
      name: 'Claude Code analytics',
      clientId: 'workbench-mcp',
      connectionIds: [prod, dev],
    });
    insertExecution(core, 'ex_1', prod, 'succeeded');
    core.db.run(
      `INSERT INTO disclosure_approvals (id, execution_id, result_index, profile_id, profile_name, status, requested_rows, requested_bytes, requested_at)
       VALUES ('apr_1', 'ex_1', 0, :pid, 'Claude Code analytics', 'pending', 4812, 1153434, '2026-11-07T10:13:05Z')`,
      { pid: p.id },
    );
    const kept = core.profiles.update(admin, p.id, { timeoutMs: 20_000 });
    assert.equal(kept.cancelledRequests, 0);
    const result = core.profiles.update(admin, p.id, { connectionIds: [dev] });
    assert.equal(result.cancelledRequests, 1);
    assert.equal(
      core.db.get<{ status: string }>("SELECT status FROM disclosure_approvals WHERE id = 'apr_1'")?.status,
      'denied',
    );
  });
});
