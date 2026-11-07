import { z } from 'zod';
import type { Limits } from '../config.js';
import type { Actor } from '../domain/types.js';
import { requirePermission } from '../security/policy.js';
import { isoNow, type ServiceContext } from './context.js';
import { fieldError, parseInput } from './validation.js';

/** Defaults administrators may change at run time. Deployment limits remain the upper bounds. */
export interface ExecutionDefaults {
  ordinaryTimeoutMs: number;
  fullTimeoutMaxMs: number;
  concurrencyPerConnection: number;
  workingRetentionHours: number;
  retainedMaxDays: number;
  metadataRetentionDays: number;
  monitoringRefreshSeconds: number;
}

const KEY = 'execution.defaults';

const schema = z
  .object({
    ordinaryTimeoutMs: z.number().int().min(1000).max(3_600_000),
    fullTimeoutMaxMs: z.number().int().min(1000).max(3_600_000),
    concurrencyPerConnection: z.number().int().min(1).max(8),
    workingRetentionHours: z.number().int().min(1).max(168),
    retainedMaxDays: z.number().int().min(1).max(30),
    metadataRetentionDays: z.number().int().min(7).max(3650),
    monitoringRefreshSeconds: z.number().int().min(5).max(300),
  })
  .partial()
  .strict();

export const builtInDefaults = (limits: Limits): ExecutionDefaults => ({
  ordinaryTimeoutMs: limits.ordinaryTimeoutMs,
  fullTimeoutMaxMs: limits.fullTimeoutMaxMs,
  concurrencyPerConnection: limits.concurrencyPerConnection,
  workingRetentionHours: 24,
  retainedMaxDays: 7,
  metadataRetentionDays: 90,
  monitoringRefreshSeconds: 15,
});

export class SettingsService {
  constructor(private readonly ctx: ServiceContext) {}

  /** Effective defaults: built-in values overlaid with saved administrator changes. */
  defaults(): ExecutionDefaults {
    const row = this.ctx.db.get('SELECT value FROM settings WHERE key = :key', { key: KEY });
    const saved = row ? (JSON.parse(String(row.value)) as Partial<ExecutionDefaults>) : {};
    return { ...builtInDefaults(this.ctx.limits), ...saved };
  }

  /** Changing a limit never changes grants in target databases. */
  updateDefaults(actor: Actor, input: Partial<ExecutionDefaults>): ExecutionDefaults {
    requirePermission(actor, 'settings.manage');
    const patch = parseInput(schema, input);
    const before = this.defaults();
    const next = { ...before, ...patch };
    if (next.fullTimeoutMaxMs > this.ctx.limits.fullTimeoutMaxMs) {
      throw fieldError(
        'fullTimeoutMaxMs',
        'This exceeds the maximum set by the deployment (FULL_TIMEOUT_MAX_MS).',
      );
    }
    if (next.ordinaryTimeoutMs > next.fullTimeoutMaxMs) {
      throw fieldError('ordinaryTimeoutMs', 'The ordinary timeout cannot exceed the full-result maximum.');
    }
    const builtIn = builtInDefaults(this.ctx.limits);
    const stored = Object.fromEntries(
      Object.entries(next).filter(([key, value]) => builtIn[key as keyof ExecutionDefaults] !== value),
    );
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (:key, :value, :by, :now)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        { key: KEY, value: JSON.stringify(stored), by: actor.subject, now: isoNow(this.ctx) },
      );
      this.ctx.audit.record({
        actor,
        action: 'settings.update',
        target: { type: 'settings', id: KEY, label: 'Execution defaults' },
        outcome: 'succeeded',
        details: {
          changed: Object.fromEntries(
            Object.entries(patch)
              .filter(([key, value]) => before[key as keyof ExecutionDefaults] !== value)
              .map(([key, value]) => [key, { from: before[key as keyof ExecutionDefaults], to: value }]),
          ),
        },
      });
    });
    return this.defaults();
  }
}
