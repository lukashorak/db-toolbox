import { AppError } from '../domain/errors.js';
import type { Actor } from '../domain/types.js';
import type { ProfileService } from '../services/profiles.js';
import type { UserService } from '../services/users.js';
import type { Channel, TokenVerifier } from './tokens.js';

/**
 * Turns an Authorization header into an Actor. For MCP the token's OAuth client must be bound to
 * an enabled profile; a profile ID sent by a client is never trusted. Profiles are shared
 * configuration managed by administrators, so the user's own roles still apply on top of them.
 */
export class Authenticator {
  constructor(
    private readonly verifier: TokenVerifier,
    private readonly deps: { users: UserService; profiles: ProfileService },
  ) {}

  async authenticate(authorization: string | undefined, channel: Channel): Promise<Actor> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!match?.[1]) throw new AppError('unauthenticated', 'Sign in to continue.');
    const token = await this.verifier.verify(match[1], channel);
    if (!token.roles.length) {
      throw new AppError(
        'no_role',
        'Your account has no Database Workbench role. Ask an administrator to assign one in Keycloak.',
      );
    }
    const actor: Actor = {
      subject: token.subject,
      username: token.username,
      displayName: token.displayName,
      roles: token.roles,
      source: channel === 'mcp' ? 'mcp' : 'gui',
      clientId: token.clientId,
      expiresAt: token.expiresAt,
    };
    if (channel === 'mcp') {
      const profile = this.deps.profiles.findByClientId(token.clientId);
      if (!profile) {
        throw new AppError(
          'profile_unknown',
          `No MCP profile is bound to OAuth client ${token.clientId}. Create one under MCP access.`,
        );
      }
      if (!profile.enabled)
        throw new AppError('profile_disabled', `MCP profile “${profile.name}” is disabled.`);
      actor.profileId = profile.id;
    }
    this.deps.users.touch(actor, token.email);
    return actor;
  }
}
