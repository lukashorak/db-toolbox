/**
 * GUI smoke test with Playwright against a real Keycloak realm and the built web app: sign-in
 * through Keycloak's login page, navigation, drafts restored after a reload, the jobs indicator
 * updating over server-sent events, and the access-denied page.
 *
 *   npm run build && scripts/integration/start.sh keycloak
 *   KEYCLOAK_TEST_URL=http://127.0.0.1:18080 npm run test:e2e
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import {
  Authenticator,
  buildRealm,
  createCore,
  createLogger,
  loadConfig,
  TokenVerifier,
  type Actor,
  type Core,
} from '@workbench/core';
import { buildServer, WEB_DIST, type WorkbenchServer } from '@workbench/api';
import { freePort, KEYCLOAK_URL, KeycloakAdmin, passwordGrant } from '../support/keycloak.js';
import { skipUnless } from '../support/services.js';

type Browser = { newPage(): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  waitForURL(pattern: RegExp | string, options?: object): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  reload(): Promise<unknown>;
  getByRole(role: string, options?: object): { first(): Locator } & Locator;
  getByTestId(id: string): Locator;
  locator(selector: string): Locator;
  close(): Promise<void>;
};
type Locator = {
  waitFor(options?: object): Promise<void>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  fill(v: string): Promise<void>;
  click(): Promise<void>;
};

const REALM = 'workbench-gui-it';
const password = randomUUID();
const built = existsSync(`${WEB_DIST}/index.html`);

describe(
  'GUI smoke',
  { skip: skipUnless('KEYCLOAK_TEST_URL') || (!built && 'run npm run build first') },
  () => {
    const keycloak = new KeycloakAdmin(String(KEYCLOAK_URL));
    const issuer = `${KEYCLOAK_URL}/realms/${REALM}`;
    let core: Core;
    let app: WorkbenchServer;
    let base: string;
    let browser: Browser;
    let connectionId: string;

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
              { username: 'carol', password, roles: [] },
            ],
          },
        }),
      );
      const config = loadConfig({
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
      });
      await app.listen({ host: '127.0.0.1', port });
      const setup: Actor = {
        subject: 'setup',
        username: 'setup',
        displayName: 'Setup',
        roles: ['admin', 'query:read'],
        source: 'gui',
        clientId: 'workbench-gui',
      };
      core.users.touch(setup);
      // Unreachable on purpose: the execution fails fast, which is enough to watch live status change.
      connectionId = core.connections.create(setup, {
        name: 'Unreachable',
        engine: 'postgresql',
        environment: 'development',
        host: '127.0.0.1',
        port: 1,
        database: 'app',
        username: 'wb',
        password: 'not-a-real-password',
        tlsMode: 'disable',
        readOnly: true,
      }).id;
      const { chromium } = createRequire(import.meta.url)('playwright') as {
        chromium: { launch(): Promise<Browser> };
      };
      browser = await chromium.launch();
    });
    after(async () => {
      await browser?.close();
      await app?.close();
      await core?.shutdown();
      await keycloak.deleteRealm(REALM);
    });

    async function signIn(page: Page, username: string) {
      await page.goto(`${base}/workbench`);
      await page.waitForURL(/\/realms\/workbench-gui-it\/protocol\/openid-connect\/auth/);
      await page.fill('#username', username);
      await page.fill('#password', password);
      await page.click('#kc-login');
    }

    it('signs in through Keycloak, navigates, keeps drafts and follows jobs live', async () => {
      const page = await browser.newPage();
      await signIn(page, 'alice');
      await page.waitForURL(`${base}/workbench`);
      await page.getByRole('heading', { name: 'Workbench' }).waitFor();
      assert.ok((await page.locator('header').textContent())?.includes('alice'));

      await page.getByTestId('sql-editor').fill('SELECT 42 -- draft');
      await page.reload();
      await page.getByTestId('sql-editor').waitFor();
      assert.equal(
        await page.getByTestId('sql-editor').textContent(),
        'SELECT 42 -- draft',
        'the draft survives a reload',
      );

      await page.getByRole('link', { name: 'Executions' }).click();
      await page.waitForURL(`${base}/executions`);
      await page.getByRole('heading', { name: 'Executions' }).waitFor();

      const token = (await passwordGrant(issuer, 'workbench-gui', 'alice', password)).body.access_token;
      const response = await fetch(`${base}/api/v1/executions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId, sql: 'SELECT 1', title: 'Live status check' }),
      });
      assert.equal(response.status, 201);
      const { id } = (await response.json()) as { id: string };
      // The row appears and reaches its final status without a reload.
      await page.locator(`tr[data-id="${id}"] [data-value="failed"]`).waitFor({ timeout: 15_000 });
      assert.equal(await page.getByTestId('jobs-running').textContent(), '0');
      await page.close();
    });

    it('shows access denied to a user without a workbench role', async () => {
      const page = await browser.newPage();
      await signIn(page, 'carol');
      await page
        .getByRole('heading', { name: 'No access to Database Workbench' })
        .waitFor({ timeout: 15_000 });
      await page.close();
    });
  },
);
