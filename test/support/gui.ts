/** Shared setup for Playwright GUI tests: a Keycloak realm, the built app and a browser. */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  Authenticator,
  buildRealm,
  createCore,
  createLogger,
  loadConfig,
  TokenVerifier,
  type Core,
} from '@workbench/core';
import { buildServer, WEB_DIST, type WorkbenchServer } from '@workbench/api';
import { freePort, KEYCLOAK_URL, KeycloakAdmin } from './keycloak.js';

// Minimal Playwright surface used by the tests; the package resolves at run time.
type RequestInfo = { url(): string; method(): string };
export type Locator = {
  waitFor(options?: object): Promise<void>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  fill(v: string): Promise<void>;
  click(options?: { force?: boolean }): Promise<void>;
  focus(): Promise<void>;
  selectOption(v: string | { label: string }): Promise<unknown>;
  check(): Promise<void>;
  count(): Promise<number>;
  getAttribute(name: string): Promise<string | null>;
  first(): Locator;
  nth(i: number): Locator;
  locator(selector: string): Locator;
  getByRole(role: string, options?: object): Locator;
  getByText(text: string | RegExp, options?: object): Locator;
  getByLabel(text: string | RegExp, options?: object): Locator;
};
export type Page = Locator & {
  goto(url: string): Promise<unknown>;
  waitForURL(pattern: RegExp | string, options?: object): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  reload(): Promise<unknown>;
  getByTestId(id: string): Locator;
  waitForEvent(event: 'download'): Promise<{ path(): Promise<string>; suggestedFilename(): string }>;
  keyboard: { press(key: string): Promise<void> };
  on(event: 'request', listener: (request: RequestInfo) => void): void;
  route(
    url: string,
    handler: (route: { request(): RequestInfo; continue(): Promise<void> }) => unknown,
  ): Promise<void>;
  unroute(url: string): Promise<void>;
  waitForResponse(
    predicate: (response: { request(): RequestInfo }) => boolean,
  ): Promise<{ json(): Promise<unknown> }>;
  addScriptTag(options: { path: string }): Promise<unknown>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  close(): Promise<void>;
};
export type Browser = { newPage(options?: { bypassCSP?: boolean }): Promise<Page>; close(): Promise<void> };

export const built = existsSync(`${WEB_DIST}/index.html`);

export interface GuiEnv {
  base: string;
  issuer: string;
  password: string;
  core: Core;
  browser: Browser;
  signIn(page: Page, username: string, path?: string): Promise<void>;
  close(): Promise<void>;
}

export async function startGui(
  realm: string,
  users: { username: string; roles: string[] }[],
): Promise<GuiEnv> {
  const keycloak = new KeycloakAdmin(String(KEYCLOAK_URL));
  const issuer = `${KEYCLOAK_URL}/realms/${realm}`;
  const password = randomUUID();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  await keycloak.importRealm(
    buildRealm({
      publicUrl: base,
      realm,
      testing: { users: users.map((u) => ({ ...u, password, roles: u.roles as never })) },
    }),
  );
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_URL: base,
    KEYCLOAK_ISSUER: issuer,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });
  const exportDir = await mkdtemp(join(tmpdir(), 'workbench-gui-exports-'));
  const core = createCore({
    databaseFile: ':memory:',
    encryptionKey: config.encryptionKey,
    limits: config.limits,
    exportDir,
  });
  const verifier = new TokenVerifier({
    issuer,
    guiClientId: config.guiClientId,
    apiAudience: config.apiAudience,
    mcpAudience: config.mcpAudience,
  });
  const app: WorkbenchServer = await buildServer(config, {
    logger: createLogger({ level: 'silent' }),
    core,
    authenticator: new Authenticator(verifier, { users: core.users, profiles: core.profiles }),
  });
  await app.listen({ host: '127.0.0.1', port });
  const { chromium } = createRequire(import.meta.url)('playwright') as {
    chromium: { launch(): Promise<Browser> };
  };
  const browser = await chromium.launch();
  return {
    base,
    issuer,
    password,
    core,
    browser,
    async signIn(page, username, path = '/workbench') {
      await page.goto(`${base}${path}`);
      await page.waitForURL(new RegExp(`/realms/${realm}/protocol/openid-connect/auth`));
      await page.fill('#username', username);
      await page.fill('#password', password);
      await page.click('#kc-login');
      await page.waitForURL(`${base}${path}`);
    },
    async close() {
      await browser.close();
      await app.close();
      await core.shutdown();
      await rm(exportDir, { recursive: true, force: true });
      await keycloak.deleteRealm(realm);
    },
  };
}
