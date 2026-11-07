import { AuditLog } from './audit.js';
import type { Limits } from './config.js';
import { systemClock, type Clock } from './domain/types.js';
import { AdapterRegistry } from './db/registry.js';
import { DisclosureService } from './execution/disclosure.js';
import { ExportService } from './execution/exports.js';
import { ExecutionService, type ExecutionOptions } from './execution/service.js';
import { MonitoringService } from './monitoring/service.js';
import { verifyEncryptionKey } from './security/key-check.js';
import { SecretBox } from './security/secrets.js';
import { ConnectionService } from './services/connections.js';
import { DatabaseService } from './services/databases.js';
import type { ServiceContext } from './services/context.js';
import { LibraryService } from './services/library.js';
import { ProfileService } from './services/profiles.js';
import { SettingsService } from './services/settings.js';
import { UserService } from './services/users.js';
import { Database } from './store/database.js';

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
  /** What MCP clients may receive of results, and human approvals beyond that. */
  disclosure: DisclosureService;
  /** Database-wide activity, lock waits, counters and statement statistics (read-only). */
  monitoring: MonitoringService;
  /** Retention: export files first, then captured results and old execution metadata. */
  cleanup(now?: Date): Promise<{
    exportsExpired: number;
    resultsExpired: number;
    bytesFreed: number;
    executionsDeleted: number;
  }>;
  /** Closes the application database; open pools close in the background. */
  close(): void;
  /**
   * Lets running executions finish for up to `graceMs` (then interrupts them), waits for exports,
   * closes pools to target databases, then the application database.
   */
  shutdown(options?: { graceMs?: number }): Promise<void>;
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
    disclosure: new DisclosureService(ctx, profiles),
    monitoring: new MonitoringService(databases),
    cleanup: async (now) => {
      const exportsExpired = await exportService.cleanup(now);
      return { exportsExpired, ...executions.cleanup(now) };
    },
    close: () => {
      void executions.stop();
      void registry.closeAll();
      db.close();
    },
    shutdown: async (options = {}) => {
      await executions.stop(options.graceMs ?? 0);
      await exportService.idle();
      await registry.closeAll();
      db.close();
    },
  };
}
