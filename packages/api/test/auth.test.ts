import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  Authenticator,
  createCore,
  createLogger,
  loadConfig,
  TokenVerifier,
  type Actor,
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

const config = loadConfig({
  NODE_ENV: 'test',
  PUBLIC_URL,
  KEYCLOAK_ISSUER: ISSUER,
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
});

let issuer: TestIssuer;
let core: Core;
let app: WorkbenchServer;
let connectionId: string;

const ADMIN_ROLES = ['query:read', 'query:write', 'admin'];

before(async () => {
  issuer = await createTestIssuer();
  core = createCore({ databaseFile: ':memory:', encryptionKey: config.encryptionKey, limits: config.limits });
  const verifier = new TokenVerifier({
    issuer: ISSUER,
    guiClientId: GUI_CLIENT,
    apiAudience: API_AUDIENCE,
    mcpAudience: MCP_AUDIENCE,
    jwks: issuer.jwks,
  });
  const authenticator = new Authenticator(verifier, { users: core.users, profiles: core.profiles });
  app = await buildServer(config, {
    logger: createLogger({ level: 'silent' }),
    core,
    authenticator,
    version: '0.0.0-test',
    webDist: false,
  });
  const actor: Actor = {
    subject: 'admin-1',
    username: 'admin',
    displayName: 'Admin',
    roles: ['query:read', 'query:write', 'admin'],
    source: 'gui',
    clientId: GUI_CLIENT,
  };
  core.users.touch(actor);
  connectionId = core.connections.create(actor, {
    name: 'Analytics',
    engine: 'postgresql',
    environment: 'production',
    host: 'pg.example.test',
    port: 5432,
    database: 'analytics',
    username: 'wb_ro',
    password: 'not-a-real-password',
    tlsMode: 'verify-full',
    readOnly: false,
  }).id;
  core.connections.create(actor, {
    name: 'Hidden',
    engine: 'mysql',
    environment: 'development',
    host: 'mysql.example.test',
    port: 3306,
    database: 'app',
    username: 'wb',
    password: 'not-a-real-password',
    tlsMode: 'require',
    readOnly: false,
  });
  core.profiles.create(actor, {
    name: 'Claude Code',
    clientId: 'workbench-mcp',
    connectionIds: [connectionId],
    readOnly: true,
  });
  core.profiles.create(actor, {
    name: 'Paused',
    clientId: 'workbench-mcp-paused',
    connectionIds: [connectionId],
    enabled: false,
  });
});

after(async () => {
  await app.close();
  core.close();
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('API authentication', () => {
  it('serves client configuration without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/client-config' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      issuer: ISSUER,
      clientId: 'workbench-gui',
      scope: 'openid profile email',
      redirectUri: `${PUBLIC_URL}/auth/callback`,
      postLogoutRedirectUri: `${PUBLIC_URL}/`,
      mcp: { url: `${PUBLIC_URL}/mcp`, audience: MCP_AUDIENCE, clientId: 'workbench-mcp' },
    });
  });

  it('challenges requests without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.headers['www-authenticate'], 'Bearer realm="workbench"');
    const body = response.json();
    assert.equal(body.error, 'unauthenticated');
    assert.ok(body.requestId);
  });

  it('distinguishes expired tokens, wrong audiences and wrong clients', async () => {
    const cases = [
      [await issuer.gui({ subject: 'u-1', expiresIn: -120 }), 'token_expired'],
      [await issuer.mcp({ subject: 'u-1' }), 'wrong_audience'],
      [await issuer.gui({ subject: 'u-1', clientId: 'another-app' }), 'wrong_client'],
      [await issuer.foreign({ subject: 'u-1' }), 'invalid_token'],
    ] as const;
    for (const [token, code] of cases) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/session', headers: bearer(token) });
      assert.equal(response.statusCode, 401, code);
      assert.equal(response.json().error, code);
      assert.match(String(response.headers['www-authenticate']), /error="invalid_token"/);
    }
  });

  it('rejects users without a workbench role', async () => {
    const token = await issuer.gui({ subject: 'u-2', roles: ['offline_access'] });
    const response = await app.inject({ method: 'GET', url: '/api/v1/session', headers: bearer(token) });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error, 'no_role');
  });

  it('returns the session with permissions derived from roles', async () => {
    const token = await issuer.gui({ subject: 'u-3', roles: ['query:read', 'monitor:read'] });
    const response = await app.inject({ method: 'GET', url: '/api/v1/session', headers: bearer(token) });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.user, {
      subject: 'u-3',
      username: 'u-3',
      displayName: 'u-3 Test',
      roles: ['query:read', 'monitor:read'],
    });
    assert.deepEqual(body.permissions, [
      'connections.view',
      'disclosure.decide',
      'monitor.view',
      'queries.manage',
      'sql.read',
    ]);
    assert.ok(Date.parse(body.tokenExpiresAt) > Date.now());
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/nothing-here' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, 'not_found');
  });
});

describe('MCP authentication', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  };
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = (payload: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...mcpHeaders, ...(token ? bearer(token) : {}) },
      payload: JSON.stringify(payload),
    });

  it('publishes protected resource metadata pointing to Keycloak', async () => {
    for (const url of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 200, url);
      assert.deepEqual(response.json(), {
        resource: MCP_AUDIENCE,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ['header'],
        scopes_supported: ['openid', 'profile', 'email'],
        resource_name: 'Database Workbench',
      });
    }
  });

  it('challenges unauthenticated calls with the resource metadata URL', async () => {
    const response = await post(initialize);
    assert.equal(response.statusCode, 401);
    assert.equal(
      response.headers['www-authenticate'],
      `Bearer realm="workbench", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('rejects GUI tokens, unknown clients and disabled profiles', async () => {
    const gui = await post(initialize, await issuer.gui({ subject: 'u-4' }));
    assert.equal(gui.statusCode, 401);
    assert.equal(gui.json().error, 'wrong_audience');
    assert.match(String(gui.headers['www-authenticate']), /resource_metadata=.*error="invalid_token"/);

    const unknown = await post(
      initialize,
      await issuer.mcp({ subject: 'u-4', clientId: 'some-other-client' }),
    );
    assert.equal(unknown.statusCode, 403);
    assert.equal(unknown.json().error, 'profile_unknown');

    const paused = await post(
      initialize,
      await issuer.mcp({ subject: 'u-4', clientId: 'workbench-mcp-paused' }),
    );
    assert.equal(paused.statusCode, 403);
    assert.equal(paused.json().error, 'profile_disabled');
  });

  it('initializes and answers whoami with the profile resolved from the client', async () => {
    const token = await issuer.mcp({ subject: 'u-5', roles: ADMIN_ROLES, claims: { profile_id: 'forged' } });
    const init = await post(initialize, token);
    assert.equal(init.statusCode, 200);
    assert.equal(init.json().result.serverInfo.name, 'database-workbench');

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, token);
    assert.deepEqual(
      list.json().result.tools.map((t: { name: string }) => t.name),
      ['whoami'],
    );

    const call = await post(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } },
      token,
    );
    assert.equal(call.statusCode, 200);
    const whoami = call.json().result.structuredContent;
    assert.equal(whoami.user.subject, 'u-5');
    assert.equal(whoami.profile.name, 'Claude Code');
    assert.deepEqual(whoami.connections, [
      { id: connectionId, name: 'Analytics', readOnly: true, restrictedBy: ['profile'] },
    ]);
    assert.doesNotMatch(call.body, /not-a-real-password/);
  });

  it('accepts only POST', async () => {
    const response = await app.inject({ method: 'GET', url: '/mcp', headers: mcpHeaders });
    assert.equal(response.statusCode, 405);
    assert.equal(response.headers.allow, 'POST');
    assert.equal(response.json().error, 'method_not_allowed');
  });
});
