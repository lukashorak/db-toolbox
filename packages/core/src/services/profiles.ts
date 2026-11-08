import { z } from 'zod';
import { AppError, assert } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import type { Actor, ProfileView } from '../domain/types.js';
import { evaluateWritePolicy, requirePermission, type WritePolicy } from '../security/policy.js';
import { bool, int, type Row } from '../store/database.js';
import { changedFields, isoNow, type ServiceContext } from './context.js';
import { fieldError, parseInput } from './validation.js';

const fields = {
  name: z.string().trim().min(1, 'Enter a name.').max(80, 'Use 80 characters or fewer.'),
  clientId: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use lower-case letters, digits and hyphens (2–63 characters).'),
  connectionIds: z.array(z.string()).min(1, 'Allow at least one connection.').max(100),
  readOnly: z.boolean(),
  enabled: z.boolean(),
  timeoutMs: z.number().int().positive(),
  previewRows: z.number().int().positive(),
  previewBytes: z.number().int().positive(),
};

const createSchema = z
  .object({
    ...fields,
    readOnly: fields.readOnly.default(true),
    enabled: fields.enabled.default(true),
    timeoutMs: fields.timeoutMs.optional(),
    previewRows: fields.previewRows.optional(),
    previewBytes: fields.previewBytes.optional(),
  })
  .strict();
const updateSchema = z.object(fields).omit({ clientId: true }).partial().strict();

export type CreateProfileInput = z.input<typeof createSchema>;
export type UpdateProfileInput = z.input<typeof updateSchema>;

export interface EffectiveAccess {
  connectionId: string;
  connectionName: string;
  allowed: boolean;
  /** Present when the connection is allowed for the profile. */
  policy: WritePolicy | null;
}

export class ProfileService {
  constructor(private readonly ctx: ServiceContext) {}

  list(actor: Actor): ProfileView[] {
    requirePermission(actor, 'connections.view');
    return this.ctx.db.all('SELECT * FROM mcp_profiles ORDER BY lower(name)').map((r) => this.toView(r));
  }

  get(actor: Actor, id: string): ProfileView {
    requirePermission(actor, 'connections.view');
    return this.toView(this.row(id));
  }

  /** Resolves the profile bound to an OAuth client. Used by MCP authentication; no permission check. */
  findByClientId(clientId: string): ProfileView | undefined {
    const row = this.ctx.db.get('SELECT * FROM mcp_profiles WHERE client_id = :clientId', { clientId });
    return row ? this.toView(row) : undefined;
  }

  create(actor: Actor, input: CreateProfileInput): ProfileView {
    requirePermission(actor, 'profiles.manage');
    const v = parseInput(createSchema, input);
    const limits = this.checkLimits({
      timeoutMs: v.timeoutMs ?? this.ctx.limits.ordinaryTimeoutMs,
      previewRows: v.previewRows ?? this.ctx.limits.mcpPreviewRows,
      previewBytes: v.previewBytes ?? this.ctx.limits.mcpPreviewBytes,
    });
    const id = newId('profile', this.ctx.clock.now());
    const now = isoNow(this.ctx);
    this.ctx.db.transaction(() => {
      this.assertNameFree(v.name);
      const bound = this.findByClientId(v.clientId);
      if (bound) {
        throw new AppError(
          'client_id_conflict',
          `OAuth client ${v.clientId} is already bound to “${bound.name}”.`,
          {
            field: 'clientId',
          },
        );
      }
      this.ctx.db.run(
        `INSERT INTO mcp_profiles (id, owner, name, client_id, read_only, enabled, timeout_ms, preview_rows, preview_bytes, created_at, updated_at)
         VALUES (:id, :owner, :name, :client, :ro, :enabled, :timeout, :rows, :bytes, :now, :now)`,
        {
          id,
          owner: actor.subject,
          name: v.name,
          client: v.clientId,
          ro: int(v.readOnly),
          enabled: int(v.enabled),
          timeout: limits.timeoutMs,
          rows: limits.previewRows,
          bytes: limits.previewBytes,
          now,
        },
      );
      this.setConnections(id, v.connectionIds);
      this.ctx.audit.record({
        actor,
        action: 'mcp_profile.create',
        target: { type: 'mcp_profile', id, label: v.name },
        outcome: 'succeeded',
        details: { clientId: v.clientId, readOnly: v.readOnly, connections: v.connectionIds.length },
      });
    });
    return this.toView(this.row(id));
  }

  /**
   * Updates a profile. Pending disclosure requests that the profile can no longer satisfy (it is
   * disabled or lost access to the connection) are denied. Committed work is never rolled back.
   */
  update(
    actor: Actor,
    id: string,
    input: UpdateProfileInput,
  ): { profile: ProfileView; cancelledRequests: number } {
    requirePermission(actor, 'profiles.manage');
    const patch = parseInput(updateSchema, input);
    const before = this.toView(this.row(id));
    const limits = this.checkLimits({
      timeoutMs: patch.timeoutMs ?? before.timeoutMs,
      previewRows: patch.previewRows ?? before.previewRows,
      previewBytes: patch.previewBytes ?? before.previewBytes,
    });
    let cancelled = 0;
    this.ctx.db.transaction(() => {
      if (patch.name !== undefined && patch.name.toLowerCase() !== before.name.toLowerCase())
        this.assertNameFree(patch.name);
      const enabled = patch.enabled ?? before.enabled;
      this.ctx.db.run(
        `UPDATE mcp_profiles SET name = :name, read_only = :ro, enabled = :enabled, timeout_ms = :timeout,
           preview_rows = :rows, preview_bytes = :bytes, updated_at = :now WHERE id = :id`,
        {
          id,
          name: patch.name ?? before.name,
          ro: int(patch.readOnly ?? before.readOnly),
          enabled: int(enabled),
          timeout: limits.timeoutMs,
          rows: limits.previewRows,
          bytes: limits.previewBytes,
          now: isoNow(this.ctx),
        },
      );
      if (patch.connectionIds) this.setConnections(id, patch.connectionIds);
      cancelled = this.ctx.db.run(
        `UPDATE disclosure_approvals SET status = 'denied', decided_at = :now, note = 'The profile no longer allows this result.'
         WHERE profile_id = :id AND status = 'pending' AND (:enabled = 0 OR execution_id IN (
           SELECT e.id FROM executions e WHERE e.connection_id IS NULL OR e.connection_id NOT IN (
             SELECT connection_id FROM mcp_profile_connections WHERE profile_id = :id)))`,
        { id, enabled: int(enabled), now: isoNow(this.ctx) },
      ).changes;
      const { connectionIds, ...rest } = patch;
      this.ctx.audit.record({
        actor,
        action: 'mcp_profile.update',
        target: { type: 'mcp_profile', id, label: patch.name ?? before.name },
        outcome: 'succeeded',
        details: {
          changed: [...changedFields(before, rest), ...(connectionIds ? ['connectionIds'] : [])],
          cancelledRequests: cancelled,
        },
      });
    });
    return { profile: this.toView(this.row(id)), cancelledRequests: cancelled };
  }

  delete(actor: Actor, id: string): void {
    requirePermission(actor, 'profiles.manage');
    const before = this.toView(this.row(id));
    this.ctx.db.transaction(() => {
      this.ctx.db.run(
        `UPDATE disclosure_approvals SET status = 'denied', decided_at = :now, note = 'The profile was deleted.'
         WHERE profile_id = :id AND status = 'pending'`,
        { id, now: isoNow(this.ctx) },
      );
      this.ctx.db.run('DELETE FROM mcp_profiles WHERE id = :id', { id });
      this.ctx.audit.record({
        actor,
        action: 'mcp_profile.delete',
        target: { type: 'mcp_profile', id, label: before.name },
        outcome: 'succeeded',
        details: { clientId: before.clientId },
      });
    });
  }

  /** Effective database access through a profile for one user, per stored connection. */
  effectiveAccess(actor: Actor, id: string): EffectiveAccess[] {
    requirePermission(actor, 'connections.view');
    const profile = this.toView(this.row(id));
    const mcpActor: Actor = { ...actor, source: 'mcp', clientId: profile.clientId, profileId: profile.id };
    return this.ctx.db.all('SELECT id, name, read_only FROM connections ORDER BY lower(name)').map((c) => {
      const allowed = profile.connectionIds.includes(String(c.id));
      return {
        connectionId: String(c.id),
        connectionName: String(c.name),
        allowed,
        policy: allowed
          ? evaluateWritePolicy({
              actor: mcpActor,
              connection: { name: String(c.name), readOnly: bool(c.read_only) },
              profile: { name: profile.name, readOnly: profile.readOnly },
            })
          : null,
      };
    });
  }

  private checkLimits(v: { timeoutMs: number; previewRows: number; previewBytes: number }) {
    const l = this.ctx.limits;
    if (v.timeoutMs > l.fullTimeoutMaxMs)
      throw fieldError('timeoutMs', 'The timeout exceeds the administrator maximum.');
    if (v.previewRows > l.mcpPreviewRows)
      throw fieldError('previewRows', 'The row allowance exceeds the deployment limit.');
    if (v.previewBytes > l.mcpPreviewBytes)
      throw fieldError('previewBytes', 'The byte allowance exceeds the deployment limit.');
    return v;
  }

  private setConnections(id: string, connectionIds: string[]): void {
    const unique = [...new Set(connectionIds)];
    for (const connectionId of unique) {
      const exists = this.ctx.db.get('SELECT 1 AS ok FROM connections WHERE id = :connectionId', {
        connectionId,
      });
      if (!exists) throw fieldError('connectionIds', `Connection ${connectionId} does not exist.`);
    }
    this.ctx.db.run('DELETE FROM mcp_profile_connections WHERE profile_id = :id', { id });
    for (const connectionId of unique) {
      this.ctx.db.run(
        'INSERT INTO mcp_profile_connections (profile_id, connection_id) VALUES (:id, :connectionId)',
        {
          id,
          connectionId,
        },
      );
    }
  }

  private toView(r: Row): ProfileView {
    const id = String(r.id);
    return {
      id,
      owner: String(r.owner),
      name: String(r.name),
      clientId: String(r.client_id),
      connectionIds: this.ctx.db
        .all(
          'SELECT connection_id FROM mcp_profile_connections WHERE profile_id = :id ORDER BY connection_id',
          { id },
        )
        .map((c) => String(c.connection_id)),
      readOnly: bool(r.read_only),
      enabled: bool(r.enabled),
      // Stored allowances never exceed the deployment's limits, also after those were lowered.
      timeoutMs: Math.min(Number(r.timeout_ms), this.ctx.limits.fullTimeoutMaxMs),
      previewRows: Math.min(Number(r.preview_rows), this.ctx.limits.mcpPreviewRows),
      previewBytes: Math.min(Number(r.preview_bytes), this.ctx.limits.mcpPreviewBytes),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  private row(id: string): Row {
    const row = this.ctx.db.get('SELECT * FROM mcp_profiles WHERE id = :id', { id });
    assert(row, 'not_found', 'MCP profile not found.', { id });
    return row;
  }

  private assertNameFree(name: string): void {
    const taken = this.ctx.db.get('SELECT id FROM mcp_profiles WHERE lower(name) = lower(:name)', { name });
    if (taken)
      throw new AppError('name_conflict', `Another MCP profile is already named “${name}”.`, {
        field: 'name',
      });
  }
}

export { createSchema as profileCreateSchema, updateSchema as profileUpdateSchema };
