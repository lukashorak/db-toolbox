import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DATABASE_FILE = 'workbench.sqlite';

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface Readiness {
  ready: boolean;
  checks: { database: CheckResult; exports: CheckResult };
}

const reason = (error: unknown): string =>
  error && typeof error === 'object' && 'code' in error ? String(error.code) : 'error';

/**
 * Confirms the application database can take a write lock. It opens the file, acquires an
 * immediate transaction and rolls it back, so a probe never changes data.
 */
export function checkDatabase(dataDir: string): CheckResult {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(dataDir, DATABASE_FILE));
    db.exec('PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE; ROLLBACK;');
    return { ok: true, detail: 'writable' };
  } catch (error) {
    return { ok: false, detail: `not writable (${reason(error)})` };
  } finally {
    db?.close();
  }
}

/** Confirms the mounted export folder exists and is writable by this process. */
export async function checkExportDir(exportDir: string): Promise<CheckResult> {
  try {
    await access(exportDir, constants.W_OK);
    return { ok: true, detail: 'writable' };
  } catch (error) {
    return { ok: false, detail: `not writable (${reason(error)})` };
  }
}

export async function checkReadiness(dirs: { dataDir: string; exportDir: string }): Promise<Readiness> {
  const database = checkDatabase(dirs.dataDir);
  const exports = await checkExportDir(dirs.exportDir);
  return { ready: database.ok && exports.ok, checks: { database, exports } };
}
