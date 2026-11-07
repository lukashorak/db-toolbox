import type { FastifyInstance } from 'fastify';
import { permissionsOf, type Authenticator, type Config, type Core } from '@workbench/core';
import { describeMcpEndpoint } from '@workbench/mcp';
import { actorOf } from '../auth.js';
import { openApiDocument } from '../openapi.js';
import { v1Routes } from './v1.js';

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

export function publicRoutes(config: Config, core: Core, version: string) {
  const document = openApiDocument(v1Routes(core), config, version);
  return async (app: FastifyInstance) => {
    app.get('/client-config', async (_request, reply) => {
      reply.header('cache-control', 'no-cache');
      return clientConfig(config);
    });
    app.get('/openapi.json', async () => document);
  };
}

/** Routes that require a GUI access token. The hook runs before body parsing. */
export function protectedRoutes(authenticator: Authenticator, core: Core) {
  return async (app: FastifyInstance) => {
    app.addHook('onRequest', async (request) => {
      request.actor = await authenticator.authenticate(request.headers.authorization, 'gui');
    });
    v1Routes(core).register(app);

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
