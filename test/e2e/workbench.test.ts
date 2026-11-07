/**
 * Playwright flows for the Workbench, results and executions (step 11): preview to full result to
 * export with row counts from the downloaded files (AC3), partial commit versus single transaction
 * (AC6), and recovering a running execution after a reload and in a new browser (AC7).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';
import type { Actor } from '@workbench/core';
import { preparePostgres, targetFrom } from '../support/databases.js';
import { built, startGui, type GuiEnv, type Page } from '../support/gui.js';
import { skipUnless } from '../support/services.js';

describe(
  'GUI workbench',
  {
    skip:
      skipUnless('KEYCLOAK_TEST_URL') ||
      skipUnless('POSTGRES_TEST_URL') ||
      (!built && 'run npm run build first'),
  },
  () => {
    let env: GuiEnv;
    let page: Page;
    let apiRequests = 0;

    before(async () => {
      const url = String(process.env.POSTGRES_TEST_URL);
      await preparePostgres(url);
      env = await startGui('workbench-wb-it', [
        { username: 'alice', roles: ['query:read', 'query:write', 'admin'] },
      ]);
      const setup: Actor = {
        subject: 'setup',
        username: 'setup',
        displayName: 'Setup',
        roles: ['admin', 'query:read'],
        source: 'gui',
        clientId: 'workbench-gui',
      };
      env.core.users.touch(setup);
      const t = targetFrom(url, 'postgresql');
      env.core.connections.create(setup, {
        name: 'Fixture',
        engine: 'postgresql',
        environment: 'development',
        host: t.host,
        port: t.port,
        database: t.database,
        schema: 'public',
        username: t.username,
        password: t.password,
        tlsMode: 'verify-full',
        caPem: t.caPem,
        readOnly: false,
      });
      page = await env.browser.newPage();
      page.on('request', (r) => {
        if (r.url().includes('/api/v1/')) apiRequests++;
      });
      await env.signIn(page, 'alice', '/workbench');
    });
    after(async () => {
      await page?.close();
      await env?.close();
    });

    async function setSql(sql: string) {
      await page.getByTestId('sql-editor').fill(sql);
      // Wait for the statement check, so Run targets the right range.
      await page
        .getByTestId('run-target')
        .getByText(/Run statement 1/)
        .waitFor();
    }
    const results = () => page.getByTestId('results');
    const summary = async () =>
      String(await page.getByTestId('row-summary').textContent())
        .replace(/\s+/g, ' ')
        .trim();
    async function finished(status = 'succeeded') {
      await page.locator(`[data-testid="results"][data-status="${status}"]`).waitFor({ timeout: 20_000 });
    }

    it('previews 1,000 rows, runs the full result and exports it with every row (AC3)', async () => {
      await setSql('SELECT n FROM wb_numbers ORDER BY n');
      await page.getByTestId('run-target').click();
      await finished();
      assert.match(await summary(), /Showing 1,000 rows\. More rows are available/);
      assert.equal(
        await results().getByRole('button', { name: 'Export full result' }).getAttribute('disabled'),
        '',
      );

      await results().getByRole('button', { name: 'Run full result' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Run full result' }).click();
      await page.locator('[data-testid="results"] [data-value="complete"]').waitFor({ timeout: 20_000 });
      assert.match(await summary(), /^5,000 rows$/);

      for (const format of ['csv', 'json'] as const) {
        await results().getByRole('button', { name: 'Export full result' }).click();
        await page.getByRole('dialog').getByRole('combobox').selectOption(format);
        const [file] = await Promise.all([
          page.waitForEvent('download'),
          page.getByRole('dialog').getByRole('button', { name: 'Export and download' }).click(),
        ]);
        const text = await readFile(await file.path(), 'utf8');
        if (format === 'csv') {
          const lines = text.split('\r\n').filter(Boolean);
          assert.deepEqual([lines.length, lines[0], lines[5000]], [5001, 'n', '5000']);
        } else {
          const parsed = JSON.parse(text);
          assert.deepEqual(
            [parsed.completeness, parsed.exportedRows, parsed.rows.length],
            ['complete', 5000, 5000],
          );
        }
      }
    });

    it('stays within a request budget: live status, not polling loops', () => {
      // The three runs and two exports above need a few dozen requests. A refetch loop once sent
      // hundreds a second and ran into the per-user rate limit.
      assert.ok(apiRequests > 10 && apiRequests < 150, `${apiRequests} API requests`);
    });

    it('shows a partial commit per statement and a rollback in a single transaction (AC6)', async () => {
      const script =
        "INSERT INTO wb_items (name) VALUES ('gui-1');\nINSERT INTO wb_items (name) VALUES ('alpha');\nINSERT INTO wb_items (name) VALUES ('gui-3')";
      await setSql(script);
      await page.getByRole('button', { name: 'Run script' }).click();
      await finished('failed');
      await results().locator('[data-kind="transaction"][data-value="partial_commit"]').first().waitFor();
      await results()
        .getByRole('tab', { name: /2 · INSERT/ })
        .waitFor();

      await page.getByLabel('Transaction').selectOption('atomic');
      await page.getByTestId('sql-editor').fill(script.replaceAll('gui-', 'gui-atomic-'));
      await page.getByRole('button', { name: 'Run script' }).click();
      await page
        .locator(
          '[data-testid="results"][data-status="failed"] [data-kind="transaction"][data-value="rolled_back"]',
        )
        .first()
        .waitFor({ timeout: 20_000 });
      await page.getByLabel('Transaction').selectOption('per_statement');
    });

    it('recovers a running execution after a reload and in a new browser (AC7)', async () => {
      await setSql('SELECT pg_sleep(4), 42 AS answer');
      await page.getByTestId('run-target').click();
      await finished('running');
      await page.reload();
      await page
        .locator(
          '[data-testid="results"][data-status="running"], [data-testid="results"][data-status="succeeded"]',
        )
        .first()
        .waitFor();

      const other = await env.browser.newPage();
      try {
        await env.signIn(other, 'alice', '/executions');
        await other.getByRole('link', { name: 'Query 1' }).first().click();
        await other
          .locator('[data-testid="execution-detail"][data-status="succeeded"]')
          .waitFor({ timeout: 20_000 });
        assert.match(String(await other.getByTestId('sql-snapshot').textContent()), /pg_sleep\(4\)/);
        await other.getByRole('grid').getByText('42').waitFor();
      } finally {
        await other.close();
      }
    });
  },
);
