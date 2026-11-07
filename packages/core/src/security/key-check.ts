import { AppError } from '../domain/errors.js';
import type { Clock } from '../domain/types.js';
import type { Database } from '../store/database.js';
import type { SecretBox } from './secrets.js';

/** Settings row holding a value sealed with the encryption key, to detect a wrong key early. */
export const KEY_CHECK = 'security.key_check';
const KEY_CHECK_VALUE = 'database-workbench';

/** Whether `secrets` opens a sealed key check value (`null` when the database has none yet). */
export function keyStatus(sealed: string | null, secrets: SecretBox): 'match' | 'mismatch' | 'not_set' {
  if (sealed === null) return 'not_set';
  try {
    return secrets.open<string>(sealed, KEY_CHECK) === KEY_CHECK_VALUE ? 'match' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}

/**
 * Confirms that the configured key is the one used for stored credentials. On first start it
 * stores a sealed check value; later starts fail fast instead of failing on the first connection.
 */
export function verifyEncryptionKey(db: Database, secrets: SecretBox, clock: Clock): void {
  const row = db.get('SELECT value FROM settings WHERE key = :key', { key: KEY_CHECK });
  const status = keyStatus(row ? String(row.value) : null, secrets);
  if (status === 'match') return;
  if (status === 'not_set') {
    db.run('INSERT INTO settings (key, value, updated_by, updated_at) VALUES (:key, :value, NULL, :now)', {
      key: KEY_CHECK,
      value: secrets.seal(KEY_CHECK_VALUE, KEY_CHECK),
      now: clock.now().toISOString(),
    });
    return;
  }
  throw new AppError(
    'encryption_key_mismatch',
    'ENCRYPTION_KEY does not match the key used to store credentials. Restore the original key; stored credentials cannot be read without it.',
  );
}
