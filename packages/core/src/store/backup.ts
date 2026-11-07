import { copyFileSync, existsSync, renameSync, rmSync, statSync, chmodSync, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { AppError } from '../domain/errors.js';
import { KEY_CHECK, keyStatus } from '../security/key-check.js';
import { SecretBox } from '../security/secrets.js';
import { Database, type Row } from './database.js';
import { MIGRATIONS } from './migrations.js';

const HEARTBEAT = 'server.heartbeat';
/** A server writes its heartbeat every 15 seconds; older than this, it is considered stopped. */
export const HEARTBEAT_STALE_MS = 45_000;
const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

/** Records that a server process uses this database (called periodically while it runs). */
export function markAlive(db: Database, now: Date): void {
  db.run(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (:key, :value, NULL, :now)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    {
      key: HEARTBEAT,
      value: JSON.stringify({ pid: process.pid, host: hostname() }),
      now: now.toISOString(),
    },
  );
}

/** Called on a clean shutdown, so a restore does not have to wait for the heartbeat to age. */
export function markStopped(db: Database): void {
  db.run('DELETE FROM settings WHERE key = :key', { key: HEARTBEAT });
}

function lastAlive(raw: DatabaseSync): Date | null {
  try {
    const row = raw.prepare('SELECT updated_at FROM settings WHERE key = ?').get(HEARTBEAT) as
      Row | undefined;
    return row ? new Date(String(row.updated_at)) : null;
  } catch {
    return null;
  }
}

export interface BackupReport {
  file: string;
  bytes: number;
  schemaVersion: number;
}

/**
 * Online backup with SQLite's backup API: a consistent copy while the server keeps running. The
 * copy holds sealed credentials but never the encryption key, which is backed up separately.
 */
export async function backupDatabase(sourceFile: string, destination: string): Promise<BackupReport> {
  if (!existsSync(sourceFile)) throw new AppError('not_found', `No database at ${sourceFile}.`);
  if (existsSync(destination)) throw new AppError('name_conflict', `${destination} already exists.`);
  mkdirSync(dirname(destination), { recursive: true });
  const partial = join(dirname(destination), `.${basename(destination)}.partial`);
  rmSync(partial, { force: true });
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try {
    await backup(source, partial);
  } finally {
    source.close();
  }
  chmodSync(partial, 0o600);
  const check = inspectFile(partial);
  if (check.integrity !== 'ok') {
    rmSync(partial, { force: true });
    throw new AppError('internal', `The backup failed its integrity check: ${check.integrity}`);
  }
  renameSync(partial, destination);
  return { file: destination, bytes: statSync(destination).size, schemaVersion: check.schemaVersion };
}

export interface BackupInspection {
  integrity: string;
  schemaVersion: number;
  /** Highest schema version this build knows. */
  latestVersion: number;
  /** Whether the configured ENCRYPTION_KEY opens the credentials stored in the file. */
  key: 'match' | 'mismatch' | 'not_set' | 'not_checked';
  problems: string[];
}

function inspectFile(file: string, encryptionKey?: Buffer): BackupInspection {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = String(
      (raw.prepare('PRAGMA integrity_check').get() as Row | undefined)?.integrity_check ?? 'unknown',
    );
    const schemaVersion = Number((raw.prepare('PRAGMA user_version').get() as Row).user_version);
    let key: BackupInspection['key'] = 'not_checked';
    const problems: string[] = [];
    if (encryptionKey && schemaVersion > 0) {
      try {
        const row = raw.prepare('SELECT value FROM settings WHERE key = ?').get(KEY_CHECK) as Row | undefined;
        key = keyStatus(row ? String(row.value) : null, new SecretBox(encryptionKey));
      } catch {
        problems.push('The file has no workbench settings table.');
      }
    }
    if (integrity !== 'ok') problems.push(`Integrity check failed: ${integrity}`);
    if (schemaVersion === 0) problems.push('This is not a workbench database (schema version 0).');
    if (schemaVersion > LATEST)
      problems.push(
        `The file has schema version ${schemaVersion}, newer than this release (${LATEST}). Use the release that made it.`,
      );
    if (key === 'mismatch')
      problems.push(
        'ENCRYPTION_KEY does not open the credentials in this file. Use the key that was active when it was made.',
      );
    return { integrity, schemaVersion, latestVersion: LATEST, key, problems };
  } finally {
    raw.close();
  }
}

/** Checks a backup before it is restored: integrity, schema version and the encryption key. */
export function inspectBackup(file: string, encryptionKey: Buffer): BackupInspection {
  if (!existsSync(file)) throw new AppError('not_found', `No file at ${file}.`);
  return inspectFile(file, encryptionKey);
}

export interface RestoreReport {
  /** Where the replaced database was moved, if there was one. */
  previous: string | null;
  schemaVersion: number;
  migratedFrom: number;
}

/**
 * Replaces the application database with a backup. Refuses while a server uses the database, and
 * when the backup fails inspection. The replaced file is kept next to it.
 */
export function restoreDatabase(
  liveFile: string,
  backupFile: string,
  encryptionKey: Buffer,
  now = new Date(),
): RestoreReport {
  const inspection = inspectBackup(backupFile, encryptionKey);
  if (inspection.problems.length) throw new AppError('validation_failed', inspection.problems.join(' '));
  let previous: string | null = null;
  if (existsSync(liveFile)) {
    const live = new DatabaseSync(liveFile);
    try {
      const alive = lastAlive(live);
      if (alive && now.getTime() - alive.getTime() < HEARTBEAT_STALE_MS) {
        throw new AppError(
          'connection_busy',
          `A workbench server is using ${liveFile} (last seen ${alive.toISOString()}). Stop it before restoring.`,
        );
      }
      // Fold the write-ahead log into the file, so the copy kept aside is complete on its own.
      live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      live.close();
    }
    previous = `${liveFile}.before-restore-${now.toISOString().replace(/[:.]/g, '-')}`;
    renameSync(liveFile, previous);
    for (const suffix of ['-wal', '-shm']) rmSync(`${liveFile}${suffix}`, { force: true });
  }
  const partial = `${liveFile}.restoring`;
  copyFileSync(backupFile, partial);
  chmodSync(partial, 0o600);
  renameSync(partial, liveFile);
  // Opening applies the migrations a backup from an older release needs.
  const db = Database.open(liveFile);
  try {
    markStopped(db);
    return { previous, schemaVersion: db.schemaVersion, migratedFrom: inspection.schemaVersion };
  } finally {
    db.close();
  }
}
