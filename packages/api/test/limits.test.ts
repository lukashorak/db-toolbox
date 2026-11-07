import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyRequest } from 'fastify';
import {
  AppError,
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
import {
  buildServer,
  RateLimiter,
  RequestGuard,
  securityHeaders,
  type WorkbenchServer,
} from '../src/index.js';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

describe('rate limiter', () => {
  it('allows bursts up to the limit, then refills at the limit per minute', () => {
    let now = 0;
    const limiter = new RateLimiter(3, () => now);
    for (let i = 0; i < 3; i++) limiter.take('a', 'requests');
    assert.throws(
      () => limiter.take('a', 'requests'),
      (e: unknown) => code('rate_limited')(e) && (e as AppError).details?.retryAfterSeconds === 20,
    );
    limiter.take('b', 'requests');
    now += 20_000;
    limiter.take('a', 'requests');
    assert.equal(limiter.wait('a'), 20);
    now += 60_000;
    for (let i = 0; i < 3; i++) limiter.take('a', 'requests');
    assert.throws(() => limiter.take('a', 'requests'), code('rate_limited'), 'never more than the burst');
  });

  it('is off at 0', () => {
    const limiter = new RateLimiter(0);
    for (let i = 0; i < 1000; i++) limiter.take('a', 'requests');
    assert.equal(limiter.wait('a'), 0);
  });
});

describe('request guard', () => {
  const actor = (subject: string, clientId: string): Actor => ({
    subject,
    username: subject,
    displayName: subject,
    roles: ['query:read'],
    source: clientId === GUI_CLIENT ? 'gui' : 'mcp',
    clientId,
  });
  const request = (authorization: string, ip = '10.0.0.1') =>
    ({ ip, headers: { authorization } }) as unknown as FastifyRequest;

  it('counts MCP calls per user and client, separately from the GUI', async () => {
    const stub = {
      authenticate: async (header: string | undefined, kind: 'gui' | 'mcp') =>
        actor(
          String(header),
          kind === 'gui' ? GUI_CLIENT : (String(header).split(' ')[1] ?? 'workbench-mcp'),
        ),
    } as unknown as Authenticator;
    const guard = new RequestGuard(
      stub,
      { apiPerMinute: 2, mcpPerMinute: 1, authFailuresPerMinute: 5 },
      () => 0,
    );
    await guard.authenticate(request('alice workbench-mcp'), 'mcp');
    await assert.rejects(guard.authenticate(request('alice workbench-mcp'), 'mcp'), code('rate_limited'));
    await guard.authenticate(request('alice other-client'), 'mcp');
    await guard.authenticate(request('alice'), 'gui');
    await guard.authenticate(request('alice'), 'gui');
    await assert.rejects(guard.authenticate(request('alice'), 'gui'), code('rate_limited'));
    await guard.authenticate(request('bob'), 'gui');
  });
});

describe('HTTP limits and headers', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL,
    KEYCLOAK_ISSUER: ISSUER,
    ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
    RATE_LIMIT_PER_MINUTE: '3',
    AUTH_FAILURES_PER_MINUTE: '2',
  });
  let issuer: TestIssuer;
  let core: Core;
  let app: WorkbenchServer;
  let now = 0;

  before(async () => {
    issuer = await createTestIssuer();
    core = createCore({
      databaseFile: ':memory:',
      encryptionKey: config.encryptionKey,
      limits: config.limits,
    });
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
      guard: new RequestGuard(authenticator, config.rateLimits, () => now),
      webDist: false,
    });
  });
  after(async () => {
    await app.close();
    await core.shutdown();
  });

  const session = (token: string, remoteAddress = '10.0.0.1') =>
    app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { authorization: `Bearer ${token}` },
      remoteAddress,
    });

  it('answers 429 with Retry-After once a user has used the limit', async () => {
    const alice = await issuer.gui({ subject: 'alice', roles: ['query:read'] });
    for (let i = 0; i < 3; i++) assert.equal((await session(alice)).statusCode, 200);
    const limited = await session(alice);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.headers['retry-after'], '20');
    assert.equal(limited.json().error, 'rate_limited');
    const bob = await issuer.gui({ subject: 'bob', roles: ['query:read'] });
    assert.equal((await session(bob)).statusCode, 200, 'other users are not affected');
    now += 20_000;
    assert.equal((await session(alice)).statusCode, 200);
  });

  it('refuses an address after repeated rejected tokens, even with a valid one', async () => {
    const forged = await issuer.foreign({ subject: 'mallory', roles: ['admin'] });
    assert.equal((await session(forged, '10.0.0.9')).statusCode, 401);
    assert.equal((await session(forged, '10.0.0.9')).statusCode, 401);
    assert.equal((await session(forged, '10.0.0.9')).statusCode, 429);
    const carol = await issuer.gui({ subject: 'carol', roles: ['query:read'] });
    assert.equal((await session(carol, '10.0.0.9')).statusCode, 429);
    assert.equal((await session(carol, '10.0.0.10')).statusCode, 200, 'other addresses are not affected');
    now += 30_000;
    assert.equal((await session(carol, '10.0.0.9')).statusCode, 200);
  });

  it('sends security headers on every response', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    const csp = String(response.headers['content-security-policy']);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /connect-src 'self' https:\/\/auth\.example\.test(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/session',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    assert.equal(preflight.headers['access-control-allow-origin'], undefined, 'no CORS');
    const errors = await app.inject({ method: 'GET', url: '/api/v1/session' });
    assert.equal(errors.statusCode, 401);
    assert.equal(errors.headers['x-frame-options'], 'DENY');
    assert.equal(
      securityHeaders({ keycloakIssuer: ISSUER, publicUrl: 'http://127.0.0.1:3000' })[
        'strict-transport-security'
      ],
      undefined,
      'no HSTS without HTTPS',
    );
  });
});
