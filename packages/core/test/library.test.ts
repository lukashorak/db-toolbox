import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/domain/errors.js';
import { reader, testCore, writer } from './helpers.js';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

function library() {
  const core = testCore();
  const lib = core.library;
  const analytics = lib.createFolder(writer, { name: 'Analytics' });
  const revenue = lib.createFolder(writer, { name: 'Revenue', parentId: analytics.id });
  const maintenance = lib.createFolder(writer, { name: 'Maintenance' });
  return { core, lib, analytics, revenue, maintenance };
}

describe('LibraryService', () => {
  it('lets a read-only database user save queries in nested folders', () => {
    const { lib } = library();
    const folder = lib.createFolder(reader, { name: 'Mine' });
    const q = lib.createQuery(reader, { name: 'Recent orders', folderId: folder.id, sql: 'SELECT 1' });
    assert.ok(q.id.startsWith('q_'));
    assert.equal(lib.folderPath(reader, folder.id), 'Mine');
  });

  it('builds folder paths and lists a folder with its subfolders', () => {
    const { lib, analytics, revenue } = library();
    lib.createQuery(writer, { name: 'Recent orders', folderId: analytics.id, sql: 'SELECT 1' });
    lib.createQuery(writer, { name: 'Monthly revenue', folderId: revenue.id, sql: 'SELECT 2' });
    assert.equal(lib.folderPath(writer, revenue.id), 'Analytics / Revenue');
    assert.deepEqual(
      lib.queries(writer, { folderId: analytics.id }).map((q) => q.name),
      ['Monthly revenue', 'Recent orders'],
    );
    assert.deepEqual(
      lib.queries(writer, { search: 'month' }).map((q) => q.name),
      ['Monthly revenue'],
    );
  });

  it('rejects duplicate names within a folder but allows them elsewhere', () => {
    const { lib, analytics, maintenance } = library();
    lib.createQuery(writer, { name: 'Recent orders', folderId: analytics.id, sql: 'SELECT 1' });
    assert.throws(
      () => lib.createQuery(writer, { name: 'recent ORDERS', folderId: analytics.id, sql: 'SELECT 1' }),
      (e: unknown) => e instanceof AppError && e.code === 'name_conflict' && /Analytics/.test(e.message),
    );
    lib.createQuery(writer, { name: 'Recent orders', folderId: maintenance.id, sql: 'SELECT 1' });
    assert.throws(() => lib.createFolder(writer, { name: 'a/b' }), code('validation_failed'));
  });

  it('keeps each user’s library private', () => {
    const { lib, analytics } = library();
    const q = lib.createQuery(writer, { name: 'Recent orders', folderId: analytics.id, sql: 'SELECT 1' });
    assert.equal(lib.queries(reader).length, 0);
    assert.throws(() => lib.query(reader, q.id), code('not_found'));
    assert.throws(
      () => lib.createQuery(reader, { name: 'x', folderId: analytics.id, sql: '' }),
      code('not_found'),
    );
  });

  it('prevents moving a folder into its own subtree', () => {
    const { lib, analytics, revenue } = library();
    assert.throws(
      () => lib.updateFolder(writer, analytics.id, { parentId: revenue.id }),
      code('folder_cycle'),
    );
    assert.throws(
      () => lib.updateFolder(writer, analytics.id, { parentId: analytics.id }),
      code('folder_cycle'),
    );
  });

  it('deletes a folder by moving its contents to the parent, or with its contents', () => {
    const { lib, analytics, revenue, maintenance } = library();
    lib.createQuery(writer, { name: 'Monthly revenue', folderId: revenue.id, sql: 'SELECT 2' });
    lib.createQuery(writer, { name: 'Orphans', folderId: maintenance.id, sql: 'SELECT 3' });
    assert.deepEqual(lib.deleteFolder(writer, revenue.id, 'move-to-parent'), {
      movedQueries: 1,
      deletedQueries: 0,
      folders: 1,
    });
    assert.equal(lib.queries(writer, { search: 'Monthly' })[0]?.folderId, analytics.id);
    assert.deepEqual(lib.deleteFolder(writer, maintenance.id, 'delete-contents'), {
      movedQueries: 0,
      deletedQueries: 1,
      folders: 1,
    });
    assert.deepEqual(
      lib.folders(writer).map((f) => f.name),
      ['Analytics'],
    );
  });

  it('refuses a move-to-parent that would create duplicate names', () => {
    const { lib, analytics, revenue } = library();
    lib.createQuery(writer, { name: 'Same', folderId: analytics.id, sql: '' });
    lib.createQuery(writer, { name: 'Same', folderId: revenue.id, sql: '' });
    assert.throws(() => lib.deleteFolder(writer, revenue.id, 'move-to-parent'), code('name_conflict'));
    assert.equal(lib.folders(writer).length, 3, 'nothing changed');
  });

  it('renames, moves and duplicates queries with audit events', () => {
    const { core, lib, analytics, maintenance } = library();
    const q = lib.createQuery(writer, { name: 'Recent orders', folderId: analytics.id, sql: 'SELECT 1' });
    lib.updateQuery(writer, q.id, { name: 'Latest orders' });
    lib.updateQuery(writer, q.id, { folderId: maintenance.id });
    const copy = lib.duplicateQuery(writer, q.id, { name: 'Latest orders (copy)' });
    assert.equal(copy.sql, 'SELECT 1');
    assert.equal(copy.folderId, maintenance.id);
    const actions = core.db
      .all<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'query.%' ORDER BY id")
      .map((r) => r.action);
    assert.deepEqual(actions, ['query.create', 'query.rename', 'query.move', 'query.create']);
  });
});
