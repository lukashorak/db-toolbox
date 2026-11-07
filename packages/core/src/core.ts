import { AuditLog } from './audit.js';
import type { Limits } from './config.js';
import { AppError } from './domain/errors.js';
import { systemClock, type Clock } from './domain/types.js';
import { AdapterRegistry } from './db/registry.js';
import { ExportService } from './execution/exports.js';
import { ExecutionService, type ExecutionOptions } from './execution/service.js';
import { SecretBox } from './security/secrets.js';
import { ConnectionService } from './services/connections.js';
import { DatabaseService } from './services/databases.js';
import type { ServiceContext } from './services/context.js';
import { LibraryService } from './services/library.js';
import { ProfileService } from './services/profiles.js';
import { SettingsService } from './services/settings.js';
import { UserService } from './services/users.js';
import { Database } from './store/database.js';

const KEY_CHECK = 'security.key_check';
const KEY_CHECK_VALUE = 'database-workbench';

export interface CoreOptions {
  /** Path of the SQLite file, or `:memory:` in tests. */
  databaseFile: string;
  encryptionKey: Buffer;
  limits: Limits;
  clock?: Clock;
  executions?: ExecutionOptions;
  /** Folder for export files (EXPORT_DIR). Without it, exports are unavailable. */
  exportDir?: string;
}

export interface Core {
  db: Database;
  audit: AuditLog;
  users: UserService;
  connections: ConnectionService;
  profiles: ProfileService;
  library: LibraryService;
  settings: SettingsService;
  /** Target databases: adapters (pools opened on first use) and connection tests. */
  databases: DatabaseService;
  /** Server-owned executions: queue, runs, captured results. */
  executions: ExecutionService;
  /** CSV and JSON exports of captured results. */
  exports: ExportService;
  /** Retention: export files first, then captured results and old execution metadata. */
  cleanup(now?: Date): Promise<{
    exportsExpired: number;
    resultsExpired: number;
    bytesFreed: number;
    executionsDeleted: number;
  }>;
  /** Closes the application database; open pools close in the background. */
  close(): void;
  /** Closes pools to target databases, then the application database. */
  shutdown(): Promise<void>;
}

/**
 * Confirms that the configured key is the one used for stored credentials. On first start it
 * stores a sealed check value; later starts fail fast instead of failing on the first connection.
 */
export function verifyEncryptionKey(db: Database, secrets: SecretBox, clock: Clock): void {
  const row = db.get('SELECT value FROM settings WHERE key = :key', { key: KEY_CHECK });
  if (!row) {
    db.run('INSERT INTO settings (key, value, updated_by, updated_at) VALUES (:key, :value, NULL, :now)', {
      key: KEY_CHECK,
      value: secrets.seal(KEY_CHECK_VALUE, KEY_CHECK),
      now: clock.now().toISOString(),
    });
    return;
  }
  try {
    if (secrets.open<string>(String(row.value), KEY_CHECK) === KEY_CHECK_VALUE) return;
  } catch {
    // fall through
  }
  throw new AppError(
    'encryption_key_mismatch',
    'ENCRYPTION_KEY does not match the key used to store credentials. Restore the original key; stored credentials cannot be read without it.',
  );
}

export function createCore(options: CoreOptions): Core {
  const clock = options.clock ?? systemClock;
  const db = Database.open(options.databaseFile);
  const secrets = new SecretBox(options.encryptionKey);
  try {
    verifyEncryptionKey(db, secrets, clock);
  } catch (error) {
    db.close();
    throw error;
  }
  const audit = new AuditLog(db, clock);
  const registry = new AdapterRegistry({
    // Work slots are shared by the GUI and MCP; metadata and control connections are reserved.
    sizes: { work: options.limits.concurrencyPerConnection, metadata: 1, control: 1 },
  });
  const ctx: ServiceContext = {
    db,
    secrets,
    audit,
    clock,
    limits: options.limits,
    onConnectionChanged: (id) => void registry.invalidate(id),
    onResultBytesFreed: (bytes) => executions.releaseStorage(bytes),
  };
  const connections = new ConnectionService(ctx);
  const profiles = new ProfileService(ctx);
  const settings = new SettingsService(ctx);
  const databases = new DatabaseService(ctx, registry, connections, profiles);
  const executions = new ExecutionService(
    ctx,
    { databases, connections, profiles, settings },
    options.executions,
  );
  const exportService = new ExportService(ctx, options.exportDir ?? null);
  return {
    db,
    audit,
    users: new UserService(ctx),
    connections,
    profiles,
    library: new LibraryService(ctx),
    settings,
    databases,
    executions,
    exports: exportService,
    cleanup: async (now) => {
      const exportsExpired = await exportService.cleanup(now);
      return { exportsExpired, ...executions.cleanup(now) };
    },
    close: () => {
      void executions.stop();
      void registry.closeAll();
      db.close();
    },
    shutdown: async () => {
      await executions.stop();
      await exportService.idle();
      await registry.closeAll();
      db.close();
    },
  };
}
