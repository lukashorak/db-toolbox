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
    let submissions = 0;

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
      // A second connection, to switch to after a preview (sorts after Fixture).
      env.core.connections.create(setup, {
        name: 'Zeta copy',
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
        if (r.method() === 'POST' && /\/api\/v1\/executions$/.test(r.url())) submissions++;
      });
      await env.signIn(page, 'alice', '/workbench');
    });
    after(async () => {
      await page?.close();
      await env?.close();
    });

    async function setSql(sql: string) {
      await page.getByTestId('sql-editor').fill(sql);
      // Wait for the statement check of this text, so Run targets the right range. Ranges of an
      // earlier text are never shown, so any statement label here belongs to this text.
      await page
        .getByTestId('run-target')
        .getByText(/Run statement \d+/)
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

    it('submits once when Run is pressed again before the first answer', async () => {
      await setSql("INSERT INTO wb_items (name) VALUES ('gui-once')");
      // Hold the submission's answer, so the later presses land while the first is on its way.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const isSubmit = (r: { method(): string; url(): string }) =>
        r.method() === 'POST' && /\/api\/v1\/executions$/.test(r.url());
      await page.route('**/api/v1/executions', async (route) => {
        if (isSubmit(route.request())) await held;
        await route.continue();
      });
      const answered = page.waitForResponse((r) => isSubmit(r.request()));
      const before = submissions;
      await page.getByTestId('sql-editor').click();
      await page.keyboard.press('Control+Shift+Enter');
      await page.keyboard.press('Control+Shift+Enter');
      await page.getByRole('button', { name: 'Run script' }).click({ force: true });
      release();
      await answered;
      await page.unroute('**/api/v1/executions');
      await finished('succeeded');
      assert.equal(submissions - before, 1, 'one submission');
    });

    it('keeps a run with the tab it was started in when the tab changes before the answer', async () => {
      await setSql("INSERT INTO wb_items (name) VALUES ('gui-origin-tab')");
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const isSubmit = (r: { method(): string; url(): string }) =>
        r.method() === 'POST' && /\/api\/v1\/executions$/.test(r.url());
      await page.route('**/api/v1/executions', async (route) => {
        if (isSubmit(route.request())) await held;
        await route.continue();
      });
      const answered = page.waitForResponse((r) => isSubmit(r.request()));
      await page.getByRole('button', { name: 'Run script' }).click();
      // Another tab, while the submission is on its way.
      await page.getByRole('button', { name: 'New tab' }).click();
      release();
      const { id } = (await (await answered).json()) as { id: string };
      await page.unroute('**/api/v1/executions');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await results().count(), 0, 'the new tab shows no run');
      await page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab').first().click();
      await page.locator(`[data-testid="results"][data-execution-id="${id}"]`).waitFor();
      await finished('succeeded');
    });

    it('does not mark a rejection on text edited while it was being submitted', async () => {
      await setSql('BEGIN;\nSELECT 1');
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const isSubmit = (r: { method(): string; url(): string }) =>
        r.method() === 'POST' && /\/api\/v1\/executions$/.test(r.url());
      await page.route('**/api/v1/executions', async (route) => {
        if (isSubmit(route.request())) await held;
        await route.continue();
      });
      const answered = page.waitForResponse((r) => isSubmit(r.request()));
      await page.getByRole('button', { name: 'Run script' }).click();
      // The person edits the text before the (rejecting) answer arrives.
      await page.getByTestId('sql-editor').fill('SELECT 2 AS edited');
      release();
      await answered;
      await page.unroute('**/api/v1/executions');
      await page
        .getByRole('status')
        .getByText(/transaction/i)
        .first()
        .waitFor();
      assert.equal(await page.getByText('Not run.').count(), 0, 'no rejection marks on the new text');
    });

    it('runs the full result on the connection of the result shown, not the one selected since', async () => {
      await page.getByLabel('Connection').selectOption({ label: 'Fixture' });
      await setSql('SELECT n FROM wb_numbers ORDER BY n');
      await page.getByTestId('run-target').click();
      await finished();
      const preview = await results().getAttribute('data-execution-id');
      await page.getByLabel('Connection').selectOption({ label: 'Zeta copy' });
      await results().getByRole('button', { name: 'Run full result' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Run full result' }).click();
      await page.locator(`[data-testid="results"]:not([data-execution-id="${preview}"])`).waitFor();
      await finished();
      assert.match(String(await results().locator('.meta').textContent()), /^Fixture · Full result/);
      await page.getByLabel('Connection').selectOption({ label: 'Fixture' });
    });

    it('never runs a statement range of an earlier text', async () => {
      // A long first text: its statement range would cover both statements of the shorter next one.
      await setSql('SELECT 1 AS a_first_text_that_is_longer_than_the_next_one');
      const shown = async () =>
        (await results().count()) ? await results().getAttribute('data-execution-id') : null;
      const before = await shown();
      // Run the statement at once, before the new text has been checked.
      await page.getByTestId('sql-editor').fill('SELECT 2 AS one;\nSELECT 3 AS two');
      await page.keyboard.press('Control+Enter');
      await page.getByText('The statement at the cursor is still being checked').waitFor({ timeout: 5000 });
      assert.equal(await shown(), before, 'nothing was submitted');
      await page
        .getByTestId('run-target')
        .getByText(/Run statement 2/)
        .waitFor();
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
