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
  MCP_CLIENT,
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
import { MAX_KEYS } from '../src/rate-limit.js';
import { admin, pgInput } from '../../core/test/helpers.js';

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

  it('keeps memory and work bounded under a flood of distinct keys', () => {
    let now = 0;
    const limiter = new RateLimiter(60, () => now);
    const started = performance.now();
    for (let i = 0; i < 3 * MAX_KEYS; i++) {
      now = i / 100;
      try {
        limiter.take(`10.0.${i >> 8}.${i & 255}`, 'requests');
      } catch {
        // Overflow keys are limited as a group; that is expected here.
      }
    }
    const ms = performance.now() - started;
    assert.ok(limiter.size <= MAX_KEYS, `${limiter.size} keys`);
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms for ${3 * MAX_KEYS} new keys`);
  });

  it('never forgets a key that is still limited, however many other keys arrive', () => {
    const limiter = new RateLimiter(3, () => 0);
    for (let i = 0; i < 3; i++) limiter.take('attacker', 'requests');
    assert.throws(() => limiter.take('attacker', 'requests'), code('rate_limited'));
    // Fill the table with other limited keys (no time passes, so none is full again).
    for (let i = 0; i < MAX_KEYS - 1; i++) limiter.take(`other-${i}`, 'requests');
    assert.equal(limiter.size, MAX_KEYS);
    // New keys now share one overflow bucket: three requests, then limited as a group.
    for (let i = 0; i < 3; i++) limiter.take(`new-${i}`, 'requests');
    assert.throws(() => limiter.take('new-3', 'requests'), code('rate_limited'));
    assert.equal(limiter.size, MAX_KEYS);
    assert.ok(limiter.wait('attacker') > 0, 'the limited key is still limited');
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

  it('bounds verifications running at once from one address by its failure allowance', async () => {
    let started = 0;
    const pending: (() => void)[] = [];
    const stub = {
      authenticate: () =>
        new Promise((resolve) => {
          started++;
          pending.push(() => resolve(actor('alice', GUI_CLIENT)));
        }),
    } as unknown as Authenticator;
    const guard = new RequestGuard(
      stub,
      { apiPerMinute: 1000, mcpPerMinute: 1000, authFailuresPerMinute: 2 },
      () => 0,
    );
    const attempts = Array.from({ length: 100 }, () =>
      guard.authenticate(request('alice'), 'gui').then(
        () => 'ok',
        (e: unknown) => (e instanceof AppError ? e.code : 'other'),
      ),
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(started, 2, 'only the allowance starts verifying');
    for (const resolve of pending) resolve();
    const results = await Promise.all(attempts);
    assert.deepEqual(
      [results.filter((r) => r === 'ok').length, results.filter((r) => r === 'rate_limited').length],
      [2, 98],
    );
    // Accepted tokens gave their reservation back: the next request verifies.
    const next = guard.authenticate(request('alice'), 'gui');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(started, 3);
    pending.at(-1)?.();
    await next;
  });

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
    // MCP answers are written by the SDK on the raw response: the headers are there too.
    core.users.touch(admin);
    const connection = core.connections.create(admin, pgInput).id;
    core.profiles.create(admin, { name: 'Claude', clientId: MCP_CLIENT, connectionIds: [connection] });
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${await issuer.mcp({ subject: 'dana', roles: ['query:read'] })}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      remoteAddress: '10.0.0.20',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      },
    });
    assert.equal(mcp.statusCode, 200);
    assert.match(String(mcp.headers['content-security-policy']), /frame-ancestors 'none'/);
    assert.equal(mcp.headers['strict-transport-security'], 'max-age=31536000');
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
