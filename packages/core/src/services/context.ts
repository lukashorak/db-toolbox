import type { AuditLog } from '../audit.js';
import type { Limits } from '../config.js';
import type { Clock } from '../domain/types.js';
import type { SecretBox } from '../security/secrets.js';
import type { Database } from '../store/database.js';

/** Dependencies shared by the core services. */
export interface ServiceContext {
  db: Database;
  secrets: SecretBox;
  audit: AuditLog;
  clock: Clock;
  /** Deployment limits; administrators may lower some of them through settings. */
  limits: Limits;
  /** Called after a connection is changed, disabled or deleted, so open pools are replaced. */
  onConnectionChanged?: (id: string) => void;
  /** Called when stored result data is removed outside the execution service. */
  onResultBytesFreed?: (bytes: number) => void;
}

export const isoNow = (ctx: ServiceContext): string => ctx.clock.now().toISOString();

/** Reports which fields of an update actually change, for audit details. */
export function changedFields<T extends object>(before: T, patch: Partial<T>): string[] {
  return Object.entries(patch)
    .filter(([key, value]) => value !== undefined && (before as Record<string, unknown>)[key] !== value)
    .map(([key]) => key);
}
