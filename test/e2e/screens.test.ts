/**
 * Playwright flows for connections, the explorer and saved queries (step 10) against Keycloak and
 * the PostgreSQL fixture.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { certs, preparePostgres, READER, targetFrom } from '../support/databases.js';
import { built, startGui, type GuiEnv, type Page } from '../support/gui.js';
import { skipUnless } from '../support/services.js';

describe(
  'GUI screens',
  {
    skip:
      skipUnless('KEYCLOAK_TEST_URL') ||
      skipUnless('POSTGRES_TEST_URL') ||
      (!built && 'run npm run build first'),
  },
  () => {
    let env: GuiEnv;
    let page: Page;
    const t = () => targetFrom(String(process.env.POSTGRES_TEST_URL), 'postgresql');

    before(async () => {
      await preparePostgres(String(process.env.POSTGRES_TEST_URL));
      env = await startGui('workbench-screens-it', [
        { username: 'alice', roles: ['query:read', 'query:write', 'admin'] },
      ]);
      page = await env.browser.newPage();
      await env.signIn(page, 'alice', '/connections');
    });
    after(async () => {
      await page?.close();
      await env?.close();
    });

    /** Closes side panels left open by the previous action (the detail panel reopens after each one). */
    async function closeDialogs() {
      while ((await page.getByRole('dialog').count()) > 0) {
        await page.getByRole('dialog').first().getByRole('button', { name: 'Close' }).click();
      }
    }

    async function addConnection(name: string, username: string, password: string) {
      await closeDialogs();
      await page.getByRole('button', { name: 'Add connection' }).first().click();
      const panel = page.getByRole('dialog');
      await panel.getByLabel('Name', { exact: true }).fill(name);
      await panel.getByLabel('Host', { exact: true }).fill(t().host);
      await panel.getByLabel('Port', { exact: true }).fill(String(t().port));
      await panel.getByLabel('Database', { exact: true }).fill(t().database);
      await panel.getByLabel('User', { exact: true }).first().fill(username);
      await panel.getByLabel('Password', { exact: true }).first().fill(password);
      await panel.getByLabel(/Custom CA/).fill(certs().ca);
      return panel;
    }

    it('connection lifecycle: test before saving, save, edit, disable, delete with references', async () => {
      const panel = await addConnection('Fixture', t().username, t().password);
      await panel.getByRole('button', { name: 'Test connection' }).click();
      await page.locator('[data-testid="test-report"][data-ok="true"]').waitFor();
      assert.match(String(await page.getByTestId('test-report').textContent()), /Connected to PostgreSQL 16/);
      await panel.getByRole('button', { name: 'Add connection' }).click();
      await page.locator('tr[data-name="Fixture"]').waitFor();

      // Edit: a blank password keeps the stored one.
      await page.getByRole('dialog').getByRole('button', { name: 'Edit' }).click();
      await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Fixture DB');
      await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
      await page.locator('tr[data-name="Fixture DB"]').waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Test' }).click();
      await page.getByText('Fixture DB: connected').waitFor();

      await page.getByRole('dialog').getByRole('button', { name: 'Disable' }).click();
      await page.getByText('New executions on this connection are refused').waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Disable', exact: true }).click();
      await page.locator('tr[data-name="Fixture DB"]').getByText('Disabled').waitFor();
      await addConnection('Throwaway', t().username, t().password);
      await page.getByRole('dialog').getByRole('button', { name: 'Add connection' }).click();
      await page.locator('tr[data-name="Throwaway"]').waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
      await page.getByText('saved queries lose their default connection').waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete connection' }).click();
      await page.getByText('Throwaway deleted').waitFor();
      assert.equal(await page.locator('tr[data-name="Throwaway"]').count(), 0);
      // Leave the fixture enabled for the explorer.
      await closeDialogs();
      await page.locator('tr[data-name="Fixture DB"]').getByRole('button').click();
      await page.getByRole('dialog').getByRole('button', { name: 'Enable' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Enable', exact: true }).click();
      await page.locator('tr[data-name="Fixture DB"]').getByText('Reachable').waitFor();
    });

    it('explorer: object details, Open SELECT, preview data and permission states', async () => {
      const panel = await addConnection('Reader', READER.username, READER.password);
      await panel.getByRole('button', { name: 'Add connection' }).click();
      await page.locator('tr[data-name="Reader"]').waitFor();

      await closeDialogs();
      await page.getByRole('link', { name: 'Explorer' }).click();
      await page.getByLabel('Connection').selectOption({ label: 'Fixture DB' });
      await page.getByRole('treeitem', { name: /public/ }).click();
      await page
        .getByRole('treeitem', { name: /wb_items/ })
        .first()
        .click();
      await page.getByTestId('columns').getByText('price').waitFor();
      await page.getByRole('tab', { name: 'keys' }).click();
      await page
        .getByText(/foreign|primary/)
        .first()
        .waitFor();
      await page.getByRole('button', { name: 'Preview data' }).click();
      await page.getByRole('grid').getByText('alpha').waitFor({ timeout: 15_000 });

      await page.getByRole('button', { name: 'Open SELECT' }).click();
      await page.waitForURL(/\/workbench$/);
      assert.match(await page.getByTestId('sql-draft').inputValue(), /FROM public\.wb_items/);

      await page.getByRole('link', { name: 'Explorer' }).click();
      await page.getByLabel('Connection').selectOption({ label: 'Reader' });
      await page.getByRole('treeitem', { name: /restricted/ }).click();
      assert.match(String(await page.getByTestId('schema-state').textContent()), /Insufficient permission/);
    });

    it('saved queries: folders, conflicts, rename, duplicate, move and delete', async () => {
      await closeDialogs();
      await page.getByRole('link', { name: 'Saved queries' }).click();
      await page.getByRole('button', { name: 'New folder' }).click();
      await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Reports');
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      await page.getByRole('treeitem', { name: 'Reports' }).click();
      for (const name of ['Daily', 'Weekly']) {
        await page.getByRole('button', { name: 'New query' }).click();
        await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill(name);
        await page.getByRole('dialog').getByLabel('SQL', { exact: true }).fill(`SELECT '${name}'`);
        await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
        await page.locator(`tr[data-name="${name}"]`).waitFor();
      }
      await page.locator('tr[data-name="Weekly"]').getByRole('button', { name: 'Rename' }).click();
      await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Daily');
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      await page
        .getByRole('alert')
        .getByText(/already|Another/)
        .waitFor();
      await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Weekly totals');
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      await page.locator('tr[data-name="Weekly totals"]').waitFor();
      await page.locator('tr[data-name="Daily"]').getByRole('button', { name: 'Duplicate' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      await page.locator('tr[data-name="Daily (copy)"]').waitFor();
      await page.locator('tr[data-name="Daily (copy)"]').getByRole('button', { name: 'Move' }).click();
      await page.getByRole('dialog').getByRole('combobox').selectOption({ label: 'All queries (top level)' });
      await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
      await page.getByRole('button', { name: 'Delete folder' }).click();
      await page.getByRole('dialog').getByLabel('Delete contents').check();
      await page.getByText(/Its queries and 0 subfolder\(s\) are deleted/).waitFor();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByText(/Folder deleted · 2 queries deleted/).waitFor();
      await page.getByRole('treeitem', { name: 'All queries' }).click();
      await page.locator('tr[data-name="Daily (copy)"]').waitFor();
      // Opening a saved query puts it in a Workbench tab.
      await page
        .locator('tr[data-name="Daily (copy)"]')
        .getByRole('button', { name: 'Daily (copy)' })
        .click();
      await page.waitForURL(/\/workbench$/);
      assert.equal(await page.getByTestId('sql-draft').inputValue(), "SELECT 'Daily'");
    });
  },
);
