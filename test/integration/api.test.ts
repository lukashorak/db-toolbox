/**
 * The HTTP API end to end against PostgreSQL: submit over HTTP, follow server-sent events to the
 * end, reconnect mid-run (AC7), read rows and metadata.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  Authenticator,
  createCore,
  createLogger,
  loadConfig,
  TokenVerifier,
  type Core,
} from '@workbench/core';
import { buildServer, type WorkbenchServer } from '@workbench/api';
import { preparePostgres, targetFrom } from '../support/databases.js';
import {
  API_AUDIENCE,
  createTestIssuer,
  GUI_CLIENT,
  ISSUER,
  MCP_AUDIENCE,
  PUBLIC_URL,
} from '../support/oidc.js';
import { skipUnless } from '../support/services.js';

describe('HTTP API with PostgreSQL', { skip: skipUnless('POSTGRES_TEST_URL') }, () => {
  const url = String(process.env.POSTGRES_TEST_URL);
  let core: Core;
  let app: WorkbenchServer;
  let base: string;
  let token: string;
  let dir: string;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as ReturnType<typeof JSON.parse> };
  };

  /** Collects SSE events until `stop` returns true or the stream is aborted. */
  function follow(stop: (events: { event: string; data: { id?: string; status?: string } }[]) => boolean) {
    const controller = new AbortController();
    const events: { event: string; data: { id?: string; status?: string } }[] = [];
    const done = (async () => {
      const response = await fetch(`${base}/api/v1/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done: end } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (end) return events;
        buffer += decoder.decode(value);
        let at;
        while ((at = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
          if (stop(events)) {
            controller.abort();
            return events;
          }
        }
      }
    })();
    return { done, abort: () => controller.abort() };
  }

  before(async () => {
    await preparePostgres(url);
    dir = await mkdtemp(join(tmpdir(), 'workbench-api-it-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_URL,
      KEYCLOAK_ISSUER: ISSUER,
      ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
    });
    core = createCore({
      databaseFile: join(dir, 'workbench.sqlite'),
      encryptionKey: config.encryptionKey,
      limits: config.limits,
      exportDir: dir,
    });
    const issuer = await createTestIssuer();
    const verifier = new TokenVerifier({
      issuer: ISSUER,
      guiClientId: GUI_CLIENT,
      apiAudience: API_AUDIENCE,
      mcpAudience: MCP_AUDIENCE,
      jwks: issuer.jwks,
    });
    app = await buildServer(config, {
      logger: createLogger({ level: 'silent' }),
      core,
      authenticator: new Authenticator(verifier, { users: core.users, profiles: core.profiles }),
      webDist: false,
    });
    base = await app.listen({ host: '127.0.0.1', port: 0 });
    token = await issuer.gui({ subject: 'operator', roles: ['query:read', 'query:write', 'admin'] });
  });
  after(async () => {
    await app.close();
    await core.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('runs a query submitted over HTTP and reports progress over server-sent events', async () => {
    const t = targetFrom(url, 'postgresql');
    const connection = await api('POST', '/connections', {
      name: 'Integration',
      engine: 'postgresql',
      environment: 'development',
      host: t.host,
      port: t.port,
      database: t.database,
      schema: 'public',
      username: t.username,
      password: t.password,
      tlsMode: 'verify-full',
      caPem: t.caPem,
      readOnly: true,
    });
    assert.equal(connection.status, 201);
    const id = connection.body.id;
    const objects = await api('GET', `/connections/${id}/metadata/schemas/public/objects`);
    assert.ok(objects.body.items.some((o: { name: string }) => o.name === 'wb_items'));
    assert.equal(
      (await api('GET', `/connections/${id}/metadata/schemas/public/tables/wb_items`)).body.columns.items[1]
        .name,
      'name',
    );

    // First stream: dropped while the execution is still running.
    let executionId = '';
    const first = follow((events) =>
      events.some((e) => e.data.id === executionId && e.data.status === 'running'),
    );
    await new Promise((r) => setTimeout(r, 100));
    const submitted = await api('POST', '/executions', {
      connectionId: id,
      sql: 'SELECT pg_sleep(1); SELECT id, name FROM wb_items ORDER BY id',
      requestKey: 'api-it-000001',
    });
    assert.equal(submitted.status, 201);
    executionId = submitted.body.id;
    await first.done;

    // Reconnect (AC7): fetch the execution by ID, then follow the new stream to the end.
    const resumed = await api('GET', `/executions/${executionId}`);
    assert.ok(['running', 'succeeded'].includes(resumed.body.status));
    const second = follow((events) =>
      events.some((e) => e.data.id === executionId && e.data.status === 'succeeded'),
    );
    const final = resumed.body.status === 'succeeded' ? [] : await second.done;
    second.abort();
    assert.ok(resumed.body.status === 'succeeded' || final.length > 0);
    const done = await api('GET', `/executions/${executionId}`);
    assert.deepEqual(
      [done.body.status, done.body.readOnly, done.body.resultSets.length],
      ['succeeded', true, 2],
    );
    const rows = await api('GET', `/executions/${executionId}/results/1/rows`);
    assert.deepEqual(rows.body.rows, [
      ['1', 'alpha'],
      ['2', 'beta'],
    ]);
    // The same request key returns the same execution; nothing runs twice.
    assert.equal(
      (
        await api('POST', '/executions', {
          connectionId: id,
          sql: 'SELECT pg_sleep(1); SELECT id, name FROM wb_items ORDER BY id',
          requestKey: 'api-it-000001',
        })
      ).body.id,
      executionId,
    );
  });
});
