import { assert, type Actor, type Connection, type Profile } from './types.js';

export function requireRole(actor: Actor, role: string): void {
  assert(actor.expiresAt > Date.now(), 'TOKEN_EXPIRED', 'Sign in again.', 401);
  // Administration and target-database write permissions are deliberately separate.
  assert(actor.roles.includes(role), 'FORBIDDEN', `The ${role} role is required.`, 403);
}
export function requireOwner(actor: Actor, owner: string): void {
  assert(actor.subject === owner, 'NOT_FOUND', 'Resource not found.', 404);
}
export function effectiveReadOnly(
  actor: Actor,
  connection: Connection,
  profile?: Profile,
): boolean {
  requireRole(actor, 'query:read');
  requireOwner(actor, connection.owner);
  assert(connection.enabled, 'CONNECTION_DISABLED', 'This connection is disabled.', 403);
  if (actor.channel === 'mcp') {
    assert(
      profile &&
        profile.id === actor.profileId &&
        profile.owner === actor.subject &&
        profile.clientId === actor.clientId,
      'PROFILE_DENIED',
      'MCP profile is not authorized for this OAuth client.',
      403,
    );
    assert(
      profile.enabled && profile.connectionIds.includes(connection.id),
      'CONNECTION_DENIED',
      'This connection is not enabled for this MCP profile.',
      403,
    );
  }
  return connection.readOnly || !actor.roles.includes('query:write') || !!profile?.readOnly;
}
export function requireHuman(actor: Actor): void {
  requireRole(actor, 'query:read');
  assert(
    actor.channel === 'gui',
    'HUMAN_ACTION_REQUIRED',
    'Use the signed-in GUI to approve this disclosure.',
    403,
  );
}
