import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { SignJWT } from 'jose';
import {
  API_AUDIENCE,
  createTestIssuer,
  GUI_CLIENT,
  ISSUER,
  MCP_AUDIENCE,
  PUBLIC_URL,
  type TestIssuer,
} from '../../../test/support/oidc.js';
import { AppError } from '../src/domain/errors.js';
import { Authenticator } from '../src/identity/authenticator.js';
import { buildRealm } from '../src/identity/realm.js';
import { TokenVerifier } from '../src/identity/tokens.js';
import { admin, pgInput, testCore } from './helpers.js';

let issuer: TestIssuer;
let verifier: TokenVerifier;
before(async () => {
  issuer = await createTestIssuer();
  verifier = new TokenVerifier({
    issuer: ISSUER,
    guiClientId: GUI_CLIENT,
    apiAudience: API_AUDIENCE,
    mcpAudience: MCP_AUDIENCE,
    jwks: issuer.jwks,
  });
});

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof AppError && error.code === code);

describe('token verification', () => {
  it('accepts a GUI token and maps identity and known roles', async () => {
    const token = await issuer.gui({
      subject: 'u-1',
      roles: ['query:read', 'offline_access', 'default-roles-workbench'],
      claims: { resource_access: { [GUI_CLIENT]: { roles: ['monitor:read'] }, other: { roles: ['admin'] } } },
    });
    const verified = await verifier.verify(token, 'gui');
    assert.equal(verified.subject, 'u-1');
    assert.equal(verified.username, 'u-1');
    assert.equal(verified.displayName, 'u-1 Test');
    assert.equal(verified.email, 'u-1@example.test');
    assert.equal(verified.clientId, GUI_CLIENT);
    assert.deepEqual(verified.roles, ['query:read', 'monitor:read']);
    assert.ok(Date.parse(verified.expiresAt) > Date.now());
  });

  it('accepts a token with several audiences when the expected one is present', async () => {
    const token = await issuer.gui({ subject: 'u-1', audience: ['account', API_AUDIENCE] });
    assert.equal((await verifier.verify(token, 'gui')).subject, 'u-1');
  });

  it('rejects expired tokens with token_expired', async () => {
    await rejects(
      verifier.verify(await issuer.gui({ subject: 'u-1', expiresIn: -120 }), 'gui'),
      'token_expired',
    );
  });

  it('keeps GUI and MCP audiences apart', async () => {
    await rejects(verifier.verify(await issuer.mcp({ subject: 'u-1' }), 'gui'), 'wrong_audience');
    await rejects(verifier.verify(await issuer.gui({ subject: 'u-1' }), 'mcp'), 'wrong_audience');
  });

  it('rejects another issuer, an unknown key and a malformed token', async () => {
    await rejects(
      verifier.verify(
        await issuer.gui({ subject: 'u-1', issuer: 'https://evil.example.test/realms/workbench' }),
        'gui',
      ),
      'invalid_token',
    );
    await rejects(verifier.verify(await issuer.foreign({ subject: 'u-1' }), 'gui'), 'invalid_token');
    await rejects(verifier.verify('not-a-jwt', 'gui'), 'invalid_token');
  });

  it('rejects symmetric and unsigned tokens', async () => {
    const hs = await new SignJWT({ azp: GUI_CLIENT })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setSubject('u-1')
      .setAudience(API_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-that-is-long-enough!'));
    await rejects(verifier.verify(hs, 'gui'), 'invalid_token');
    const [, payload] = (await issuer.gui({ subject: 'u-1' })).split('.');
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`;
    await rejects(verifier.verify(none, 'gui'), 'invalid_token');
  });

  it('requires GUI tokens to come from the GUI client', async () => {
    await rejects(
      verifier.verify(await issuer.gui({ subject: 'u-1', clientId: 'other-app' }), 'gui'),
      'wrong_client',
    );
  });

  it('accepts only access tokens', async () => {
    await rejects(
      verifier.verify(await issuer.gui({ subject: 'u-1', claims: { typ: 'ID' } }), 'gui'),
      'invalid_token',
    );
  });

  it('requires an authorized party', async () => {
    await rejects(
      verifier.verify(await issuer.gui({ subject: 'u-1', claims: { azp: undefined } }), 'gui'),
      'invalid_token',
    );
  });
});

describe('authenticator', () => {
  const setup = () => {
    const core = testCore();
    const connection = core.connections.create(admin, pgInput);
    const authenticator = new Authenticator(verifier, { users: core.users, profiles: core.profiles });
    return { core, connection, authenticator };
  };

  it('requires a bearer token', async () => {
    const { authenticator } = setup();
    await rejects(authenticator.authenticate(undefined, 'gui'), 'unauthenticated');
    await rejects(authenticator.authenticate('Basic dXNlcjpwYXNz', 'gui'), 'unauthenticated');
    await rejects(authenticator.authenticate('Bearer', 'gui'), 'unauthenticated');
  });

  it('builds a GUI actor and records the user', async () => {
    const { core, authenticator } = setup();
    const actor = await authenticator.authenticate(`Bearer ${await issuer.gui({ subject: 'u-7' })}`, 'gui');
    assert.equal(actor.source, 'gui');
    assert.equal(actor.clientId, GUI_CLIENT);
    assert.deepEqual(actor.roles, ['query:read']);
    assert.equal(actor.profileId, undefined);
    assert.equal(core.users.get('u-7')?.displayName, 'u-7 Test');
  });

  it('rejects users without a workbench role', async () => {
    const { authenticator } = setup();
    const token = await issuer.gui({ subject: 'u-1', roles: ['offline_access'] });
    await rejects(authenticator.authenticate(`Bearer ${token}`, 'gui'), 'no_role');
  });

  it('resolves the MCP profile from the OAuth client only', async () => {
    const { core, connection, authenticator } = setup();
    const owner = { ...admin, subject: 'u-9', username: 'u-9' };
    core.users.touch(owner);
    const bearer = async (clientId: string, subject = 'u-9') =>
      `Bearer ${await issuer.mcp({ subject, clientId, claims: { profile_id: 'mcp_forged' } })}`;

    await rejects(authenticator.authenticate(await bearer('workbench-mcp'), 'mcp'), 'profile_unknown');

    const profile = core.profiles.create(owner, {
      name: 'Claude Code',
      clientId: 'workbench-mcp',
      connectionIds: [connection.id],
    });
    const actor = await authenticator.authenticate(await bearer('workbench-mcp'), 'mcp');
    assert.equal(actor.source, 'mcp');
    assert.equal(actor.profileId, profile.id);

    // Profiles are shared: another user signing in through the same client gets the same profile.
    const other = await authenticator.authenticate(await bearer('workbench-mcp', 'someone-else'), 'mcp');
    assert.equal(other.subject, 'someone-else');
    assert.equal(other.profileId, profile.id);

    core.profiles.update(owner, profile.id, { enabled: false });
    await rejects(authenticator.authenticate(await bearer('workbench-mcp'), 'mcp'), 'profile_disabled');
  });
});

describe('realm template', () => {
  it('describes two public PKCE clients with separate audiences and no secrets', () => {
    const realm = buildRealm({ publicUrl: PUBLIC_URL }) as {
      realm: string;
      clients: Record<string, unknown>[];
      roles: { realm: { name: string }[] };
      users?: unknown;
    };
    assert.equal(realm.realm, 'workbench');
    assert.deepEqual(
      realm.roles.realm.map((r) => r.name),
      ['query:read', 'query:write', 'monitor:read', 'admin'],
    );
    assert.equal(realm.users, undefined);
    const [gui, mcp] = realm.clients as {
      clientId: string;
      publicClient: boolean;
      directAccessGrantsEnabled: boolean;
      redirectUris: string[];
      attributes: Record<string, string>;
      protocolMappers: { config: Record<string, string> }[];
    }[];
    assert.ok(gui && mcp);
    assert.equal(gui.clientId, 'workbench-gui');
    assert.deepEqual(gui.redirectUris, [`${PUBLIC_URL}/auth/callback`]);
    assert.equal(gui.protocolMappers[0]?.config['included.custom.audience'], 'workbench-api');
    assert.equal(mcp.clientId, 'workbench-mcp');
    assert.deepEqual(mcp.redirectUris, ['http://localhost:8765/callback', 'http://127.0.0.1:8765/callback']);
    assert.equal(mcp.protocolMappers[0]?.config['included.custom.audience'], `${PUBLIC_URL}/mcp`);
    for (const client of [gui, mcp]) {
      assert.equal(client.publicClient, true);
      assert.equal(client.directAccessGrantsEnabled, false);
      assert.equal(client.attributes['pkce.code.challenge.method'], 'S256');
    }
    assert.doesNotMatch(JSON.stringify(realm), /secret|password/i);
  });

  it('rejects a public URL with a path', () => {
    assert.throws(() => buildRealm({ publicUrl: `${PUBLIC_URL}/workbench` }), /without a path/);
  });
});
