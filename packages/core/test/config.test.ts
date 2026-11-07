import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const valid = {
  PUBLIC_URL: 'https://db.example.test',
  KEYCLOAK_ISSUER: 'https://auth.example.test/realms/workbench',
  ENCRYPTION_KEY: KEY,
};

const issues = (env: Record<string, string | undefined>): string[] => {
  try {
    loadConfig(env, '/srv/workbench');
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.issues;
  }
  assert.fail('expected a ConfigError');
};

describe('loadConfig', () => {
  it('reports every missing required variable at once', () => {
    assert.deepEqual(issues({}), [
      'PUBLIC_URL is required',
      'KEYCLOAK_ISSUER is required',
      'ENCRYPTION_KEY is required',
    ]);
  });

  it('applies the agreed defaults', () => {
    const config = loadConfig(valid, '/srv/workbench');
    assert.equal(config.env, 'development');
    assert.equal(config.publicUrl, 'https://db.example.test');
    assert.equal(config.mcpAudience, 'https://db.example.test/mcp');
    assert.equal(config.guiClientId, 'workbench-gui');
    assert.equal(config.mcpClientId, 'workbench-mcp');
    assert.equal(config.apiAudience, 'workbench-api');
    assert.equal(config.dataDir, '/srv/workbench/data');
    assert.equal(config.exportDir, '/srv/workbench/exports');
    assert.equal(config.encryptionKey.length, 32);
    assert.deepEqual(config.limits, {
      previewRows: 1000,
      mcpPreviewRows: 1000,
      mcpPreviewBytes: 262144,
      maxResultBytes: 104857600,
      maxTotalBytes: 1073741824,
      concurrencyPerConnection: 2,
      ordinaryTimeoutMs: 30000,
      fullTimeoutMaxMs: 300000,
    });
  });

  it('rejects a public URL with a path and plain http in production', () => {
    assert.deepEqual(issues({ ...valid, PUBLIC_URL: 'https://db.example.test/workbench' }), [
      'PUBLIC_URL must be an origin without a path',
    ]);
    assert.deepEqual(issues({ ...valid, NODE_ENV: 'production', PUBLIC_URL: 'http://db.example.test' }), [
      'PUBLIC_URL must use https in production',
    ]);
  });

  it('requires the issuer to name a Keycloak realm', () => {
    assert.deepEqual(issues({ ...valid, KEYCLOAK_ISSUER: 'https://auth.example.test/' }), [
      'KEYCLOAK_ISSUER must point at a realm, for example https://auth.example.com/realms/workbench',
    ]);
  });

  it('requires a 32-byte base64 encryption key and never echoes it', () => {
    const secret = Buffer.alloc(16, 9).toString('base64');
    const found = issues({ ...valid, ENCRYPTION_KEY: secret });
    assert.deepEqual(found, ['ENCRYPTION_KEY must be 32 random bytes encoded as base64']);
    assert.ok(!found.join(' ').includes(secret));
  });

  it('validates numeric limits and their relationships', () => {
    assert.deepEqual(issues({ ...valid, PORT: '70000' }), ['PORT is invalid (too_big)']);
    assert.deepEqual(issues({ ...valid, ORDINARY_TIMEOUT_MS: '600000' }), [
      'FULL_TIMEOUT_MAX_MS must not be lower than ORDINARY_TIMEOUT_MS',
    ]);
  });
});
