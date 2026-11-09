import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { checkReadiness } from '../src/health.js';

const root = await mkdtemp(join(tmpdir(), 'workbench-health-'));
after(() => rm(root, { recursive: true, force: true }));

describe('checkReadiness', () => {
  it('is ready when the database and export folder are writable', async () => {
    const result = await checkReadiness({ dataDir: root, exportDir: root });
    assert.equal(result.ready, true);
    assert.deepEqual(result.checks.database, { ok: true, detail: 'writable' });
    assert.deepEqual(result.checks.exports, { ok: true, detail: 'writable' });
  });

  it('is not ready when a folder is missing', async () => {
    const missing = join(root, 'missing');
    const result = await checkReadiness({ dataDir: missing, exportDir: missing });
    assert.equal(result.ready, false);
    assert.equal(result.checks.database.ok, false);
    assert.equal(result.checks.exports.detail, 'not writable (ENOENT)');
  });

  it(
    'reports a read-only export folder',
    { skip: process.getuid?.() === 0 && 'root ignores file permissions' },
    async () => {
      const readOnly = join(root, 'read-only');
      await mkdir(readOnly);
      await chmod(readOnly, 0o555);
      const result = await checkReadiness({ dataDir: root, exportDir: readOnly });
      assert.equal(result.checks.exports.ok, false);
    },
  );
});
