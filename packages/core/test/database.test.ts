import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createCore } from '../src/core.js';
import { AppError } from '../src/domain/errors.js';
import { Database } from '../src/store/database.js';
import { MIGRATIONS } from '../src/store/migrations.js';
import { limits, TEST_KEY } from './helpers.js';

const dir = await mkdtemp(join(tmpdir(), 'workbench-db-'));
after(() => rm(dir, { recursive: true, force: true }));

describe('Database', () => {
  it('migrates an empty database to the latest version and is idempotent', () => {
    const file = join(dir, 'a.sqlite');
    const db = Database.open(file);
    assert.equal(db.schemaVersion, MIGRATIONS.at(-1)?.version);
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((t) => t.name);
    for (const t of [
      'audit_events',
      'connections',
      'executions',
      'exports',
      'mcp_profiles',
      'result_chunks',
      'saved_queries',
      'settings',
    ]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
    assert.equal(db.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode, 'wal');
    assert.equal(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys, 1);
    db.close();
    const again = Database.open(file);
    assert.equal(again.migrate(), MIGRATIONS.at(-1)?.version);
    again.close();
  });

  it('rolls back a failed transaction', () => {
    const db = Database.open(':memory:');
    assert.throws(() =>
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value, updated_at) VALUES ('a', '1', 'now')");
        throw new Error('boom');
      }),
    );
    assert.equal(db.get("SELECT key FROM settings WHERE key = 'a'"), undefined);
    db.close();
  });

  it('enforces enumerations with CHECK constraints', () => {
    const db = Database.open(':memory:');
    db.run(
      "INSERT INTO users (subject, username, display_name, first_seen_at, last_seen_at) VALUES ('u', 'u', 'u', 'n', 'n')",
    );
    assert.throws(() =>
      db.run(
        `INSERT INTO connections (id, owner, name, engine, environment, host, port, database_name, username, secret, tls_mode, read_only, enabled, created_at, updated_at)
         VALUES ('c', 'u', 'n', 'oracle', 'production', 'h', 1, 'd', 'u', 's', 'verify-full', 1, 1, 'n', 'n')`,
      ),
    );
    db.close();
  });
});

describe('encryption key check', () => {
  it('fails fast when the key differs from the one used for stored credentials', () => {
    const file = join(dir, 'key.sqlite');
    createCore({ databaseFile: file, encryptionKey: TEST_KEY, limits }).close();
    createCore({ databaseFile: file, encryptionKey: TEST_KEY, limits }).close();
    assert.throws(
      () => createCore({ databaseFile: file, encryptionKey: Buffer.alloc(32, 9), limits }),
      (e: unknown) => e instanceof AppError && e.code === 'encryption_key_mismatch',
    );
  });
});
