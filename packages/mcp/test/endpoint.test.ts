import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeMcpEndpoint } from '../src/index.js';

describe('describeMcpEndpoint', () => {
  it('uses the same value for the endpoint URL and the token audience', () => {
    const endpoint = describeMcpEndpoint({
      publicUrl: 'https://db.example.test',
      mcpAudience: 'https://db.example.test/mcp',
      mcpClientId: 'workbench-mcp',
    });
    assert.deepEqual(endpoint, {
      url: 'https://db.example.test/mcp',
      audience: 'https://db.example.test/mcp',
      clientId: 'workbench-mcp',
    });
  });
});
