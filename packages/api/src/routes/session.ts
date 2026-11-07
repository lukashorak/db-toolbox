import type { FastifyInstance } from 'fastify';
import { permissionsOf, type Authenticator, type Config } from '@workbench/core';
import { describeMcpEndpoint } from '@workbench/mcp';
import { actorOf } from '../auth.js';

export const API_PREFIX = '/api/v1';
/** Path the GUI client registers as its redirect URI in Keycloak. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/** Public: what the GUI needs before sign-in. Contains no secrets. */
export function clientConfig(config: Config) {
  return {
    issuer: config.keycloakIssuer,
    clientId: config.guiClientId,
    scope: 'openid profile email',
    redirectUri: `${config.publicUrl}${AUTH_CALLBACK_PATH}`,
    postLogoutRedirectUri: `${config.publicUrl}/`,
    mcp: describeMcpEndpoint(config),
  };
}

export function publicRoutes(config: Config) {
  return async (app: FastifyInstance) => {
    app.get('/client-config', async (_request, reply) => {
      reply.header('cache-control', 'no-cache');
      return clientConfig(config);
    });
  };
}

/** Routes that require a GUI access token. The hook runs before body parsing. */
export function protectedRoutes(authenticator: Authenticator) {
  return async (app: FastifyInstance) => {
    app.addHook('onRequest', async (request) => {
      request.actor = await authenticator.authenticate(request.headers.authorization, 'gui');
    });

    app.get('/session', async (request) => {
      const actor = actorOf(request);
      return {
        user: {
          subject: actor.subject,
          username: actor.username,
          displayName: actor.displayName,
          roles: actor.roles,
        },
        permissions: [...permissionsOf(actor.roles)].sort(),
        tokenExpiresAt: actor.expiresAt ?? null,
      };
    });
  };
}
