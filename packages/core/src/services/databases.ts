import { z } from 'zod';
import { AppError } from '../domain/errors.js';
import { ENGINES, TLS_MODES, type Actor, type ConnectionView } from '../domain/types.js';
import type { ConnectionTestReport } from '../db/connection-test.js';
import type { AdapterRegistry } from '../db/registry.js';
import type { ConnectionTarget, DbAdapter } from '../db/types.js';
import { requirePermission } from '../security/policy.js';
import type { ConnectionService } from './connections.js';
import type { ServiceContext } from './context.js';
import type { ProfileService } from './profiles.js';
import { fieldError, isHost, isPemCertificate, parseInput } from './validation.js';

/** Unsaved settings from the connection form. A blank password reuses the stored one. */
const draftSchema = z
  .object({
    connectionId: z.string().optional(),
    engine: z.enum(ENGINES),
    host: z
      .string()
      .trim()
      .min(1)
      .refine(isHost, 'Use a host name or IP address without scheme, port or path.'),
    port: z.number().int().min(1).max(65535),
    database: z.string().trim().min(1).max(128),
    schema: z.string().trim().min(1).max(128).nullable().default(null),
    username: z.string().trim().min(1).max(128),
    password: z.string().max(4096).default(''),
    tlsMode: z.enum(TLS_MODES),
    caPem: z
      .string()
      .trim()
      .max(65536)
      .refine(isPemCertificate, 'Paste a PEM certificate.')
      .nullable()
      .default(null),
  })
  .strict();

export type ConnectionDraft = z.input<typeof draftSchema>;

/**
 * Access to target databases: the adapter for a connection the actor may use, and connection
 * tests. Decrypted credentials never leave core.
 */
export class DatabaseService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly registry: AdapterRegistry,
    private readonly connections: ConnectionService,
    private readonly profiles: ProfileService,
  ) {}

  /** Checks that the actor may use the connection: enabled, and for MCP part of the profile. */
  usable(actor: Actor, connectionId: string): ConnectionView {
    const connection = this.connections.get(actor, connectionId);
    if (actor.source === 'mcp') {
      const profile = this.profiles.findByClientId(actor.clientId);
      if (!profile || profile.id !== actor.profileId || !profile.connectionIds.includes(connectionId)) {
        throw new AppError('forbidden', `MCP profile does not allow connection “${connection.name}”.`);
      }
    }
    if (!connection.enabled) {
      throw new AppError('connection_disabled', `Connection “${connection.name}” is disabled.`);
    }
    return connection;
  }

  /** Adapter for metadata browsing (`sql.read`) or monitoring (`monitor.view`). */
  async adapter(
    actor: Actor,
    connectionId: string,
    purpose: 'query' | 'monitor' = 'query',
  ): Promise<DbAdapter> {
    requirePermission(actor, purpose === 'monitor' ? 'monitor.view' : 'sql.read');
    this.usable(actor, connectionId);
    return this.registry.get(this.connections.credentials(connectionId));
  }

  /** Adapter for work that was authorized earlier (a queued execution re-checked at start). */
  async adapterForConnection(connectionId: string): Promise<DbAdapter> {
    return this.registry.get(this.connections.credentials(connectionId));
  }

  /** Tests a stored connection and records the result on it. */
  async test(actor: Actor, connectionId: string): Promise<ConnectionTestReport> {
    requirePermission(actor, 'connections.manage');
    const target = this.connections.credentials(connectionId);
    const report = await this.registry.test(target);
    this.connections.recordTest(connectionId, report);
    this.audit(actor, report, { id: connectionId, label: target.name });
    return report;
  }

  /** Tests settings from the connection form before they are saved. */
  async testDraft(actor: Actor, input: ConnectionDraft): Promise<ConnectionTestReport> {
    requirePermission(actor, 'connections.manage');
    const draft = parseInput(draftSchema, input);
    let password = draft.password;
    let caPem = draft.caPem;
    let name = 'Unsaved connection';
    if (draft.connectionId) {
      const stored = this.connections.credentials(draft.connectionId);
      if (stored.engine !== draft.engine)
        throw fieldError('engine', 'The engine of a connection cannot change.');
      if (!password) password = stored.password;
      if (input.caPem === undefined) caPem = stored.caPem;
      name = stored.name;
    }
    if (!password) throw fieldError('password', 'Enter the password to test a new connection.');
    const target: ConnectionTarget = {
      id: draft.connectionId ?? 'draft',
      name,
      engine: draft.engine,
      host: draft.host,
      port: draft.port,
      database: draft.database,
      schema: draft.engine === 'mysql' ? null : draft.schema,
      username: draft.username,
      password,
      tlsMode: draft.tlsMode,
      caPem,
    };
    const report = await this.registry.test(target);
    this.audit(actor, report, { id: draft.connectionId ?? null, label: name });
    return report;
  }

  private audit(actor: Actor, report: ConnectionTestReport, target: { id: string | null; label: string }) {
    this.ctx.audit.record({
      actor,
      action: 'connection.test',
      target: { type: 'connection', id: target.id, label: target.label },
      outcome: report.ok ? 'succeeded' : 'failed',
      details: { failure: report.failure?.category ?? null, server: report.server?.version ?? null },
    });
  }
}

export { draftSchema as connectionDraftSchema };
