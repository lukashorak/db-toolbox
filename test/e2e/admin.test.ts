/**
 * Playwright flows for MCP access, settings and monitoring (step 12): an MCP client (the official
 * SDK with a Keycloak token for the MCP client) asks for more rows than its allowance and the user
 * approves, sees it used and revokes it in the GUI (AC5); administrators change defaults and read
 * the audit trail; an outside lock wait shows in Blocking and missing statement statistics are
 * explained (AC12).
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Actor } from '@workbench/core';
import { preparePostgres, targetFrom } from '../support/databases.js';
import { built, startGui, type GuiEnv, type Page } from '../support/gui.js';
import { passwordGrant } from '../support/keycloak.js';
import { skipUnless } from '../support/services.js';

type Json = ReturnType<typeof JSON.parse>;

describe(
  'GUI MCP access, settings and monitoring',
  {
    skip:
      skipUnless('KEYCLOAK_TEST_URL') ||
      skipUnless('POSTGRES_TEST_URL') ||
      (!built && 'run npm run build first'),
  },
  () => {
    const url = String(process.env.POSTGRES_TEST_URL);
    const t = () => targetFrom(url, 'postgresql');
    let env: GuiEnv;
    let page: Page;
    let connectionId: string;
    let mcp: Client;

    before(async () => {
      await preparePostgres(url);
      env = await startGui('workbench-admin-it', [
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
      connectionId = env.core.connections.create(setup, {
        name: 'Fixture',
        engine: 'postgresql',
        environment: 'development',
        host: t().host,
        port: t().port,
        database: t().database,
        schema: 'public',
        username: t().username,
        password: t().password,
        monitorUsername: t().username,
        monitorPassword: t().password,
        tlsMode: 'verify-full',
        caPem: t().caPem,
        readOnly: false,
      }).id;
      page = await env.browser.newPage();
      await env.signIn(page, 'alice', '/mcp-access');
    });
    after(async () => {
      await mcp?.close();
      await page?.close();
      await env?.close();
    });

    async function call(name: string, args: Record<string, unknown>) {
      const result = await mcp.callTool({ name, arguments: args });
      const text = (result.content as { text?: string }[])[0]?.text ?? '';
      return { error: Boolean(result.isError), data: (result.structuredContent ?? { text }) as Json };
    }

    it('MCP access: add a profile, then approve, use and revoke a disclosure request (AC5)', async () => {
      assert.equal(await page.getByTestId('mcp-url').textContent(), `${env.base}/mcp`);
      assert.match(
        String(await page.getByText(/claude mcp add --transport http/).textContent()),
        /--client-id workbench-mcp .* workbench http:\/\/127\.0\.0\.1:\d+\/mcp/,
      );

      await page.getByRole('button', { name: 'Add profile' }).click();
      const panel = page.getByRole('dialog');
      await panel.getByLabel('Name', { exact: true }).fill('Claude Code');
      assert.equal(await panel.getByLabel('OAuth client ID').inputValue(), 'workbench-mcp');
      await panel.getByLabel('Fixture').check();
      await panel.getByRole('button', { name: 'Save' }).click();
      await page.getByRole('cell', { name: 'Fixture' }).waitFor();
      assert.match(String(await page.getByRole('cell', { name: /Read-only/ }).textContent()), /profile/);

      // Claude Code would sign in through the browser; the testing realm allows a password grant.
      const token = await passwordGrant(env.issuer, 'workbench-mcp', 'alice', env.password);
      assert.equal(token.status, 200);
      mcp = new Client({ name: 'e2e', version: '1.0.0' });
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(`${env.base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token.body.access_token}` } },
        }),
      );
      const run = await call('execute_sql', {
        connectionId,
        sql: 'SELECT n, md5(n::text) AS label FROM generate_series(1, 1200) AS n',
        requestKey: 'e2e-approval-0001',
        transactionMode: 'per_statement',
        captureMode: 'full',
      });
      assert.equal(run.error, false, JSON.stringify(run.data));
      const executionId = run.data.executionId;
      for (const offset of [0, 500]) {
        assert.equal((await call('get_result', { executionId, offset, limit: 500 })).data.returned, 500);
      }
      const refused = await call('get_result', { executionId, offset: 1000, limit: 500 });
      assert.deepEqual([refused.error, refused.data.code], [true, 'approval_required']);

      // The request arrives live: the badge and the inbox update without a reload.
      await page.getByLabel('1 pending').waitFor();
      const request = page.getByTestId('pending-approval');
      assert.match(String(await request.textContent()), /Claude Code asks for 200 rows/);
      await request.getByRole('button', { name: 'Review' }).click();
      const review = page.getByRole('dialog');
      await review.getByText('It grants no other access').waitFor();
      await review.getByLabel('Expires after (minutes)').fill('30');
      await review.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.getByText('Approved. The MCP client can read the rows').waitFor();
      await page.getByTestId('active-approval').getByText('0 of 200 rows used').waitFor();

      const rest = await call('get_result', { executionId, offset: 1000, limit: 500 });
      assert.deepEqual([rest.error, rest.data.returned, rest.data.rows.at(-1)[0]], [false, 200, '1200']);
      await page.getByTestId('active-approval').getByText('200 of 200 rows used').waitFor();

      await page.getByTestId('active-approval').getByRole('button', { name: 'Revoke' }).click();
      await page.getByText('Approval revoked').waitFor();
      const revoked = await call('get_result', { executionId, offset: 1100, limit: 10 });
      assert.deepEqual([revoked.error, revoked.data.code], [true, 'approval_required']);
      // The revocation leaves a new pending request for the owner to decide.
      await page.getByTestId('pending-approval').waitFor();
      await page.getByTestId('pending-approval').getByRole('button', { name: 'Deny' }).click();
      await page.getByText('Request denied.').waitFor();
      await page.getByText('No pending requests.').waitFor();

      // The MCP execution is listed on the screen and in Executions.
      await page.getByRole('link', { name: /SELECT n, md5/ }).waitFor();
    });

    it('settings: identity, execution defaults, storage and the audit trail', async () => {
      await page.getByRole('link', { name: 'Settings', exact: true }).click();
      await page.getByText(/^(?=.*query:write)(?=.*monitor:read).*admin/).waitFor();
      await page.getByLabel('Monitoring refresh (seconds)').fill('5');
      await page.getByRole('button', { name: 'Save defaults' }).click();
      await page.getByText('Execution defaults saved.').waitFor();
      assert.equal(env.core.settings.defaults().monitoringRefreshSeconds, 5);
      assert.match(String(await page.getByTestId('storage').textContent()), /MiB of [\d.]+ MiB used/);

      await page.getByLabel('Action starts with').fill('disclosure.');
      await page.getByRole('button', { name: 'Filter' }).click();
      const audit = page.getByTestId('audit');
      await audit.getByRole('cell', { name: 'disclosure.revoke' }).waitFor();
      for (const action of ['disclosure.request', 'disclosure.approve', 'disclosure.deny']) {
        assert.ok((await audit.getByRole('cell', { name: action, exact: true }).count()) > 0, action);
      }
      assert.ok((await audit.getByRole('cell', { name: /settings\./ }).count()) === 0, 'filtered');
    });

    it('monitoring: an outside lock wait shows in Blocking; missing statement statistics are explained (AC12)', async () => {
      const raw = async () => {
        const c = new pg.Client({
          host: t().host,
          port: t().port,
          user: t().username,
          password: t().password,
          database: t().database,
          ssl: { rejectUnauthorized: false },
        });
        await c.connect();
        return c;
      };
      const holder = await raw();
      const waiter = await raw();
      try {
        await holder.query('BEGIN');
        await holder.query("UPDATE wb_items SET price = 5 WHERE name = 'alpha'");
        const blocked = waiter
          .query("UPDATE wb_items SET price = 6 WHERE name = 'alpha'")
          .catch(() => undefined);

        await page.getByRole('link', { name: 'Monitoring' }).click();
        await page
          .getByTestId('sample-time')
          .getByText(/account postgres/)
          .waitFor({ timeout: 15_000 });
        await page.getByRole('tab', { name: /Blocking/ }).click();
        // Refreshes every 5 s (the default set in the previous test).
        await page
          .getByTestId('lock-waits')
          .getByText(/price = 6/)
          .waitFor({ timeout: 20_000 });
        assert.match(String(await page.getByTestId('lock-waits').textContent()), /price = 5/);

        await page.getByRole('tab', { name: 'Slow statements' }).click();
        await page.getByText('Statement statistics are unavailable.').waitFor({ timeout: 15_000 });
        await page.getByText(/pg_stat_statements is not installed/).waitFor();

        await holder.query('ROLLBACK');
        await blocked;
        await page.getByRole('tab', { name: 'Blocking' }).click();
        await page.getByText('Nothing is waiting for a lock.').waitFor({ timeout: 20_000 });
      } finally {
        await holder.end();
        await waiter.end();
      }
    });
  },
);
