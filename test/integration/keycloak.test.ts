/**
 * Identity against a real Keycloak: realm import from buildRealm, the browser authorization code
 * flow with PKCE (as the GUI and Claude Code use it), refresh, expiry, audiences and the MCP OAuth
 * discovery that Claude Code relies on, driven by the official MCP SDK client.
 *
 *   scripts/integration/start.sh keycloak
 *   KEYCLOAK_TEST_URL=http://127.0.0.1:18080 npm run test:integration
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  Authenticator,
  buildRealm,
  createCore,
  createLogger,
  loadConfig,
  TokenVerifier,
  type Actor,
  type Config,
  type Core,
} from '@workbench/core';
import { buildServer, type WorkbenchServer } from '@workbench/api';
import { TOOLS } from '@workbench/mcp';
import {
  codeGrant,
  freePort,
  KEYCLOAK_URL,
  KeycloakAdmin,
  passwordGrant,
  refreshGrant,
  signInWithBrowser,
} from '../support/keycloak.js';
import { skipUnless } from '../support/services.js';

const REALM = 'workbench-it';
const MCP_CALLBACK = 'http://localhost:8765/callback';
const password = randomUUID();

/** Stands in for Claude Code: a pre-registered public client, tokens kept in memory. */
class StaticClientProvider implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  #tokens: OAuthTokens | undefined;
  #verifier = '';

  constructor(private readonly clientId: string) {}

  get redirectUrl() {
    return MCP_CALLBACK;
  }
  get clientMetadata() {
    return {
      client_name: 'Integration test',
      redirect_uris: [MCP_CALLBACK],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  clientInformation(): OAuthClientInformationMixed {
    return { client_id: this.clientId };
  }
  tokens() {
    return this.#tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.#tokens = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.#verifier = verifier;
  }
  codeVerifier() {
    return this.#verifier;
  }
}

describe('Keycloak integration', { skip: skipUnless('KEYCLOAK_TEST_URL') }, () => {
  const keycloak = new KeycloakAdmin(String(KEYCLOAK_URL));
  const issuer = `${KEYCLOAK_URL}/realms/${REALM}`;
  let base: string;
  let config: Config;
  let core: Core;
  let app: WorkbenchServer;

  before(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    await keycloak.importRealm(
      buildRealm({
        publicUrl: base,
        realm: REALM,
        testing: {
          users: [
            { username: 'alice', password, roles: ['query:read', 'query:write', 'admin'] },
            { username: 'bob', password, roles: ['query:read'] },
            { username: 'carol', password, roles: [] },
          ],
        },
      }),
    );
    config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_URL: base,
      KEYCLOAK_ISSUER: issuer,
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    });
    core = createCore({
      databaseFile: ':memory:',
      encryptionKey: config.encryptionKey,
      limits: config.limits,
    });
    const setup: Actor = {
      subject: 'setup',
      username: 'setup',
      displayName: 'Setup',
      roles: ['query:read', 'admin'],
      source: 'gui',
      clientId: config.guiClientId,
    };
    core.users.touch(setup);
    const connection = core.connections.create(setup, {
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
    });
    core.profiles.create(setup, {
      name: 'Claude Code',
      clientId: config.mcpClientId,
      connectionIds: [connection.id],
      readOnly: true,
    });
    const verifier = new TokenVerifier({
      issuer,
      guiClientId: config.guiClientId,
      apiAudience: config.apiAudience,
      mcpAudience: config.mcpAudience,
    });
    app = await buildServer(config, {
      logger: createLogger({ level: 'silent' }),
      core,
      authenticator: new Authenticator(verifier, { users: core.users, profiles: core.profiles }),
      webDist: false,
    });
    await app.listen({ host: '127.0.0.1', port });
  });

  after(async () => {
    await app?.close();
    core?.close();
    await keycloak.deleteRealm(REALM);
  });

  const pkce = () => {
    const verifier = randomBytes(32).toString('base64url');
    return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
  };
  const authorizeUrl = (clientId: string, redirectUri: string, challenge?: string) => {
    const url = new URL(`${issuer}/protocol/openid-connect/auth`);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid profile email',
      state: randomUUID(),
      ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
    }).toString();
    return url;
  };
  const session = (token: string) =>
    fetch(`${base}/api/v1/session`, { headers: { authorization: `Bearer ${token}` } });

  async function guiSignIn(username: string) {
    const { verifier, challenge } = pkce();
    const redirectUri = `${base}/auth/callback`;
    const callback = await signInWithBrowser(
      authorizeUrl('workbench-gui', redirectUri, challenge),
      username,
      password,
    );
    const code = callback.searchParams.get('code');
    assert.ok(code, `no code in ${callback.search}`);
    const tokens = await codeGrant(issuer, {
      clientId: 'workbench-gui',
      code,
      redirectUri,
      codeVerifier: verifier,
    });
    assert.equal(tokens.status, 200, tokens.body.error_description);
    return tokens.body;
  }

  it('signs in to the GUI with the authorization code flow and PKCE', async () => {
    const tokens = await guiSignIn('alice');
    const response = await session(tokens.access_token);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      user: { username: string; roles: string[] };
      permissions: string[];
    };
    assert.equal(body.user.username, 'alice');
    assert.deepEqual(body.user.roles.sort(), ['admin', 'query:read', 'query:write']);
    assert.ok(body.permissions.includes('sql.write'));
  });

  it('requires PKCE: no challenge or a wrong verifier is refused by Keycloak', async () => {
    const redirectUri = `${base}/auth/callback`;
    const refused = await signInWithBrowser(authorizeUrl('workbench-gui', redirectUri), 'alice', password);
    assert.equal(refused.searchParams.get('error'), 'invalid_request');

    const { challenge } = pkce();
    const callback = await signInWithBrowser(
      authorizeUrl('workbench-gui', redirectUri, challenge),
      'alice',
      password,
    );
    const exchange = await codeGrant(issuer, {
      clientId: 'workbench-gui',
      code: String(callback.searchParams.get('code')),
      redirectUri,
      codeVerifier: pkce().verifier,
    });
    assert.equal(exchange.status, 400);
    assert.equal(exchange.body.error, 'invalid_grant');
  });

  it('accepts a refreshed token and rejects an expired one', async () => {
    const tokens = await guiSignIn('bob');
    assert.ok(tokens.refresh_token);
    const refreshed = await refreshGrant(issuer, 'workbench-gui', tokens.refresh_token);
    assert.equal(refreshed.status, 200);
    assert.notEqual(refreshed.body.access_token, tokens.access_token);
    assert.equal((await session(refreshed.body.access_token)).status, 200);

    const later = new TokenVerifier({
      issuer,
      guiClientId: config.guiClientId,
      apiAudience: config.apiAudience,
      mcpAudience: config.mcpAudience,
      clock: { now: () => new Date(Date.now() + (refreshed.body.expires_in + 120) * 1000) },
    });
    await assert.rejects(later.verify(refreshed.body.access_token, 'gui'), { code: 'token_expired' });
  });

  it('keeps GUI and MCP tokens apart and rejects users without a role', async () => {
    const mcp = await passwordGrant(issuer, 'workbench-mcp', 'bob', password);
    const atApi = await session(mcp.body.access_token);
    assert.equal(atApi.status, 401);
    assert.equal(((await atApi.json()) as { error: string }).error, 'wrong_audience');

    const gui = await passwordGrant(issuer, 'workbench-gui', 'bob', password);
    const atMcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gui.body.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(atMcp.status, 401);
    assert.equal(((await atMcp.json()) as { error: string }).error, 'wrong_audience');

    const carol = await passwordGrant(issuer, 'workbench-gui', 'carol', password);
    const noRole = await session(carol.body.access_token);
    assert.equal(noRole.status, 403);
    assert.equal(((await noRole.json()) as { error: string }).error, 'no_role');
  });

  it('lets an MCP client discover Keycloak, sign in with PKCE and call a tool', async () => {
    const url = new URL(`${base}/mcp`);
    const provider = new StaticClientProvider('workbench-mcp');

    const first = new Client({ name: 'integration', version: '1.0.0' });
    await assert.rejects(
      first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider })),
      UnauthorizedError,
    );
    const authorizationUrl = provider.authorizationUrl;
    assert.ok(authorizationUrl, 'the client found the authorization endpoint through discovery');
    assert.equal(
      authorizationUrl.origin + authorizationUrl.pathname,
      `${issuer}/protocol/openid-connect/auth`,
    );
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorizationUrl.searchParams.get('resource'), url.href);

    const callback = await signInWithBrowser(authorizationUrl, 'bob', password);
    const code = callback.searchParams.get('code');
    assert.ok(code, `no code in ${callback.search}`);
    await new StreamableHTTPClientTransport(url, { authProvider: provider }).finishAuth(code);
    assert.ok(provider.tokens()?.access_token);

    const client = new Client({ name: 'integration', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    const whoami = result.structuredContent as { user: { username: string }; profile: { name: string } };
    assert.equal(whoami.user.username, 'bob');
    assert.equal(whoami.profile.name, 'Claude Code');
    const listed = await client.callTool({ name: 'list_connections', arguments: {} });
    const connections = (
      listed.structuredContent as {
        connections: { name: string; readOnly: boolean; readOnlyBecause: string[] }[];
      }
    ).connections;
    assert.deepEqual(
      connections.map((c) => [c.name, c.readOnly, c.readOnlyBecause]),
      [['Analytics', true, ['user', 'profile']]],
    );
    await client.close();
  });
});
