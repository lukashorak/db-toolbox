import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z, ZodError } from 'zod';
import { Workbench } from '../core/service.js';
import { requireHuman, requireOwner, requireRole } from '../core/policy.js';
import { AppError, assert, type Actor } from '../core/types.js';
import { inspectionSql } from '../core/inspection.js';
import { handleMcp } from '../mcp/server.js';
import type { Authenticate, AuthConfig } from './auth.js';

const id = (value: unknown) => z.string().uuid().parse(value);
export function createApp(core: Workbench, authenticate: Authenticate, config: AuthConfig) {
  const app = express();
  app.disable('x-powered-by');
  const origin = new URL(config.publicUrl).origin;
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${new URL(config.issuer).origin}; frame-src ${new URL(config.issuer).origin}; frame-ancestors 'none'; base-uri 'self'; object-src 'none'`,
    );
    if (req.headers.origin && req.headers.origin !== origin)
      return next(new AppError('ORIGIN_DENIED', 'This origin is not allowed.', 403));
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/config', (_req, res) =>
    res.json({
      issuer: config.issuer,
      clientId: config.guiClientId,
      publicUrl: config.publicUrl,
      apiAudience: config.apiAudience,
      mcpEndpoint: config.mcpAudience,
      version: '0.1.0',
    }),
  );
  app.get(
    ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
    (_req, res) =>
      res.json({
        resource: config.mcpAudience,
        authorization_servers: [config.issuer],
        scopes_supported: ['openid', 'profile', 'workbench:mcp'],
        bearer_methods_supported: ['header'],
      }),
  );
  const actors = new WeakMap<Request, Actor>();
  const authorize =
    (channel: 'gui' | 'mcp') => async (req: Request, res: Response, next: NextFunction) => {
      try {
        actors.set(req, await authenticate(req, channel));
        next();
      } catch (error) {
        if (channel === 'mcp')
          res.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource/mcp"`,
          );
        next(error);
      }
    };
  app.post('/mcp', authorize('mcp'), async (req, res) => {
    await handleMcp(core, actors.get(req)!, req, res);
  });
  app.all('/mcp', authorize('mcp'), (_req, res) =>
    res
      .status(405)
      .setHeader('Allow', 'POST')
      .json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use stateless MCP HTTP POST.' } }),
  );
  app.get('/mcp/exports/:id', authorize('mcp'), (req, res) => {
    const item = core.download(actors.get(req)!, id(req.params.id));
    res.download(item.path, `result-${item.resultId}.${item.format}`);
  });
  app.use('/api', authorize('gui'));
  const actor = (req: Request) => actors.get(req)!;
  app.get('/api/me', (req, res) => res.json(actor(req)));
  app.get('/api/connections', (req, res) => res.json(core.connections(actor(req))));
  app.post('/api/connections', (req, res) =>
    res.status(201).json(core.saveConnection(actor(req), req.body)),
  );
  app.put('/api/connections/:id', (req, res) =>
    res.json(core.saveConnection(actor(req), req.body, id(req.params.id))),
  );
  app.post('/api/connections/:id/test', async (req, res) =>
    res.json(await core.testConnection(actor(req), id(req.params.id))),
  );
  app.get('/api/connections/:id/inspect/:view', async (req, res) => {
    const view = z
      .enum(['databases', 'objects', 'columns', 'activity', 'blocking', 'statistics', 'slow'])
      .parse(req.params.view);
    if (['activity', 'blocking', 'statistics', 'slow'].includes(view))
      requireRole(actor(req), 'monitor:read');
    const connection = core.connections(actor(req)).find((c) => c.id === req.params.id);
    assert(connection, 'NOT_FOUND', 'Connection not found.', 404);
    try {
      res.json({
        ...(await core.inspect(actor(req), connection.id, inspectionSql[connection.engine][view]!)),
        available: true,
        sampledAt: Date.now(),
      });
    } catch (error) {
      res.json({
        available: false,
        rows: [],
        columns: [],
        message: error instanceof Error ? error.message : 'Monitoring capability unavailable.',
        sampledAt: Date.now(),
      });
    }
  });
  app.get('/api/executions', (req, res) => res.json(core.history(actor(req))));
  app.post('/api/executions', (req, res) =>
    res.status(202).json(core.submit(actor(req), req.body)),
  );
  app.get('/api/executions/:id', (req, res) =>
    res.json(core.execution(actor(req), id(req.params.id))),
  );
  app.post('/api/executions/:id/cancel', (req, res) =>
    res.json(core.cancel(actor(req), id(req.params.id))),
  );
  app.get('/api/results/:id', (req, res) =>
    res.json(
      core.resultPage(
        actor(req),
        id(req.params.id),
        Number(req.query.offset ?? 0),
        Number(req.query.limit ?? 200),
      ),
    ),
  );
  app.post('/api/results/:id/exports', async (req, res) =>
    res
      .status(201)
      .json(
        await core.export(
          actor(req),
          id(req.params.id),
          z.enum(['csv', 'json']).parse(req.body.format),
        ),
      ),
  );
  app.get('/api/exports', (req, res) => {
    requireRole(actor(req), 'query:read');
    res.json(core.store.exports(actor(req).subject).map(({ path, ...item }) => item));
  });
  app.get('/api/exports/:id', (req, res) => {
    const item = core.download(actor(req), id(req.params.id));
    res.download(item.path, `result-${item.resultId}.${item.format}`);
  });
  app.get('/api/profiles', (req, res) => res.json(core.profiles(actor(req))));
  app.post('/api/profiles', (req, res) =>
    res.status(201).json(core.saveProfile(actor(req), req.body)),
  );
  app.put('/api/profiles/:id', (req, res) =>
    res.json(core.saveProfile(actor(req), req.body, id(req.params.id))),
  );
  app.get('/api/approvals', (req, res) => {
    requireHuman(actor(req));
    res.json(core.store.approvals(actor(req).subject));
  });
  app.post('/api/results/:id/approvals', (req, res) => {
    const input = z
      .object({ profileId: z.string().uuid(), hours: z.number().min(0.01).max(24).default(1) })
      .strict()
      .parse(req.body);
    res.json(core.approve(actor(req), id(req.params.id), input.profileId, input.hours));
  });
  app.delete('/api/results/:id/approvals/:profileId', (req, res) => {
    core.revoke(actor(req), id(req.params.id), id(req.params.profileId));
    res.status(204).end();
  });
  app.get('/api/audit', (req, res) => {
    requireRole(actor(req), 'admin');
    res.json(core.store.auditLog(actor(req).subject));
  });
  app.get('/api/queries', (req, res) => {
    requireRole(actor(req), 'query:read');
    res.json(core.store.records('query', actor(req).subject));
  });
  app.post('/api/queries', (req, res) => {
    const who = actor(req);
    requireRole(who, 'query:read');
    const input = z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(100),
        folder: z.string().max(500).default(''),
        sql: z.string().max(100_000),
        connectionId: z.string().uuid().optional(),
      })
      .strict()
      .parse(req.body);
    if (input.connectionId)
      assert(
        core.connections(who).some((c) => c.id === input.connectionId),
        'NOT_FOUND',
        'Connection not found.',
        404,
      );
    const existing = input.id ? core.store.record<{ owner: string }>('query', input.id) : undefined;
    if (input.id) {
      assert(existing, 'NOT_FOUND', 'Saved query not found.', 404);
      requireOwner(who, existing.owner);
    }
    assert(
      !input.folder.split('/').some((p) => p === '..' || p === '.'),
      'INVALID_FOLDER',
      'Use folder names separated by /.',
    );
    const value = {
      ...input,
      id: input.id ?? randomUUID(),
      owner: who.subject,
      updatedAt: Date.now(),
    };
    core.store.saveRecord('query', value.id, who.subject, value);
    core.store.audit(who, 'query.save', value.id);
    res.status(201).json(value);
  });
  app.use('/api', (_req, res) =>
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not found.' } }),
  );
  const webRoot = resolve('web/dist');
  if (existsSync(webRoot)) {
    app.use(express.static(webRoot, { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(webRoot, 'index.html')));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = error instanceof AppError ? error.status : error instanceof ZodError ? 400 : 500;
    res
      .status(status)
      .json({
        error: {
          code:
            error instanceof AppError
              ? error.code
              : error instanceof ZodError
                ? 'VALIDATION_FAILED'
                : 'INTERNAL_ERROR',
          message:
            error instanceof AppError
              ? error.message
              : error instanceof ZodError
                ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
                : 'The operation could not be completed.',
        },
      });
  });
  return app;
}
