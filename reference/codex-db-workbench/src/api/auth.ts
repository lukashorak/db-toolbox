import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AppError, type Actor } from '../core/types.js';
import type { Request } from 'express';
import type { Store } from '../core/store.js';

export interface AuthConfig {
  issuer: string;
  guiClientId: string;
  apiAudience: string;
  mcpAudience: string;
  publicUrl: string;
}
export type Authenticate = (request: Request, channel: 'gui' | 'mcp') => Promise<Actor>;
export function createAuthenticator(config: AuthConfig, store: Store): Authenticate {
  const jwks = createRemoteJWKSet(new URL(`${config.issuer}/protocol/openid-connect/certs`), {
    timeoutDuration: 5000,
  });
  return async (request, channel) => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer '))
      throw new AppError('UNAUTHENTICATED', 'Sign in to continue.', 401);
    try {
      const { payload } = await jwtVerify(authorization.slice(7), jwks, {
        issuer: config.issuer,
        audience: channel === 'gui' ? config.apiAudience : config.mcpAudience,
        algorithms: ['RS256', 'PS256', 'ES256'],
        requiredClaims: ['exp', 'sub', 'azp'],
      });
      const clientId = String(payload.azp);
      if (channel === 'gui' && clientId !== config.guiClientId) throw new Error('Wrong client');
      const realmRoles = (payload.realm_access as { roles?: string[] } | undefined)?.roles ?? [];
      const clientRoles =
        (payload.resource_access as Record<string, { roles?: string[] }> | undefined)?.[clientId]
          ?.roles ?? [];
      const actor: Actor = {
        subject: payload.sub!,
        roles: [...new Set([...realmRoles, ...clientRoles])].filter((r) =>
          ['admin', 'query:read', 'query:write', 'monitor:read'].includes(r),
        ),
        channel,
        clientId,
        expiresAt: payload.exp! * 1000,
      };
      if (channel === 'mcp') {
        const profile = store.profileByClient(clientId);
        if (!profile?.enabled || profile.owner !== actor.subject)
          throw new AppError(
            'PROFILE_DENIED',
            'Create an enabled MCP profile for this OAuth client in the GUI.',
            403,
          );
        actor.profileId = profile.id;
      }
      return actor;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        'INVALID_TOKEN',
        'The access token is invalid, expired, or intended for another client.',
        401,
      );
    }
  };
}
