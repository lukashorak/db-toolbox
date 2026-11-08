/**
 * Accessibility review (step 14): axe-core with the WCAG 2.0/2.1 A and AA rules on every main
 * screen, with real data, and a narrow-screen check that no screen scrolls sideways.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import type { Actor } from '@workbench/core';
import { preparePostgres, targetFrom } from '../support/databases.js';
import { built, startGui, type GuiEnv, type Page } from '../support/gui.js';
import { skipUnless } from '../support/services.js';

const AXE = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

interface Violation {
  id: string;
  impact: string;
  help: string;
  nodes: { target: string[]; failureSummary: string }[];
}

describe(
  'GUI accessibility',
  {
    skip:
      skipUnless('KEYCLOAK_TEST_URL') ||
      skipUnless('POSTGRES_TEST_URL') ||
      (!built && 'run npm run build first'),
  },
  () => {
    let env: GuiEnv;
    let page: Page;
    let executionId: string;

    before(async () => {
      const url = String(process.env.POSTGRES_TEST_URL);
      await preparePostgres(url);
      env = await startGui('workbench-a11y-it', [
        { username: 'alice', roles: ['query:read', 'query:write', 'admin', 'monitor:read'] },
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
      const connection = env.core.connections.create(setup, {
        name: 'Fixture',
        engine: 'postgresql',
        environment: 'development',
        host: t.host,
        port: t.port,
        database: t.database,
        schema: 'public',
        username: t.username,
        password: t.password,
        monitorUsername: t.username,
        monitorPassword: t.password,
        tlsMode: 'verify-full',
        caPem: t.caPem,
        readOnly: false,
      }).id;
      env.core.profiles.create(setup, {
        name: 'Claude Code',
        clientId: 'workbench-mcp',
        connectionIds: [connection],
      });
      // axe is injected as a script, which the app's CSP rightly blocks; every other flow keeps it.
      page = await env.browser.newPage({ bypassCSP: true });
      await env.signIn(page, 'alice', '/workbench');
      await page.getByTestId('sql-editor').fill('SELECT n, n * 2 AS twice FROM wb_numbers ORDER BY n');
      await page
        .getByTestId('run-target')
        .getByText(/Run statement 1/)
        .waitFor();
      await page.getByTestId('run-target').click();
      await page.locator('[data-testid="results"][data-status="succeeded"]').waitFor({ timeout: 20_000 });
      executionId = String(await page.getByTestId('results').getAttribute('data-execution-id'));
    });
    after(async () => {
      await page?.close();
      await env?.close();
    });

    async function audit(): Promise<Violation[]> {
      await page.addScriptTag({ path: AXE });
      return page.evaluate(async () => {
        const axe = (
          globalThis as unknown as {
            axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Violation[] }> };
          }
        ).axe;
        // These callbacks run in the browser; the test's own types are Node's.
        const result = await axe.run((globalThis as unknown as { document: unknown }).document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        });
        return result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target, failureSummary: n.failureSummary })),
        }));
      });
    }
    const describeViolations = (violations: Violation[]) =>
      violations
        .map(
          (v) =>
            `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}`).join('\n')}`,
        )
        .join('\n');

    const SCREENS: [string, string, string][] = [
      ['Workbench with results', '/workbench', '[data-testid="results"]'],
      ['Executions', '/executions', '[data-testid="executions"]'],
      ['Execution detail', '', '[data-testid="execution-detail"]'],
      ['Connections', '/connections', 'tr[data-name="Fixture"]'],
      ['Explorer', '/explorer', '[role="tree"]'],
      ['Saved queries', '/queries', '[role="tree"]'],
      ['Monitoring', '/monitoring', '[data-testid="sample-time"]:not(:empty)'],
      ['MCP access', '/mcp-access', '[data-testid="mcp-url"]'],
      ['Settings', '/settings', '[data-testid="storage"]'],
    ];

    for (const [name, path, ready] of SCREENS) {
      it(`${name}: no WCAG 2.1 A or AA violations`, async () => {
        await page.goto(`${env.base}${path || `/executions/${executionId}`}`);
        await page.locator(ready).first().waitFor({ timeout: 15_000 });
        const violations = await audit();
        assert.equal(violations.length, 0, describeViolations(violations));
      });
    }

    it('side panels: the connection and profile forms have no violations', async () => {
      for (const [path, button] of [
        ['/connections', 'Add connection'],
        ['/mcp-access', 'Add profile'],
      ] as const) {
        await page.goto(`${env.base}${path}`);
        await page.getByRole('button', { name: button }).first().click();
        await page.getByRole('dialog').waitFor();
        const violations = await audit();
        assert.equal(violations.length, 0, `${path}: ${describeViolations(violations)}`);
      }
    });

    it('Workbench tabs work from the keyboard: arrows switch, Delete closes', async () => {
      await page.goto(`${env.base}/workbench`);
      const all = page.getByRole('tablist', { name: 'Query tabs' }).getByRole('tab');
      await all.first().waitFor();
      const before = await all.count();
      // The nth tab, optionally only once it is selected and has the keyboard focus.
      const tab = (n: number, state = '') =>
        page.locator(`[role="tablist"] > [role="tab"]:nth-child(${n})${state}`);
      await page.getByRole('button', { name: 'New tab' }).click();
      await tab(before + 1, '[aria-selected="true"]:focus').waitFor();
      await page.keyboard.press('ArrowLeft');
      await tab(before, '[aria-selected="true"]:focus').waitFor();
      await page.keyboard.press('ArrowRight');
      await tab(before + 1, '[aria-selected="true"]:focus').waitFor();
      await page.keyboard.press('Delete');
      await tab(before + 1).waitFor({ state: 'detached' });
      assert.equal(await all.count(), before);
    });

    it('the Explorer tree works from the keyboard: one tab stop, arrows move and expand, Enter selects', async () => {
      await page.goto(`${env.base}/explorer`);
      const rows = page.locator('[role="tree"] [role="treeitem"]');
      await rows.first().waitFor();
      // Nothing is selected yet, so the first row is the tree's tab stop.
      assert.equal(await rows.first().getAttribute('tabindex'), '0');
      await page.getByRole('treeitem', { name: /public/ }).focus();
      await page.keyboard.press('ArrowRight');
      await page.locator('[role="treeitem"][aria-level="2"]').first().waitFor();
      await page.keyboard.press('ArrowDown');
      await page.locator('[role="treeitem"][aria-level="2"]:focus').waitFor();
      await page.keyboard.press('Enter');
      await page.locator('[role="treeitem"][aria-level="2"][aria-selected="true"]:focus').waitFor();
      assert.equal(await page.locator('[role="tree"] [role="treeitem"][tabindex="0"]').count(), 1);
    });

    it('a lost session: the sign-in dialog has the focus, and the app behind it cannot be reached', async () => {
      await page.goto(`${env.base}/executions`);
      await page.getByTestId('executions').waitFor();
      // The Settings page's request is refused, as when the session is revoked (only that one, so
      // the page's own polling cannot end the session before the click).
      await page.route('**/api/v1/settings/storage', (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unauthenticated', message: 'Sign in again.' }),
        }),
      );
      try {
        await page.getByRole('link', { name: 'Settings' }).click();
        await page.getByRole('alertdialog', { name: 'Your session has ended' }).waitFor();
        await page.locator('[role="alertdialog"] button:focus', { hasText: 'Sign in again' }).waitFor();
        for (let i = 0; i < 4; i++) {
          await page.keyboard.press('Tab');
          const focused = await page.evaluate(() => {
            const doc = (globalThis as unknown as { document: { activeElement: unknown; body: unknown } })
              .document;
            const active = doc.activeElement as { closest(s: string): unknown; outerHTML: string } | null;
            return !active || active === doc.body || active.closest('[role="alertdialog"]')
              ? null
              : active.outerHTML.slice(0, 120);
          });
          assert.equal(focused, null, `Tab ${i + 1} left the dialog`);
        }
        const violations = await audit();
        assert.equal(violations.length, 0, describeViolations(violations));
      } finally {
        await page.unroute('**/api/v1/settings/storage');
      }
    });

    it('fits a 390 px wide screen without scrolling sideways', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      const wide: string[] = [];
      for (const [name, path, ready] of SCREENS) {
        await page.goto(`${env.base}${path || `/executions/${executionId}`}`);
        await page.locator(ready).first().waitFor({ timeout: 15_000 });
        const overflow = await page.evaluate(() => {
          const root = (
            globalThis as unknown as {
              document: { documentElement: { scrollWidth: number; clientWidth: number } };
            }
          ).document.documentElement;
          return root.scrollWidth - root.clientWidth;
        });
        if (overflow > 1) wide.push(`${name}: ${overflow} px too wide`);
      }
      assert.deepEqual(wide, []);
    });
  },
);
