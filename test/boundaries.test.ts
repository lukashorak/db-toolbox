import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: process.cwd() });

const restricted = async (filePath: string, code: string): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
};

describe('module boundaries', () => {
  it('keeps database drivers inside core', async () => {
    assert.equal((await restricted('packages/api/src/x.ts', "import pg from 'pg';\nvoid pg;\n")).length, 1);
    assert.equal((await restricted('packages/mcp/src/x.ts', "import 'mysql2';\n")).length, 1);
    assert.equal((await restricted('packages/core/src/x.ts', "import 'pg';\n")).length, 0);
  });

  it('allows only the public core entry point from api and mcp', async () => {
    assert.equal(
      (await restricted('packages/api/src/x.ts', "import '@workbench/core/src/config.js';\n")).length,
      1,
    );
    assert.equal(
      (await restricted('packages/mcp/src/x.ts', "import '../../core/src/config.js';\n")).length,
      1,
    );
    assert.equal((await restricted('packages/mcp/src/x.ts', "import '@workbench/core';\n")).length, 0);
  });

  it('keeps mcp independent of the HTTP API and core free of interfaces', async () => {
    assert.equal((await restricted('packages/mcp/src/x.ts', "import '@workbench/api';\n")).length, 1);
    assert.equal((await restricted('packages/core/src/x.ts', "import '@workbench/mcp';\n")).length, 1);
    assert.equal((await restricted('packages/core/src/x.ts', "import 'fastify';\n")).length, 1);
  });

  it('keeps the browser app away from server code', async () => {
    assert.equal((await restricted('packages/web/src/x.ts', "import '@workbench/core';\n")).length, 1);
    assert.equal((await restricted('packages/web/src/x.ts', "import 'node:fs';\n")).length, 1);
  });

  it('never imports reference material', async () => {
    assert.equal(
      (
        await restricted(
          'packages/core/src/x.ts',
          "import '../../../reference/codex-db-workbench/src/core/sql.js';\n",
        )
      ).length,
      1,
    );
  });
});
