import { AppError } from '../domain/errors.js';
import type { Actor, Role } from '../domain/types.js';

/**
 * Application permissions. Database write permission (`sql.write`) is deliberately separate from
 * application configuration (`*.manage`): an administrator does not gain database writes, and a
 * read-only database user can still save queries.
 */
export const PERMISSIONS = [
  'connections.view',
  'connections.manage',
  'sql.read',
  'sql.write',
  'monitor.view',
  'queries.manage',
  'profiles.manage',
  'settings.manage',
  'audit.view',
  'disclosure.decide',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  'query:read': ['connections.view', 'sql.read', 'queries.manage', 'disclosure.decide'],
  'query:write': ['sql.write'],
  // Monitoring users see connection settings (never secrets) to choose what to watch.
  'monitor:read': ['monitor.view', 'connections.view'],
  admin: ['connections.view', 'connections.manage', 'profiles.manage', 'settings.manage', 'audit.view'],
};

export function permissionsOf(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) for (const permission of ROLE_PERMISSIONS[role] ?? []) out.add(permission);
  return out;
}

export function can(actor: Actor, permission: Permission): boolean {
  if (permission === 'disclosure.decide' && actor.source === 'mcp') return false;
  return permissionsOf(actor.roles).has(permission);
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor, permission)) {
    throw new AppError(
      'forbidden',
      actor.source === 'mcp' && permission === 'disclosure.decide'
        ? 'An MCP client cannot approve disclosure; a person must decide in the workbench.'
        : `This action needs the ${permission} permission.`,
      { permission },
    );
  }
}

export type PolicyLayerName = 'user' | 'connection' | 'profile';

export interface PolicyLayer {
  layer: PolicyLayerName;
  /** Who or what the layer refers to (user name, connection name, profile name). */
  subject: string;
  readOnly: boolean;
  reason: string;
}

export interface WritePolicy {
  readOnly: boolean;
  /** Layers that impose the restriction, strongest-wins; empty when writes are allowed. */
  sources: PolicyLayerName[];
  layers: PolicyLayer[];
}

export interface PolicyInput {
  actor: Actor;
  connection: { name: string; readOnly: boolean };
  /** Required when the actor calls through MCP. */
  profile?: { name: string; readOnly: boolean } | null;
}

/**
 * Combines the three independent read-only restrictions. The strongest wins and roles cannot
 * lift a restriction: an administrator without `query:write` is read-only, and so is anyone on a
 * read-only connection or MCP profile.
 */
export function evaluateWritePolicy(input: PolicyInput): WritePolicy {
  const { actor, connection, profile } = input;
  if (actor.source === 'mcp' && !profile) {
    throw new AppError('forbidden', 'MCP calls must be bound to an MCP profile.');
  }
  const userWrites = permissionsOf(actor.roles).has('sql.write');
  const layers: PolicyLayer[] = [
    {
      layer: 'user',
      subject: actor.displayName || actor.username,
      readOnly: !userWrites,
      reason: userWrites ? 'Has the query:write role' : 'No query:write role in Keycloak',
    },
    {
      layer: 'connection',
      subject: connection.name,
      readOnly: connection.readOnly,
      reason: connection.readOnly ? 'Stored connection is read-only' : 'Stored connection allows writes',
    },
  ];
  if (actor.source === 'mcp' && profile) {
    layers.push({
      layer: 'profile',
      subject: profile.name,
      readOnly: profile.readOnly,
      reason: profile.readOnly ? 'MCP profile is read-only' : 'MCP profile allows writes',
    });
  }
  const sources = layers.filter((layer) => layer.readOnly).map((layer) => layer.layer);
  return { readOnly: sources.length > 0, sources, layers };
}
