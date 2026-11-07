import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { checkReadiness, type Config, type Logger } from '@workbench/core';

/** Built single-page app, served by the same process in production. */
export const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export interface ServerOptions {
  logger: Logger;
  /** Overrides the location of the built web app; `false` disables static serving. */
  webDist?: string | false;
}

export async function buildServer(config: Config, options: ServerOptions) {
  const app = Fastify({
    loggerInstance: options.logger,
    trustProxy: config.trustProxy,
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const readiness = await checkReadiness(config);
    reply.code(readiness.ready ? 200 : 503);
    return { status: readiness.ready ? 'ready' : 'not_ready', checks: readiness.checks };
  });

  const webDist = options.webDist === undefined ? WEB_DIST : options.webDist;
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      const accept = request.headers.accept ?? '';
      if (request.method === 'GET' && accept.includes('text/html')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found', message: 'No such resource.' });
    });
  }

  return app;
}

export type WorkbenchServer = Awaited<ReturnType<typeof buildServer>>;
