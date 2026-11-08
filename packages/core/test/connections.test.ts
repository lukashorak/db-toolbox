import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/domain/errors.js';
import { ID_PATTERN } from '../src/domain/ids.js';
import { admin, insertExecution, pgInput, reader, testCore, writer } from './helpers.js';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

describe('ConnectionService', () => {
  it('creates a connection that never exposes its password', () => {
    const core = testCore();
    const view = core.connections.create(admin, pgInput);
    assert.match(view.id, ID_PATTERN);
    assert.ok(view.id.startsWith('cn_'));
    assert.equal(view.hasPassword, true);
    assert.ok(!JSON.stringify(view).includes(pgInput.password));
    assert.ok(!JSON.stringify(core.connections.list(reader)).includes(pgInput.password));
    const stored = core.db.get<{ secret: string }>('SELECT secret FROM connections WHERE id = :id', {
      id: view.id,
    });
    assert.ok(stored && !stored.secret.includes(pgInput.password));
    assert.equal(core.connections.credentials(view.id).password, pgInput.password);
  });

  it('requires the admin role to change configuration', () => {
    const core = testCore();
    assert.throws(() => core.connections.create(writer, pgInput), code('forbidden'));
    const id = core.connections.create(admin, pgInput).id;
    assert.throws(() => core.connections.update(reader, id, { name: 'x' }), code('forbidden'));
    assert.equal(core.connections.get(reader, id).name, pgInput.name);
  });

  it('keeps the stored password when an update leaves it blank and replaces it otherwise', () => {
    const core = testCore();
    const id = core.connections.create(admin, pgInput).id;
    core.connections.update(admin, id, { password: '', host: 'pg2.db.example.test' });
    assert.equal(core.connections.credentials(id).password, pgInput.password);
    core.connections.update(admin, id, { password: 'new secret' });
    assert.equal(core.connections.credentials(id).password, 'new secret');
    const events = core.audit.list(admin, { actionPrefix: 'connection.update' });
    assert.deepEqual(
      events.map((e) => e.details.credential),
      ['replaced', 'kept'],
    );
    assert.ok(!JSON.stringify(events).includes('new secret'));
  });

  it('validates fields and reports them individually', () => {
    const core = testCore();
    assert.throws(
      () =>
        core.connections.create(admin, {
          ...pgInput,
          name: ' ',
          host: 'https://x/y',
          port: 70000,
          password: '',
        }),
      (e: unknown) =>
        e instanceof AppError &&
        e.code === 'validation_failed' &&
        ['name', 'host', 'port', 'password'].every((f) =>
          ((e.details?.fields as { path: string }[] | undefined) ?? []).some((p) => p.path === f),
        ),
    );
    assert.throws(
      () => core.connections.create(admin, { ...pgInput, engine: 'mysql', port: 3306, schema: 'public' }),
      (e: unknown) =>
        e instanceof AppError &&
        ((e.details?.fields as { path: string }[] | undefined) ?? []).some((p) => p.path === 'schema'),
    );
    assert.throws(
      () => core.connections.create(admin, { ...pgInput, caPem: 'not a cert' }),
      code('validation_failed'),
    );
  });

  it('rejects duplicate names regardless of case and refuses to change the engine', () => {
    const core = testCore();
    const id = core.connections.create(admin, pgInput).id;
    assert.throws(
      () => core.connections.create(admin, { ...pgInput, name: 'PRODUCTION ANALYTICS' }),
      code('name_conflict'),
    );
    assert.throws(() => core.connections.update(admin, id, { engine: 'mysql' }), code('engine_immutable'));
  });

  it('discloses references and refuses to delete while executions are active', () => {
    const core = testCore();
    const id = core.connections.create(admin, pgInput).id;
    core.library.createQuery(writer, { name: 'Recent orders', sql: 'SELECT 1', defaultConnectionId: id });
    core.profiles.create(admin, {
      name: 'Claude Code analytics',
      clientId: 'workbench-mcp',
      connectionIds: [id],
    });
    insertExecution(core, 'ex_running', id, 'running');
    const refs = core.connections.references(admin, id);
    assert.equal(refs.savedQueries.length, 1);
    assert.equal(refs.profiles[0]?.name, 'Claude Code analytics');
    assert.deepEqual(refs.activeExecutions, [{ id: 'ex_running', status: 'running' }]);
    assert.throws(() => core.connections.delete(admin, id), code('connection_busy'));

    core.db.run("UPDATE executions SET status = 'succeeded' WHERE id = 'ex_running'");
    core.connections.delete(admin, id);
    assert.throws(() => core.connections.get(admin, id), code('not_found'));
    const execution = core.db.get<{ connection_id: string | null; connection_name: string }>(
      "SELECT connection_id, connection_name FROM executions WHERE id = 'ex_running'",
    );
    assert.deepEqual({ ...execution }, { connection_id: null, connection_name: 'conn' });
    assert.equal(core.library.queries(writer)[0]?.defaultConnectionId, null);
    assert.deepEqual(core.profiles.list(admin)[0]?.connectionIds, []);
  });

  it('records enable and disable without cancelling anything', () => {
    const core = testCore();
    const id = core.connections.create(admin, pgInput).id;
    insertExecution(core, 'ex_q', id, 'queued');
    assert.equal(core.connections.setEnabled(admin, id, false).enabled, false);
    assert.equal(
      core.db.get<{ status: string }>("SELECT status FROM executions WHERE id = 'ex_q'")?.status,
      'queued',
    );
    assert.deepEqual(
      core.audit.list(admin, { actionPrefix: 'connection.' }).map((e) => e.action),
      ['connection.disable', 'connection.create'],
    );
  });
});
