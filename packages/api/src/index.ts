import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import {
  AppError,
  checkReadiness,
  type Authenticator,
  type Config,
  type Core,
  type Logger,
} from '@workbench/core';
import { installErrorHandler, sendError } from './errors.js';
import { RequestGuard } from './guard.js';
import { mcpRoutes } from './routes/mcp.js';
import { API_PREFIX, protectedRoutes, publicRoutes } from './routes/session.js';

export { API_PREFIX, AUTH_CALLBACK_PATH, clientConfig } from './routes/session.js';
export { bearerChallenge, type ErrorBody } from './errors.js';
export { RequestGuard } from './guard.js';
export { RateLimiter } from './rate-limit.js';

/**
 * Headers for every response. The CSP allows only this origin, plus Keycloak for token requests
 * and the sign-in form; styles may be inline because CodeMirror injects its own and components set
 * style attributes. No scripts are inline.
 */
export function securityHeaders(
  config: Pick<Config, 'keycloakIssuer' | 'publicUrl'>,
): Record<string, string> {
  const keycloak = new URL(config.keycloakIssuer).origin;
  const headers: Record<string, string> = {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ${keycloak}`,
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      `form-action 'self' ${keycloak}`,
    ].join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  };
  if (config.publicUrl.startsWith('https:')) headers['strict-transport-security'] = 'max-age=31536000';
  return headers;
}

/** Built single-page app, served by the same process in production. */
export const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface ServerOptions {
  logger: Logger;
  core: Core;
  authenticator: Authenticator;
  version?: string;
  /** Replaces the default guard (rate limits from config), for example with a test clock. */
  guard?: RequestGuard;
  /** Overrides the location of the built web app; `false` disables static serving. */
  webDist?: string | false;
}

export async function buildServer(config: Config, options: ServerOptions) {
  const { core, authenticator } = options;
  const app = Fastify({
    // pino's Logger is a FastifyBaseLogger; the cast keeps route and plugin types on the default.
    loggerInstance: options.logger as FastifyBaseLogger,
    trustProxy: config.trustProxy,
    // Large enough for long SQL scripts; result data never travels in request bodies.
    bodyLimit: 2 * 1024 * 1024,
  });

  app.decorateRequest('actor', null);
  installErrorHandler(app, config);
  const headers = securityHeaders(config);
  app.addHook('onSend', async (_request, reply, payload) => {
    for (const [name, value] of Object.entries(headers))
      if (!reply.hasHeader(name)) reply.header(name, value);
    return payload;
  });
  const guard = options.guard ?? new RequestGuard(authenticator, config.rateLimits);

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const readiness = await checkReadiness(config);
    reply.code(readiness.ready ? 200 : 503);
    return { status: readiness.ready ? 'ready' : 'not_ready', checks: readiness.checks };
  });

  await app.register(publicRoutes(config, core, options.version ?? '0.0.0'), { prefix: API_PREFIX });
  await app.register(protectedRoutes(guard, core, config), { prefix: API_PREFIX });
  await app.register(mcpRoutes({ config, core, guard, version: options.version ?? '0.0.0', headers }));

  const webDist = options.webDist === undefined ? WEB_DIST : options.webDist;
  const serveWeb = Boolean(webDist && existsSync(webDist));
  if (serveWeb) {
    await app.register(fastifyStatic, {
      root: webDist as string,
      wildcard: false,
      // Hashed bundles never change; the page itself is always revalidated.
      setHeaders: (res, path) =>
        res.header(
          'cache-control',
          path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        ),
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const accept = request.headers.accept ?? '';
    const isApi = request.url.startsWith(`${API_PREFIX}/`) || request.url.startsWith('/.well-known/');
    if (serveWeb && !isApi && request.method === 'GET' && accept.includes('text/html')) {
      return reply.sendFile('index.html');
    }
    return sendError(config, request, reply, new AppError('not_found', 'No such resource.'));
  });

  return app;
}

export type WorkbenchServer = Awaited<ReturnType<typeof buildServer>>;
