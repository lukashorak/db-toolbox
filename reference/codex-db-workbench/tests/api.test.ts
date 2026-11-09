import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { httpFixture } from './http-fixture.js';
import { finished, human } from './helpers.js';

test('JWT issuer audience expiry and OAuth client binding are enforced', async () => {
  const f = await httpFixture();
  try {
    assert.equal((await f.request('/api/connections')).status, 200);
    assert.equal((await f.request('/api/connections', {}, f.mcpToken)).status, 401);
    assert.equal(
      (await f.request('/api/connections', {}, await f.token('gui', { aud: 'wrong' }))).status,
      401,
    );
    assert.equal(
      (await f.request('/api/connections', {}, await f.token('gui', { exp: 1 }))).status,
      401,
    );
    assert.equal(
      (await f.request('/api/connections', {}, await f.token('mcp', { aud: f.config.apiAudience })))
        .status,
      401,
    );
    assert.equal(
      (await f.request('/api/connections', {}, f.guiToken.slice(0, -4) + 'oops')).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          '/api/connections',
          {},
          await f.token('gui', { realm_access: { roles: [] } }),
        )
      ).status,
      403,
    );
    const badOrigin = await f.request('/api/connections', {
      headers: { Origin: 'https://attacker.invalid' },
    });
    assert.equal(badOrigin.status, 403);
    const unauth = await fetch(f.url + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers.get('www-authenticate')!, /resource_metadata/);
  } finally {
    await f.close();
  }
});
test('HTTP submission survives client disconnect and records complete result', async () => {
  const f = await httpFixture();
  try {
    const submitted = await f.request('/api/executions', {
      method: 'POST',
      body: JSON.stringify(f.input('SELECT id FROM sample ORDER BY id')),
    });
    assert.equal(submitted.status, 202);
    const job = await finished(f.core, submitted.body.id);
    assert.equal(job.status, 'succeeded');
    const read = await f.request(`/api/results/${job.results[0]!.id}?limit=1000`);
    assert.equal(read.body.rows.length, 1000);
    const exportResponse = await f.request(`/api/results/${job.results[0]!.id}/exports`, {
      method: 'POST',
      body: '{"format":"json"}',
    });
    assert.equal(exportResponse.body.rows, 1200);
    const mcpDownload = await fetch(f.url + `/mcp/exports/${exportResponse.body.id}`, {
      headers: { Authorization: `Bearer ${f.mcpToken}` },
    });
    assert.equal(mcpDownload.status, 403);
    const forged = await f.request(
      `/api/results/${job.results[0]!.id}/approvals`,
      { method: 'POST', body: JSON.stringify({ profileId: f.profile.id }) },
      f.mcpToken,
    );
    assert.equal(forged.status, 401);
    assert.equal(
      (
        await f.request(`/api/results/${job.results[0]!.id}/approvals`, {
          method: 'POST',
          body: JSON.stringify({ profileId: f.profile.id }),
        })
      ).status,
      200,
    );
    const approvedDownload = await fetch(f.url + `/mcp/exports/${exportResponse.body.id}`, {
      headers: { Authorization: `Bearer ${f.mcpToken}` },
    });
    assert.equal(approvedDownload.status, 200);
    assert.equal((await approvedDownload.json()).rows.length, 1200);
  } finally {
    await f.close();
  }
});
test('official MCP client discovers tools and executes through the same core', async () => {
  const f = await httpFixture();
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(f.url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${f.mcpToken}` } },
      }),
    );
    const listed = await client.listTools();
    assert.ok(listed.tools.some((t) => t.name === 'execute_sql'));
    assert.equal(
      listed.tools.some((t) => t.name.includes('approve')),
      false,
    );
    const forbidden = await client.callTool({
      name: 'execute_sql',
      arguments: f.input('DELETE FROM sample'),
    });
    assert.equal(forbidden.isError, true);
    const submitted = await client.callTool({
      name: 'execute_sql',
      arguments: f.input('SELECT id FROM sample ORDER BY id'),
    });
    assert.notEqual(submitted.isError, true);
    const executionId = JSON.parse((submitted.content as any)[0].text).executionId;
    const job = await finished(f.core, executionId);
    const blocked = await client.callTool({
      name: 'get_result',
      arguments: { resultId: job.results[0]!.id, offset: 1000 },
    });
    assert.equal(blocked.isError, true);
    f.core.approve(human, job.results[0]!.id, f.profile.id);
    const permitted = await client.callTool({
      name: 'get_result',
      arguments: { resultId: job.results[0]!.id, offset: 1000, limit: 200 },
    });
    assert.notEqual(permitted.isError, true);
    assert.equal(JSON.parse((permitted.content as any)[0].text).rows.length, 200);
    const changed = { ...f.profile, enabled: false };
    f.store.saveProfile(changed);
    await assert.rejects(client.callTool({ name: 'list_connections', arguments: {} }));
  } finally {
    await client.close().catch(() => {});
    await f.close();
  }
});
