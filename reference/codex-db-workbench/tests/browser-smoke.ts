import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { httpFixture } from './http-fixture.js';

const f = await httpFixture();
let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
if (
  !executablePath &&
  !existsSync(chromium.executablePath()) &&
  process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
) {
  const require = createRequire(
    join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, '_resolve.cjs'),
  );
  const bundled = require('playwright').chromium.executablePath();
  if (existsSync(bundled)) executablePath = bundled;
}
let launchArgs: string[] =
  process.env.PLAYWRIGHT_PACKAGED_BROWSER === '1'
    ? [
        '--single-process',
        '--no-zygote',
        '--font-render-hinting=none',
        '--disable-webgl',
        '--in-process-gpu',
      ]
    : [];
if (!executablePath && !existsSync(chromium.executablePath())) {
  const packaged = (await import('@sparticuz/chromium')).default;
  executablePath = await packaged.executablePath();
  launchArgs = [
    '--single-process',
    '--no-zygote',
    '--font-render-hinting=none',
    '--disable-webgl',
    '--in-process-gpu',
  ];
}
const browser = await chromium.launch({
  headless: true,
  args: launchArgs,
  ...(executablePath ? { executablePath } : {}),
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  await context.addInitScript(
    ({ key, value }) => {
      if (location.protocol === 'http:' || location.protocol === 'https:')
        sessionStorage.setItem(key, value);
    },
    {
      key: `oidc.user:${f.config.issuer}:${f.config.guiClientId}`,
      value: JSON.stringify({
        access_token: f.guiToken,
        token_type: 'Bearer',
        profile: {
          sub: 'test-user',
          preferred_username: 'Lukas',
          iss: f.config.issuer,
          aud: f.config.guiClientId,
        },
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        scope: 'openid profile workbench:api',
      }),
    },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(f.url);
  await page.getByRole('textbox', { name: 'SQL editor' }).waitFor();
  await page
    .getByRole('textbox', { name: 'SQL editor' })
    .fill('SELECT id, label, exact FROM sample ORDER BY id');
  await page.getByRole('button', { name: 'Run preview', exact: false }).click();
  await page.locator('.result-summary').getByText('preview limited').waitFor();
  assert.equal(await page.locator('.result-grid tbody tr').count(), 1000);
  assert.equal(await page.getByRole('button', { name: '↓ CSV', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Run full result', exact: true }).click();
  await page.locator('.result-summary').getByText('complete', { exact: true }).waitFor();
  assert.equal(await page.locator('.result-grid tbody tr').count(), 1000);
  assert.match(await page.locator('.result-summary').innerText(), /1,200/);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '↓ JSON', exact: true }).click();
  const download = await downloadEvent;
  assert.equal(JSON.parse(await readFile((await download.path())!, 'utf8')).rows.length, 1200);
  assert.equal(f.store.approvals('test-user').length, 0);
  await page.getByRole('button', { name: 'Share full result with MCP' }).click();
  await page.getByRole('button', { name: 'Allow for 1 hour' }).click();
  await page.getByRole('status').filter({ hasText: 'approved for one hour' }).waitFor();
  assert.equal(f.store.approvals('test-user').length, 1);
  const directory = resolve(process.env.BROWSER_ARTIFACT_DIR ?? 'test-results');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: join(directory, 'workbench-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Save query', exact: true }).click();
  await page.getByLabel('Query name', { exact: true }).fill('Sample report');
  await page.getByLabel('Folder', { exact: true }).fill('Analytics/Daily');
  await page.getByRole('dialog').getByRole('button', { name: 'Save query', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Query saved' }).waitFor();
  assert.equal(f.store.records('query', 'test-user').length, 1);
  await page.getByRole('button', { name: 'Execution history', exact: false }).click();
  await page.getByRole('heading', { name: 'Execution history', exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(directory, 'workbench-mobile.png'), fullPage: true });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false, 'Mobile page should not overflow horizontally');
  assert.deepEqual(errors, []);
  console.log(
    'Browser smoke passed: preview, full capture, 1200-row JSON download, separate approval, saved query, history, responsive layout.',
  );
} finally {
  await browser.close();
  await f.close();
}
