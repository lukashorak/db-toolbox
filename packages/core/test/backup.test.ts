import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createCore } from '../src/core.js';
import { AppError } from '../src/domain/errors.js';
import {
  backupDatabase,
  HEARTBEAT_STALE_MS,
  inspectBackup,
  markAlive,
  markStopped,
  restoreDatabase,
} from '../src/store/backup.js';
import { admin, limits, pgInput, TEST_KEY } from './helpers.js';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;
const OTHER_KEY = Buffer.alloc(32, 9);

describe('backup and restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-backup-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const live = join(dir, 'workbench.sqlite');

  function seed(name: string) {
    const core = createCore({ databaseFile: live, encryptionKey: TEST_KEY, limits });
    core.users.touch(admin);
    core.connections.create(admin, { ...pgInput, name });
    return core;
  }
  const names = () => {
    const core = createCore({ databaseFile: live, encryptionKey: TEST_KEY, limits });
    try {
      return core.connections.list(admin).map((c) => c.name);
    } finally {
      core.close();
    }
  };

  it('copies a running database consistently and checks the copy', async () => {
    const core = seed('Before backup');
    const file = join(dir, 'backups', 'one.sqlite');
    const report = await backupDatabase(live, file);
    // Written while the server keeps its connection open: the copy reflects committed state.
    core.connections.create(admin, { ...pgInput, name: 'After backup' });
    core.close();
    assert.equal(report.file, file);
    assert.ok(report.bytes > 0 && report.schemaVersion >= 1);
    assert.equal((statSync(file).mode & 0o777).toString(8), '600');
    await assert.rejects(backupDatabase(live, file), code('name_conflict'));

    const ok = inspectBackup(file, TEST_KEY);
    assert.deepEqual([ok.integrity, ok.key, ok.problems], ['ok', 'match', []]);
    const wrongKey = inspectBackup(file, OTHER_KEY);
    assert.equal(wrongKey.key, 'mismatch');
    assert.match(wrongKey.problems.join(), /ENCRYPTION_KEY does not open/);
  });

  it('restores only when no server is using the database, keeping the replaced file', () => {
    const file = join(dir, 'backups', 'one.sqlite');
    const core = createCore({ databaseFile: live, encryptionKey: TEST_KEY, limits });
    markAlive(core.db, new Date());
    assert.throws(() => restoreDatabase(live, file, TEST_KEY), code('connection_busy'));
    // A heartbeat that stopped long ago (a crashed server) does not block.
    const later = new Date(Date.now() + HEARTBEAT_STALE_MS + 1000);
    assert.throws(() => restoreDatabase(live, file, OTHER_KEY, later), code('validation_failed'));
    markStopped(core.db);
    core.close();

    const report = restoreDatabase(live, file, TEST_KEY);
    assert.ok(report.previous && existsSync(report.previous));
    assert.equal(report.schemaVersion, report.migratedFrom);
    assert.deepEqual(names(), ['Before backup']);
    // The replaced database is a complete file on its own, write-ahead log folded in.
    const previous = new DatabaseSync(String(report.previous), { readOnly: true });
    const kept = previous.prepare('SELECT name FROM connections ORDER BY name').all();
    previous.close();
    assert.deepEqual(
      kept.map((r) => r.name),
      ['After backup', 'Before backup'],
    );
  });

  it('refuses files that are not workbench backups or come from a newer release', () => {
    const junk = join(dir, 'junk.sqlite');
    writeFileSync(junk, 'not a database');
    assert.throws(() => inspectBackup(junk, TEST_KEY));
    const empty = join(dir, 'empty.sqlite');
    new DatabaseSync(empty).close();
    assert.match(inspectBackup(empty, TEST_KEY).problems.join(), /not a workbench database/);
    const newer = join(dir, 'newer.sqlite');
    const db = new DatabaseSync(newer);
    db.exec('PRAGMA user_version = 999');
    db.close();
    assert.match(inspectBackup(newer, TEST_KEY).problems.join(), /newer than this release/);
    assert.throws(() => restoreDatabase(live, newer, TEST_KEY), code('validation_failed'));
    assert.throws(() => inspectBackup(join(dir, 'missing.sqlite'), TEST_KEY), code('not_found'));
  });
});
