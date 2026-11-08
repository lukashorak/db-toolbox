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
import {
  API_AUDIENCE,
  createTestIssuer,
  GUI_CLIENT,
  ISSUER,
  MCP_AUDIENCE,
  PUBLIC_URL,
  type TestIssuer,
} from '../../../test/support/oidc.js';
import { buildServer, type WorkbenchServer } from '../src/index.js';
import { v1Routes } from '../src/routes/v1.js';

const config = loadConfig({
  NODE_ENV: 'test',
  PUBLIC_URL,
  KEYCLOAK_ISSUER: ISSUER,
  ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
});
const ROLES = {
  reader: ['query:read'],
  writer: ['query:read', 'query:write'],
  admin: ['query:read', 'admin'],
  monitor: ['monitor:read'],
} as const;
type Role = keyof typeof ROLES | 'none';

let issuer: TestIssuer;
let core: Core;
let app: WorkbenchServer;
let dir: string;
const tokens = new Map<Role, string>();

const connectionBody = (name: string, readOnly = false) => ({
  name,
  engine: 'postgresql',
  environment: 'development',
  host: '127.0.0.1',
  port: 1,
  database: 'app',
  username: 'wb',
  password: 'not-a-real-password',
  tlsMode: 'disable',
  readOnly,
});

async function call(method: string, url: string, role: Role, payload?: unknown) {
  const response = await app.inject({
    method: method as 'GET',
    url: `/api/v1${url}`,
    headers: role === 'none' ? {} : { authorization: `Bearer ${tokens.get(role)}` },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return {
    status: response.statusCode,
    body: response.body
      ? response.headers['content-type']?.toString().includes('json')
        ? response.json()
        : response.body
      : null,
    headers: response.headers,
  };
}

before(async () => {
  issuer = await createTestIssuer();
  dir = await mkdtemp(join(tmpdir(), 'workbench-contract-'));
  core = createCore({
    databaseFile: ':memory:',
    encryptionKey: config.encryptionKey,
    limits: config.limits,
    exportDir: dir,
    executions: { globalCap: 0 },
  });
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
  for (const [role, roles] of Object.entries(ROLES))
    tokens.set(role as Role, await issuer.gui({ subject: role, roles: [...roles] }));
});
after(async () => {
  await app.close();
  await core.shutdown();
  await rm(dir, { recursive: true, force: true });
});

describe('API contract', () => {
  let connection: string;
  let readOnly: string;

  it('validation errors from services have the same shape as request validation', async () => {
    const serviceLevel = await call('POST', '/connections', 'admin', {
      ...connectionBody('IP with verify-full'),
      engine: 'mysql',
      port: 3306,
      tlsMode: 'verify-full',
    });
    assert.equal(serviceLevel.status, 400);
    assert.equal(serviceLevel.body.error, 'validation_failed');
    assert.ok(Array.isArray(serviceLevel.body.details.fields), JSON.stringify(serviceLevel.body));
    assert.equal(serviceLevel.body.details.fields[0].path, 'host');
    const requestLevel = await call('POST', '/connections', 'admin', { name: 'x' });
    assert.equal(requestLevel.status, 400);
    assert.ok(Array.isArray(requestLevel.body.details.fields));
    assert.ok(
      requestLevel.body.details.fields.every(
        (f: { path?: string; message?: string }) => f.path !== undefined && f.message,
      ),
    );
  });

  it('connections: readers list, administrators manage', async () => {
    assert.equal((await call('GET', '/connections', 'none')).status, 401);
    assert.equal(
      (await call('GET', '/connections', 'monitor')).status,
      200,
      'monitoring users choose a connection to watch',
    );
    assert.equal((await call('POST', '/connections', 'reader', connectionBody('X'))).status, 403);
    const created = await call('POST', '/connections', 'admin', connectionBody('Primary'));
    assert.equal(created.status, 201);
    assert.equal(created.body.hasPassword, true);
    assert.doesNotMatch(JSON.stringify(created.body), /not-a-real-password/);
    connection = created.body.id;
    readOnly = (await call('POST', '/connections', 'admin', connectionBody('Locked', true))).body.id;
    assert.equal(
      (await call('POST', '/connections', 'admin', connectionBody('Primary'))).body.error,
      'name_conflict',
    );
    const invalid = await call('POST', '/connections', 'admin', { ...connectionBody('Bad'), port: 0 });
    assert.deepEqual([invalid.status, invalid.body.error], [400, 'validation_failed']);
    assert.equal((await call('GET', '/connections', 'reader')).body.length, 2);
    assert.equal((await call('GET', `/connections/${connection}`, 'reader')).status, 200);
    assert.equal((await call('GET', '/connections/cn_missing', 'reader')).status, 404);
    assert.equal(
      (await call('PATCH', `/connections/${connection}`, 'reader', { name: 'Renamed' })).status,
      403,
    );
    assert.equal(
      (await call('PATCH', `/connections/${connection}`, 'admin', { name: 'Primary DB' })).body.name,
      'Primary DB',
    );
    assert.equal((await call('POST', `/connections/${connection}/disable`, 'admin')).body.enabled, false);
    assert.equal((await call('POST', `/connections/${connection}/enable`, 'admin')).body.enabled, true);
    assert.deepEqual(
      Object.keys((await call('GET', `/connections/${connection}/references`, 'reader')).body).sort(),
      ['activeExecutions', 'profiles', 'savedQueries'],
    );
    const throwaway = (await call('POST', '/connections', 'admin', connectionBody('Throwaway'))).body.id;
    assert.equal((await call('DELETE', `/connections/${throwaway}`, 'reader')).status, 403);
    assert.equal((await call('DELETE', `/connections/${throwaway}`, 'admin')).status, 200);
  });

  it('connection tests: administrators only, with failure categories', async () => {
    assert.equal((await call('POST', `/connections/${connection}/test`, 'reader')).status, 403);
    const stored = await call('POST', `/connections/${connection}/test`, 'admin');
    assert.deepEqual(
      [stored.status, stored.body.ok, stored.body.failure.category],
      [200, false, 'connectivity'],
    );
    const draft = await call('POST', '/connections/test', 'admin', {
      ...connectionBody('Draft'),
      name: undefined,
      environment: undefined,
      readOnly: undefined,
    });
    assert.deepEqual([draft.status, draft.body.failure?.category], [200, 'connectivity']);
    // Edited settings of a saved connection: an omitted CA means the stored one, as saving would keep it.
    const pem = '-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----';
    const withCa = (
      await call('POST', '/connections', 'admin', {
        ...connectionBody('With CA'),
        tlsMode: 'verify-ca',
        caPem: pem,
      })
    ).body.id;
    const edited = {
      ...connectionBody('With CA'),
      name: undefined,
      environment: undefined,
      readOnly: undefined,
      password: undefined,
      tlsMode: 'verify-ca',
      connectionId: withCa,
    };
    const kept = await call('POST', '/connections/test', 'admin', edited);
    assert.match(String(kept.body.tls?.description), /against the custom CA/);
    const cleared = await call('POST', '/connections/test', 'admin', { ...edited, caPem: null });
    assert.doesNotMatch(String(cleared.body.tls?.description), /custom CA/);
    assert.equal((await call('DELETE', `/connections/${withCa}`, 'admin')).status, 200);
    assert.equal((await call('POST', '/connections/test', 'admin', { engine: 'postgresql' })).status, 400);
  });

  it('metadata: database errors map to database_error; disabled connections are refused', async () => {
    const failed = await call('GET', `/connections/${connection}/metadata/databases`, 'reader');
    assert.deepEqual(
      [failed.status, failed.body.error, failed.body.details.category],
      [502, 'database_error', 'connectivity'],
    );
    await call('POST', `/connections/${readOnly}/disable`, 'admin');
    assert.equal(
      (await call('GET', `/connections/${readOnly}/metadata/schemas`, 'reader')).body.error,
      'connection_disabled',
    );
    await call('POST', `/connections/${readOnly}/enable`, 'admin');
    assert.equal((await call('GET', `/connections/${connection}/metadata/schemas`, 'monitor')).status, 403);
  });

  it('monitoring: monitor:read only; database errors are reported, not zeros', async () => {
    assert.equal((await call('GET', `/connections/${connection}/monitoring/activity`, 'reader')).status, 403);
    const activity = await call('GET', `/connections/${connection}/monitoring/activity`, 'monitor');
    assert.deepEqual([activity.status, activity.body.error], [502, 'database_error']);
    assert.equal(
      (await call('GET', `/connections/${connection}/monitoring/statements?limit=500`, 'monitor')).status,
      400,
    );
  });

  it('executions: submit, idempotency, policy rejection, visibility, cancel', async () => {
    const submitted = await call('POST', '/executions', 'writer', {
      connectionId: connection,
      sql: 'SELECT 1',
      requestKey: 'contract-0001',
    });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.status, 'queued');
    assert.equal(submitted.body.queue.position, 1);
    const again = await call('POST', '/executions', 'writer', {
      connectionId: connection,
      sql: 'SELECT 1',
      requestKey: 'contract-0001',
    });
    assert.equal(again.body.id, submitted.body.id);
    const conflict = await call('POST', '/executions', 'writer', {
      connectionId: connection,
      sql: 'SELECT 2',
      requestKey: 'contract-0001',
    });
    assert.deepEqual([conflict.status, conflict.body.error], [409, 'idempotency_conflict']);
    const rejected = await call('POST', '/executions', 'writer', {
      connectionId: readOnly,
      sql: 'DELETE FROM t',
    });
    assert.deepEqual([rejected.status, rejected.body.error], [422, 'read_only_policy']);
    assert.equal(rejected.body.details.execution.status, 'preflight_rejected');
    const tx = await call('POST', '/executions', 'writer', {
      connectionId: connection,
      sql: 'BEGIN; SELECT 1; COMMIT',
    });
    assert.deepEqual([tx.status, tx.body.error], [422, 'preflight_rejected']);
    assert.equal(
      (await call('POST', '/executions', 'monitor', { connectionId: connection, sql: 'SELECT 1' })).status,
      403,
    );
    assert.equal((await call('GET', `/executions/${submitted.body.id}`, 'reader')).status, 404);
    assert.equal((await call('GET', `/executions/${submitted.body.id}`, 'admin')).status, 200);
    assert.ok(
      (await call('GET', '/executions?limit=10', 'writer')).body.some(
        (e: { id: string }) => e.id === submitted.body.id,
      ),
    );
    assert.equal((await call('GET', '/executions?limit=0', 'writer')).status, 400);
    const cancelled = await call('POST', `/executions/${submitted.body.id}/cancel`, 'writer');
    assert.deepEqual([cancelled.status, cancelled.body.status], [200, 'cancelled']);
  });

  it('results, exports and downloads', async () => {
    const { body } = await call('POST', '/executions', 'writer', {
      connectionId: connection,
      sql: 'SELECT 1 AS a',
      title: 'Contract result',
    });
    core.db.run("UPDATE executions SET status = 'succeeded' WHERE id = :id", { id: body.id });
    core.db.run(
      `INSERT INTO result_sets (execution_id, result_index, statement, columns, row_count, byte_count, completeness, expires_at)
       VALUES (:id, 0, 0, '[{"name":"a","type":"int4","binary":false}]', 1, 6, 'complete', '2999-01-01T00:00:00Z')`,
      { id: body.id },
    );
    core.db.run(
      'INSERT INTO result_chunks (execution_id, result_index, chunk_index, row_start, row_count, byte_count, data) VALUES (:id, 0, 0, 0, 1, 6, :d)',
      { id: body.id, d: Buffer.from('[["1"]]') },
    );
    const rows = await call('GET', `/executions/${body.id}/results/0/rows?limit=10`, 'writer');
    assert.deepEqual([rows.status, rows.body.rows, rows.body.completeness], [200, [['1']], 'complete']);
    assert.equal((await call('GET', `/executions/${body.id}/results/x/rows`, 'writer')).status, 400);
    assert.equal(
      (await call('GET', `/executions/${body.id}/results/0/rows?limit=5000`, 'writer')).status,
      400,
    );

    const created = await call('POST', `/executions/${body.id}/results/0/exports`, 'writer', {
      format: 'csv',
    });
    assert.deepEqual([created.status, created.body.status], [202, 'generating']);
    await core.exports.idle();
    assert.equal((await call('GET', `/exports/${created.body.id}`, 'writer')).body.status, 'ready');
    const download = await call('GET', `/exports/${created.body.id}/download`, 'writer');
    assert.equal(download.status, 200);
    assert.equal(download.body, 'a\r\n1\r\n');
    assert.match(
      String(download.headers['content-disposition']),
      /^attachment; filename="contract-result-exp_\w+\.csv"/,
    );
    assert.equal((await call('GET', `/exports/${created.body.id}/download`, 'reader')).status, 404);
    assert.equal((await call('POST', `/exports/${created.body.id}/regenerate`, 'writer')).status, 202);
    await core.exports.idle();
    assert.equal((await call('GET', `/executions/${body.id}/exports`, 'writer')).body.length, 1);
    const deleted = await call('DELETE', `/executions/${body.id}/results`, 'writer');
    assert.deepEqual([deleted.status, deleted.body.bytesFreed], [200, 6]);
    assert.equal(
      (await call('GET', `/executions/${body.id}/results/0/rows`, 'writer')).body.error,
      'result_expired',
    );
  });

  it('editor support, retention and sharing with MCP', async () => {
    const check = await call('POST', '/sql/check', 'writer', {
      connectionId: readOnly,
      sql: 'SELECT 1;\nUPDATE t SET a = 1',
    });
    assert.equal(check.status, 200);
    assert.deepEqual([check.body.readOnly, check.body.policySources], [true, ['connection']]);
    assert.deepEqual(
      check.body.statements.map((s: { kind: string; range: { startLine: number } }) => [
        s.kind,
        s.range.startLine,
      ]),
      [
        ['read', 1],
        ['write', 2],
      ],
    );
    assert.equal(check.body.problems[0].code, 'read_only_violation');
    assert.equal(
      (await call('POST', '/sql/check', 'monitor', { connectionId: connection, sql: 'SELECT 1' })).status,
      403,
    );

    const { body } = await call('POST', '/executions', 'writer', {
      connectionId: connection,
      sql: 'SELECT 1 AS a',
    });
    core.db.run(
      "UPDATE executions SET status = 'succeeded', finished_at = '2026-11-07T10:00:00Z' WHERE id = :id",
      { id: body.id },
    );
    core.db.run(
      `INSERT INTO result_sets (execution_id, result_index, statement, columns, row_count, byte_count, completeness, expires_at)
       VALUES (:id, 0, 0, '[]', 1, 6, 'complete', '2026-11-08T10:00:00Z')`,
      { id: body.id },
    );
    const retained = await call('POST', `/executions/${body.id}/retain`, 'writer', { days: 3 });
    assert.deepEqual(
      [retained.status, retained.body.retention, retained.body.resultExpiresAt],
      [200, 'retained', '2026-11-10T10:00:00.000Z'],
    );
    assert.equal((await call('POST', `/executions/${body.id}/retain`, 'writer', { days: 99 })).status, 400);

    const profile = await call('POST', '/profiles', 'admin', {
      name: 'Sharing',
      clientId: 'workbench-mcp-share',
      connectionIds: [connection],
    });
    const shared = await call('POST', `/executions/${body.id}/results/0/share`, 'writer', {
      profileId: profile.body.id,
      minutes: 30,
    });
    assert.deepEqual([shared.status, shared.body.status, shared.body.granted.rows], [201, 'active', 1]);
    assert.equal(
      (await call('POST', `/executions/${body.id}/results/0/share`, 'reader', { profileId: profile.body.id }))
        .status,
      404,
    );
  });

  it('library: folders and saved queries are private per user', async () => {
    const folder = await call('POST', '/folders', 'reader', { name: 'Reports' });
    assert.equal(folder.status, 201);
    const query = await call('POST', '/queries', 'reader', {
      name: 'Daily',
      sql: 'SELECT 1',
      folderId: folder.body.id,
    });
    assert.equal(query.status, 201);
    assert.equal((await call('GET', `/queries?folderId=${folder.body.id}`, 'reader')).body.length, 1);
    assert.equal((await call('GET', '/queries?search=daily', 'reader')).body.length, 1);
    assert.equal((await call('GET', `/queries/${query.body.id}`, 'writer')).status, 404);
    assert.equal(
      (await call('PATCH', `/queries/${query.body.id}`, 'reader', { name: 'Daily totals' })).body.name,
      'Daily totals',
    );
    assert.equal(
      (await call('POST', `/queries/${query.body.id}/duplicate`, 'reader', { name: 'Copy' })).status,
      201,
    );
    assert.equal(
      (await call('PATCH', `/folders/${folder.body.id}`, 'reader', { name: 'Monthly' })).body.name,
      'Monthly',
    );
    assert.equal((await call('DELETE', `/queries/${query.body.id}`, 'reader')).status, 204);
    const removed = await call('DELETE', `/folders/${folder.body.id}?mode=delete-contents`, 'reader');
    assert.deepEqual([removed.status, removed.body.deletedQueries], [200, 1]);
    assert.equal((await call('GET', '/folders', 'monitor')).status, 403);
  });

  it('MCP profiles: readers see, administrators manage', async () => {
    assert.equal(
      (
        await call('POST', '/profiles', 'reader', {
          name: 'P',
          clientId: 'workbench-mcp',
          connectionIds: [connection],
        })
      ).status,
      403,
    );
    const created = await call('POST', '/profiles', 'admin', {
      name: 'Claude Code',
      clientId: 'workbench-mcp',
      connectionIds: [connection],
    });
    assert.equal(created.status, 201);
    assert.ok(
      (await call('GET', '/profiles', 'reader')).body.some((p: { name: string }) => p.name === 'Claude Code'),
    );
    assert.equal((await call('GET', `/profiles/${created.body.id}/access`, 'reader')).body.length, 2);
    assert.equal(
      (await call('PATCH', `/profiles/${created.body.id}`, 'admin', { readOnly: false })).body.profile
        .readOnly,
      false,
    );
    assert.equal((await call('DELETE', `/profiles/${created.body.id}`, 'admin')).status, 204);
  });

  it('settings and audit', async () => {
    assert.equal((await call('GET', '/settings/execution', 'monitor')).status, 200);
    const storage = await call('GET', '/settings/storage', 'reader');
    assert.deepEqual([storage.status, storage.body.totalLimitBytes], [200, config.limits.maxTotalBytes]);
    assert.equal(
      (await call('PATCH', '/settings/execution', 'reader', { ordinaryTimeoutMs: 20000 })).status,
      403,
    );
    assert.equal(
      (await call('PATCH', '/settings/execution', 'admin', { ordinaryTimeoutMs: 20000 })).body
        .ordinaryTimeoutMs,
      20000,
    );
    assert.equal((await call('GET', '/audit', 'reader')).status, 403);
    const audit = await call('GET', '/audit?actionPrefix=connection.&limit=5', 'admin');
    assert.equal(audit.status, 200);
    assert.ok(audit.body.length > 0 && audit.body.length <= 5);
  });

  it('publishes an OpenAPI document covering every route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    assert.equal(response.statusCode, 200);
    const doc = response.json();
    assert.equal(doc.openapi, '3.0.3');
    const operations = Object.values(doc.paths as Record<string, object>).reduce(
      (n: number, p) => n + Object.keys(p).length,
      0,
    );
    assert.equal(operations, v1Routes(core, config).routes.length);
    const submit = doc.paths['/api/v1/executions'].post;
    assert.ok(submit.requestBody.content['application/json'].schema.properties.sql);
    assert.ok(doc.components.schemas.Error.properties.error.enum.includes('read_only_policy'));
  });
});

describe('live status stream', () => {
  it('sends execution changes to their owner and ends when the token expires', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const connectionId = (await call('POST', '/connections', 'admin', connectionBody('Events'))).body.id;
    const short = await issuer.gui({ subject: 'writer', roles: ['query:read', 'query:write'], expiresIn: 3 });
    const response = await fetch(`${address}/api/v1/events`, {
      headers: { authorization: `Bearer ${short}` },
    });
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (until: RegExp) => {
      while (!until.test(text)) {
        const { value, done } = await reader.read();
        if (done) return false;
        text += decoder.decode(value);
      }
      return true;
    };
    assert.ok(await read(/event: ready/));
    const mine = await call('POST', '/executions', 'writer', { connectionId, sql: 'SELECT 1' });
    await call('POST', '/executions', 'reader', { connectionId, sql: 'SELECT 2' });
    assert.ok(
      await read(
        new RegExp(`event: execution\\nid: \\d+\\ndata: \\{"id":"${mine.body.id}","status":"queued"`),
      ),
    );
    await call('POST', `/executions/${mine.body.id}/cancel`, 'writer');
    assert.ok(await read(/"status":"cancelled"/));
    assert.doesNotMatch(text, /SELECT 2/);
    // After a reconnect the client fetches what it follows by ID and sees the same state.
    assert.equal((await call('GET', `/executions/${mine.body.id}`, 'writer')).body.status, 'cancelled');
    assert.equal(await read(/never/), false, 'the stream ends at token expiry');
  });
});
