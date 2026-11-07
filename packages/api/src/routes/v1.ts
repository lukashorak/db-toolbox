import { createReadStream } from 'node:fs';
import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  AppError,
  can,
  schemas,
  type Actor,
  type Config,
  type Core,
  type ExecutionView,
} from '@workbench/core';
import { RouteRegistry } from './registry.js';

const page = z.object({
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
const index = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0)
    throw new AppError('validation_failed', 'The result index must be a number.');
  return n;
};

/** Read-only-policy rejections get their own code so clients can tell them apart. */
function submitted(view: ExecutionView): ExecutionView {
  if (view.status !== 'preflight_rejected') return view;
  const problems = (view.error?.detail as { problems?: { code: string }[] } | null)?.problems ?? [];
  const readOnly = problems.some((p) => p.code === 'read_only_violation' || p.code === 'parse_error');
  throw new AppError(
    readOnly ? 'read_only_policy' : 'preflight_rejected',
    view.error?.message ?? 'The script was rejected.',
    {
      execution: view,
      problems,
    },
  );
}

/** All /api/v1 resources. Every handler delegates to a core service with the request's actor. */
export function v1Routes(
  core: Core,
  config: Pick<Config, 'limits'>,
  options: { closing?: EventEmitter } = {},
): RouteRegistry {
  const r = new RouteRegistry();

  // ---------------------------------------------------------------- connections
  r.add({
    method: 'GET',
    url: '/connections',
    tag: 'Connections',
    access: 'query:read or admin',
    summary: 'List connections',
    handler: ({ actor }) => core.connections.list(actor),
  });
  r.add({
    method: 'POST',
    url: '/connections',
    tag: 'Connections',
    access: 'admin',
    summary: 'Create a connection',
    body: schemas.connectionCreateSchema,
    status: 201,
    handler: ({ actor, body }) => core.connections.create(actor, body),
  });
  r.add({
    method: 'GET',
    url: '/connections/:id',
    tag: 'Connections',
    access: 'query:read or admin',
    summary: 'Get a connection',
    handler: ({ actor, params }) => core.connections.get(actor, String(params.id)),
  });
  r.add({
    method: 'PATCH',
    url: '/connections/:id',
    tag: 'Connections',
    access: 'admin',
    summary: 'Update a connection (a blank password keeps the stored one)',
    body: schemas.connectionUpdateSchema,
    handler: ({ actor, params, body }) => core.connections.update(actor, String(params.id), body),
  });
  for (const [verb, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    r.add({
      method: 'POST',
      url: `/connections/:id/${verb}`,
      tag: 'Connections',
      access: 'admin',
      summary: `${verb === 'enable' ? 'Enable' : 'Disable'} a connection`,
      handler: ({ actor, params }) => core.connections.setEnabled(actor, String(params.id), enabled),
    });
  }
  r.add({
    method: 'GET',
    url: '/connections/:id/references',
    tag: 'Connections',
    access: 'query:read or admin',
    summary: 'What refers to a connection',
    handler: ({ actor, params }) => core.connections.references(actor, String(params.id)),
  });
  r.add({
    method: 'DELETE',
    url: '/connections/:id',
    tag: 'Connections',
    access: 'admin',
    summary: 'Delete a connection (refused while executions are active)',
    handler: ({ actor, params }) => core.connections.delete(actor, String(params.id)),
  });
  r.add({
    method: 'POST',
    url: '/connections/:id/test',
    tag: 'Connections',
    access: 'admin',
    summary: 'Test a stored connection',
    handler: ({ actor, params }) => core.databases.test(actor, String(params.id)),
  });
  r.add({
    method: 'POST',
    url: '/connections/test',
    tag: 'Connections',
    access: 'admin',
    summary: 'Test unsaved connection settings',
    body: schemas.connectionDraftSchema,
    handler: ({ actor, body }) => core.databases.testDraft(actor, body),
  });

  // ---------------------------------------------------------------- metadata
  const meta = async (actor: Actor, connectionId: string) =>
    (await core.databases.adapter(actor, connectionId)).metadata;
  r.add({
    method: 'GET',
    url: '/connections/:id/metadata/databases',
    tag: 'Metadata',
    access: 'query:read',
    summary: 'Databases',
    handler: async ({ actor, params }) => (await meta(actor, String(params.id))).databases(),
  });
  r.add({
    method: 'GET',
    url: '/connections/:id/metadata/schemas',
    tag: 'Metadata',
    access: 'query:read',
    summary: 'Schemas',
    handler: async ({ actor, params }) => (await meta(actor, String(params.id))).schemas(),
  });
  r.add({
    method: 'GET',
    url: '/connections/:id/metadata/schemas/:schema/objects',
    tag: 'Metadata',
    access: 'query:read',
    summary: 'Tables, views and routines in a schema',
    handler: async ({ actor, params }) =>
      (await meta(actor, String(params.id))).objects(String(params.schema)),
  });
  r.add({
    method: 'GET',
    url: '/connections/:id/metadata/schemas/:schema/tables/:name',
    tag: 'Metadata',
    access: 'query:read',
    summary: 'Columns, keys, indexes and definition of a table or view',
    handler: async ({ actor, params }) => {
      const detail = await (
        await meta(actor, String(params.id))
      ).table(String(params.schema), String(params.name));
      if (!detail)
        throw new AppError(
          'not_found',
          'The table does not exist or is not visible to the database account.',
        );
      return detail;
    },
  });
  r.add({
    method: 'GET',
    url: '/connections/:id/metadata/schemas/:schema/routines/:name',
    tag: 'Metadata',
    access: 'query:read',
    summary: 'Definition of a function or procedure',
    query: z.object({ signature: z.string().optional() }),
    handler: async ({ actor, params, query }) =>
      (await meta(actor, String(params.id))).routine(
        String(params.schema),
        String(params.name),
        query.signature,
      ),
  });

  // ---------------------------------------------------------------- executions
  r.add({
    method: 'POST',
    url: '/executions',
    tag: 'Executions',
    access: 'query:read (writes also need query:write and writable layers)',
    summary: 'Submit SQL. Stored before it is acknowledged; runs in the background',
    body: schemas.executionSubmitSchema,
    status: 201,
    handler: async ({ actor, body }) => submitted(await core.executions.submit(actor, body)),
  });
  r.add({
    method: 'GET',
    url: '/executions',
    tag: 'Executions',
    access: 'query:read',
    summary: 'Your executions, newest first',
    query: z.object({
      status: z.string().optional(),
      connectionId: z.string().optional(),
      source: z.enum(['gui', 'api', 'mcp']).optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      before: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
    handler: ({ actor, query }) =>
      core.executions.list(actor, query as Parameters<Core['executions']['list']>[1]),
  });
  r.add({
    method: 'POST',
    url: '/sql/check',
    tag: 'Executions',
    access: 'query:read',
    summary: 'Statement ranges, policy and preflight problems for SQL, without running it (editor support)',
    body: z
      .object({
        connectionId: z.string(),
        sql: z.string().max(1_000_000),
        transactionMode: z.enum(['per_statement', 'atomic']).optional(),
      })
      .strict(),
    handler: ({ actor, body }) => core.executions.check(actor, body),
  });
  r.add({
    method: 'POST',
    url: '/executions/:id/retain',
    tag: 'Executions',
    access: 'owner or admin',
    summary: 'Keep the captured results for a number of days (within the administrator maximum)',
    body: z.object({ days: z.number().int() }).strict(),
    handler: ({ actor, params, body }) => core.executions.retain(actor, String(params.id), body.days),
  });
  r.add({
    method: 'POST',
    url: '/executions/:id/results/:index/share',
    tag: 'Approvals',
    access: 'the execution owner, in the GUI',
    summary: 'Share a result with an MCP profile in advance (scoped approval with an amount and an expiry)',
    body: schemas.disclosureDecideSchema.extend({ profileId: z.string() }),
    status: 201,
    handler: ({ actor, params, body }) =>
      core.disclosure.grant(actor, String(params.id), index(params.index), body),
  });
  r.add({
    method: 'GET',
    url: '/executions/:id',
    tag: 'Executions',
    access: 'owner or admin',
    summary: 'Status, statements and result sets',
    handler: ({ actor, params }) => core.executions.get(actor, String(params.id)),
  });
  r.add({
    method: 'POST',
    url: '/executions/:id/cancel',
    tag: 'Executions',
    access: 'owner or admin',
    summary: 'Cancel (queued: at once; running: when the database confirms)',
    handler: ({ actor, params }) => core.executions.cancel(actor, String(params.id)),
  });
  r.add({
    method: 'GET',
    url: '/executions/:id/results/:index/rows',
    tag: 'Executions',
    access: 'owner or admin',
    summary: 'A page of captured rows (at most 1,000)',
    query: page,
    handler: ({ actor, params, query }) =>
      core.executions.rows(actor, String(params.id), index(params.index), query),
  });
  r.add({
    method: 'DELETE',
    url: '/executions/:id/results',
    tag: 'Executions',
    access: 'owner or admin',
    summary: 'Delete stored results and their exports; the execution stays in history',
    handler: async ({ actor, params }) => ({
      bytesFreed: await core.exports.deleteResults(actor, String(params.id)),
    }),
  });

  // ---------------------------------------------------------------- exports
  r.add({
    method: 'GET',
    url: '/executions/:id/exports',
    tag: 'Exports',
    access: 'owner or admin',
    summary: 'Exports of an execution',
    handler: ({ actor, params }) => core.exports.list(actor, String(params.id)),
  });
  r.add({
    method: 'POST',
    url: '/executions/:id/results/:index/exports',
    tag: 'Exports',
    access: 'owner or admin',
    summary: 'Export a captured result as CSV or JSON (never runs SQL)',
    body: schemas.exportCreateSchema,
    status: 202,
    handler: ({ actor, params, body }) =>
      core.exports.create(actor, String(params.id), index(params.index), body),
  });
  r.add({
    method: 'GET',
    url: '/exports/:id',
    tag: 'Exports',
    access: 'owner or admin',
    summary: 'Export status',
    handler: ({ actor, params }) => core.exports.get(actor, String(params.id)),
  });
  r.add({
    method: 'POST',
    url: '/exports/:id/regenerate',
    tag: 'Exports',
    access: 'owner or admin',
    summary: 'Rebuild the file from captured data',
    status: 202,
    handler: ({ actor, params }) => core.exports.regenerate(actor, String(params.id)),
  });
  r.add({
    method: 'GET',
    url: '/exports/:id/download',
    tag: 'Exports',
    access: 'owner or admin',
    summary: 'Download a ready export',
    produces: 'text/csv or application/json',
    handler: async ({ actor, params, reply }) => {
      const file = await core.exports.download(actor, String(params.id));
      const ascii = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      reply
        .header('content-type', file.contentType)
        .header('content-length', file.size)
        .header(
          'content-disposition',
          `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        )
        .header('cache-control', 'no-store');
      return reply.send(createReadStream(file.path));
    },
  });

  // ---------------------------------------------------------------- library
  r.add({
    method: 'GET',
    url: '/folders',
    tag: 'Library',
    access: 'query:read',
    summary: 'Your folders',
    handler: ({ actor }) => core.library.folders(actor),
  });
  r.add({
    method: 'POST',
    url: '/folders',
    tag: 'Library',
    access: 'query:read',
    summary: 'Create a folder',
    body: schemas.folderCreateSchema,
    status: 201,
    handler: ({ actor, body }) => core.library.createFolder(actor, body),
  });
  r.add({
    method: 'PATCH',
    url: '/folders/:id',
    tag: 'Library',
    access: 'query:read',
    summary: 'Rename or move a folder',
    body: schemas.folderUpdateSchema,
    handler: ({ actor, params, body }) => core.library.updateFolder(actor, String(params.id), body),
  });
  r.add({
    method: 'DELETE',
    url: '/folders/:id',
    tag: 'Library',
    access: 'query:read',
    summary: 'Delete a folder, moving its contents up or deleting them',
    query: z.object({ mode: z.enum(['move-to-parent', 'delete-contents']).default('move-to-parent') }),
    handler: ({ actor, params, query }) => core.library.deleteFolder(actor, String(params.id), query.mode),
  });
  r.add({
    method: 'GET',
    url: '/queries',
    tag: 'Library',
    access: 'query:read',
    summary: 'Your saved queries',
    query: z.object({ folderId: z.string().optional(), search: z.string().optional() }),
    handler: ({ actor, query }) =>
      core.library.queries(actor, {
        ...(query.folderId !== undefined
          ? { folderId: query.folderId === 'root' ? null : query.folderId }
          : {}),
        ...(query.search ? { search: query.search } : {}),
      }),
  });
  r.add({
    method: 'POST',
    url: '/queries',
    tag: 'Library',
    access: 'query:read',
    summary: 'Save a query',
    body: schemas.queryCreateSchema,
    status: 201,
    handler: ({ actor, body }) => core.library.createQuery(actor, body),
  });
  r.add({
    method: 'GET',
    url: '/queries/:id',
    tag: 'Library',
    access: 'query:read',
    summary: 'Get a saved query',
    handler: ({ actor, params }) => core.library.query(actor, String(params.id)),
  });
  r.add({
    method: 'PATCH',
    url: '/queries/:id',
    tag: 'Library',
    access: 'query:read',
    summary: 'Rename, move or edit a saved query',
    body: schemas.queryUpdateSchema,
    handler: ({ actor, params, body }) => core.library.updateQuery(actor, String(params.id), body),
  });
  r.add({
    method: 'POST',
    url: '/queries/:id/duplicate',
    tag: 'Library',
    access: 'query:read',
    summary: 'Duplicate a saved query',
    body: z.object({ name: z.string(), folderId: z.string().nullable().optional() }).strict(),
    status: 201,
    handler: ({ actor, params, body }) =>
      core.library.duplicateQuery(actor, String(params.id), {
        name: body.name,
        ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
      }),
  });
  r.add({
    method: 'DELETE',
    url: '/queries/:id',
    tag: 'Library',
    access: 'query:read',
    summary: 'Delete a saved query (history stays)',
    handler: ({ actor, params }) => core.library.deleteQuery(actor, String(params.id)),
  });

  // ---------------------------------------------------------------- MCP profiles
  r.add({
    method: 'GET',
    url: '/profiles',
    tag: 'MCP profiles',
    access: 'query:read or admin',
    summary: 'List MCP profiles',
    handler: ({ actor }) => core.profiles.list(actor),
  });
  r.add({
    method: 'POST',
    url: '/profiles',
    tag: 'MCP profiles',
    access: 'admin',
    summary: 'Create an MCP profile bound to an OAuth client',
    body: schemas.profileCreateSchema,
    status: 201,
    handler: ({ actor, body }) => core.profiles.create(actor, body),
  });
  r.add({
    method: 'GET',
    url: '/profiles/:id',
    tag: 'MCP profiles',
    access: 'query:read or admin',
    summary: 'Get an MCP profile',
    handler: ({ actor, params }) => core.profiles.get(actor, String(params.id)),
  });
  r.add({
    method: 'PATCH',
    url: '/profiles/:id',
    tag: 'MCP profiles',
    access: 'admin',
    summary: 'Update an MCP profile',
    body: schemas.profileUpdateSchema,
    handler: ({ actor, params, body }) => core.profiles.update(actor, String(params.id), body),
  });
  r.add({
    method: 'DELETE',
    url: '/profiles/:id',
    tag: 'MCP profiles',
    access: 'admin',
    summary: 'Delete an MCP profile',
    handler: ({ actor, params }) => core.profiles.delete(actor, String(params.id)),
  });
  r.add({
    method: 'GET',
    url: '/profiles/:id/access',
    tag: 'MCP profiles',
    access: 'query:read or admin',
    summary: 'Effective read/write access per connection',
    handler: ({ actor, params }) => core.profiles.effectiveAccess(actor, String(params.id)),
  });

  // ---------------------------------------------------------------- monitoring
  r.add({
    method: 'GET',
    url: '/connections/:id/monitoring/activity',
    tag: 'Monitoring',
    access: 'monitor:read',
    summary: 'Sessions, lock waits and counter rates of the target database, each with its availability',
    handler: ({ actor, params }) => core.monitoring.activity(actor, String(params.id)),
  });
  r.add({
    method: 'GET',
    url: '/connections/:id/monitoring/statements',
    tag: 'Monitoring',
    access: 'monitor:read',
    summary: 'Statement statistics by total time (pg_stat_statements or performance_schema digests)',
    query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }),
    handler: ({ actor, params, query }) => core.monitoring.statements(actor, String(params.id), query.limit),
  });

  // ---------------------------------------------------------------- MCP disclosure approvals
  r.add({
    method: 'GET',
    url: '/approvals',
    tag: 'Approvals',
    access: 'query:read (your own executions; admin sees all)',
    summary: 'Disclosure requests from MCP clients',
    query: z.object({ status: z.enum(['pending', 'active', 'expired', 'revoked', 'denied']).optional() }),
    handler: ({ actor, query }) => core.disclosure.list(actor, query.status ? { status: query.status } : {}),
  });
  r.add({
    method: 'POST',
    url: '/approvals/:id/approve',
    tag: 'Approvals',
    access: 'the execution owner, in the GUI',
    summary: 'Allow an MCP client more rows of one result set, for a limited time',
    body: schemas.disclosureDecideSchema,
    handler: ({ actor, params, body }) => core.disclosure.approve(actor, String(params.id), body),
  });
  for (const verb of ['deny', 'revoke'] as const) {
    r.add({
      method: 'POST',
      url: `/approvals/:id/${verb}`,
      tag: 'Approvals',
      access: 'the execution owner or admin',
      summary:
        verb === 'deny' ? 'Deny a pending disclosure request' : 'End an approval; further pages are refused',
      body: z.object({ note: z.string().max(500).optional() }).strict(),
      handler: ({ actor, params, body }) => core.disclosure[verb](actor, String(params.id), body.note),
    });
  }

  // ---------------------------------------------------------------- settings and audit
  r.add({
    method: 'GET',
    url: '/settings/storage',
    tag: 'Settings',
    access: 'any role',
    summary: 'Captured-result storage: used bytes against the deployment quota',
    handler: () => ({
      usedBytes: core.executions.storedBytes,
      totalLimitBytes: config.limits.maxTotalBytes,
      executionLimitBytes: config.limits.maxResultBytes,
    }),
  });
  r.add({
    method: 'GET',
    url: '/settings/execution',
    tag: 'Settings',
    access: 'any role',
    summary: 'Execution defaults and limits',
    handler: () => core.settings.defaults(),
  });
  r.add({
    method: 'PATCH',
    url: '/settings/execution',
    tag: 'Settings',
    access: 'admin',
    summary: 'Change execution defaults within the deployment limits',
    body: schemas.executionDefaultsSchema,
    handler: ({ actor, body }) => core.settings.updateDefaults(actor, body),
  });
  r.add({
    method: 'GET',
    url: '/audit',
    tag: 'Audit',
    access: 'admin',
    summary: 'Audit events, newest first',
    query: z.object({
      source: z.enum(['gui', 'api', 'mcp', 'server']).optional(),
      actionPrefix: z.string().optional(),
      actorSubject: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      before: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
    handler: ({ actor, query }) => core.audit.list(actor, query),
  });

  // ---------------------------------------------------------------- live status
  r.add({
    method: 'GET',
    url: '/events',
    tag: 'Live status',
    access: 'any role',
    summary:
      'Server-sent events for execution, export and MCP approval changes visible to you. After a reconnect, fetch the executions you follow by ID.',
    produces: 'text/event-stream',
    handler: ({ actor, request, reply }) => {
      const sees = (owner: unknown) =>
        owner === actor.subject || (actor.source !== 'mcp' && can(actor, 'connections.manage'));
      let seq = 0;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\nid: ${++seq}\ndata: ${JSON.stringify(data)}\n\n`);
      res.write('retry: 3000\n\n');
      send('ready', { tokenExpiresAt: actor.expiresAt ?? null });
      const onExecution = (e: { id: string }) => {
        try {
          const row = core.db.get(
            'SELECT owner, status, transaction_outcome FROM executions WHERE id = :id',
            { id: e.id },
          );
          if (row && sees(row.owner))
            send('execution', { id: e.id, status: row.status, transactionOutcome: row.transaction_outcome });
        } catch {
          // Database closed during shutdown.
        }
      };
      const onExport = (e: { id: string; executionId: string; status: string }) => {
        try {
          const row = core.db.get('SELECT owner FROM executions WHERE id = :id', { id: e.executionId });
          if (row && sees(row.owner)) send('export', e);
        } catch {
          // As above.
        }
      };
      const onApproval = (e: { id: string }) => {
        try {
          const row = core.db.get(
            `SELECT a.status, a.execution_id, e.owner FROM disclosure_approvals a
               JOIN executions e ON e.id = a.execution_id WHERE a.id = :id`,
            { id: e.id },
          );
          if (row && actor.source !== 'mcp' && sees(row.owner))
            send('approval', { id: e.id, executionId: row.execution_id, status: row.status });
        } catch {
          // As above.
        }
      };
      core.executions.events.on('change', onExecution);
      core.exports.events.on('change', onExport);
      core.disclosure.events.on('change', onApproval);
      const end = () => res.end();
      options.closing?.once('close', end);
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      // The stream ends when the access token expires; the client reconnects with a fresh token.
      const expiry = actor.expiresAt
        ? setTimeout(() => res.end(), Math.max(0, Date.parse(actor.expiresAt) - Date.now()))
        : null;
      const close = () => {
        clearInterval(heartbeat);
        if (expiry) clearTimeout(expiry);
        core.executions.events.off('change', onExecution);
        core.exports.events.off('change', onExport);
        core.disclosure.events.off('change', onApproval);
        options.closing?.off('close', end);
      };
      request.raw.on('close', close);
      res.on('close', close);
      return undefined;
    },
  });

  return r;
}
