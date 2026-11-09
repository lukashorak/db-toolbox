import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  Authenticator,
  createCore,
  createLogger,
  loadConfig,
  TokenVerifier,
  type Config,
} from '@workbench/core';
import { buildServer as build, type ServerOptions } from '../src/index.js';

const root = await mkdtemp(join(tmpdir(), 'workbench-api-'));
after(() => rm(root, { recursive: true, force: true }));

const config = (dirs: { data: string; exports: string }) =>
  loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL: 'https://db.example.test',
    KEYCLOAK_ISSUER: 'https://auth.example.test/realms/workbench',
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    DATA_DIR: dirs.data,
    EXPORT_DIR: dirs.exports,
  });
const logger = createLogger({ level: 'silent' });

/** Builds a server with an in-memory core; these tests never present a token. */
async function buildServer(cfg: Config, options: Pick<ServerOptions, 'webDist'> & { logger: typeof logger }) {
  const core = createCore({ databaseFile: ':memory:', encryptionKey: cfg.encryptionKey, limits: cfg.limits });
  const verifier = new TokenVerifier({
    issuer: cfg.keycloakIssuer,
    guiClientId: cfg.guiClientId,
    apiAudience: cfg.apiAudience,
    mcpAudience: cfg.mcpAudience,
  });
  const authenticator = new Authenticator(verifier, { users: core.users, profiles: core.profiles });
  const app = await build(cfg, { ...options, core, authenticator });
  app.addHook('onClose', async () => core.close());
  return app;
}

describe('health endpoints', () => {
  it('answers liveness without touching storage', async () => {
    const app = await buildServer(config({ data: join(root, 'none'), exports: join(root, 'none') }), {
      logger,
      webDist: false,
    });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    await app.close();
  });

  it('reports ready only when the database and exports are writable', async () => {
    const data = join(root, 'data');
    const exports = join(root, 'exports');
    await mkdir(data);
    await mkdir(exports);
    const app = await buildServer(config({ data, exports }), { logger, webDist: false });
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().status, 'ready');
    await app.close();

    const broken = await buildServer(config({ data, exports: join(root, 'missing') }), {
      logger,
      webDist: false,
    });
    const notReady = await broken.inject({ method: 'GET', url: '/readyz' });
    assert.equal(notReady.statusCode, 503);
    assert.deepEqual(notReady.json().checks.exports, { ok: false, detail: 'not writable (ENOENT)' });
    await broken.close();
  });
});

describe('web app serving', () => {
  it('serves the built app and falls back to index.html for browser routes', async () => {
    const web = join(root, 'web');
    await mkdir(web);
    await writeFile(join(web, 'index.html'), '<!doctype html><title>Database Workbench</title>');
    const app = await buildServer(config({ data: root, exports: root }), { logger, webDist: web });
    const page = await app.inject({ method: 'GET', url: '/workbench', headers: { accept: 'text/html' } });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Database Workbench/);
    const api = await app.inject({
      method: 'GET',
      url: '/api/unknown',
      headers: { accept: 'application/json' },
    });
    assert.equal(api.statusCode, 404);
    assert.equal(api.json().error, 'not_found');
    // API paths never fall back to the app, even for a browser.
    const apiFromBrowser = await app.inject({
      method: 'GET',
      url: '/api/v1/unknown',
      headers: { accept: 'text/html' },
    });
    assert.equal(apiFromBrowser.statusCode, 404);
    assert.equal(apiFromBrowser.json().error, 'not_found');
    await app.close();
  });
});
