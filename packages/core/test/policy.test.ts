import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/domain/errors.js';
import { can, evaluateWritePolicy, permissionsOf } from '../src/security/policy.js';
import { actor, admin, adminWithoutWrite, reader, writer } from './helpers.js';

describe('evaluateWritePolicy', () => {
  const cases: [boolean, boolean, boolean][] = [];
  for (const userRo of [false, true])
    for (const connRo of [false, true])
      for (const profRo of [false, true]) cases.push([userRo, connRo, profRo]);

  for (const [userRo, connRo, profRo] of cases) {
    it(`user ${userRo ? 'read-only' : 'writer'}, connection ${connRo ? 'read-only' : 'writable'}, profile ${profRo ? 'read-only' : 'writable'}`, () => {
      const mcp = actor('lukas', userRo ? ['query:read'] : ['query:read', 'query:write'], {
        source: 'mcp',
        clientId: 'workbench-mcp',
        profileId: 'mcp_1',
      });
      const policy = evaluateWritePolicy({
        actor: mcp,
        connection: { name: 'Operations', readOnly: connRo },
        profile: { name: 'Claude Code analytics', readOnly: profRo },
      });
      const expected = [userRo && 'user', connRo && 'connection', profRo && 'profile'].filter(Boolean);
      assert.equal(policy.readOnly, userRo || connRo || profRo);
      assert.deepEqual(policy.sources, expected);
      assert.equal(policy.layers.length, 3);
    });
  }

  it('ignores the profile layer for GUI calls and requires a profile for MCP calls', () => {
    const gui = evaluateWritePolicy({ actor: writer, connection: { name: 'Development', readOnly: false } });
    assert.equal(gui.readOnly, false);
    assert.deepEqual(
      gui.layers.map((l) => l.layer),
      ['user', 'connection'],
    );
    assert.throws(
      () =>
        evaluateWritePolicy({
          actor: { ...writer, source: 'mcp' },
          connection: { name: 'x', readOnly: false },
        }),
      (e: unknown) => e instanceof AppError && e.code === 'forbidden',
    );
  });

  it('never lets an administrator bypass a restriction', () => {
    assert.equal(
      evaluateWritePolicy({ actor: admin, connection: { name: 'Prod', readOnly: true } }).readOnly,
      true,
    );
    const noWrite = evaluateWritePolicy({
      actor: adminWithoutWrite,
      connection: { name: 'Dev', readOnly: false },
    });
    assert.deepEqual(noWrite.sources, ['user']);
  });
});

describe('permissions', () => {
  it('keeps database writes separate from application configuration', () => {
    assert.equal(permissionsOf(['admin']).has('sql.write'), false);
    assert.equal(can(adminWithoutWrite, 'connections.manage'), true);
    assert.equal(can(writer, 'connections.manage'), false);
  });

  it('lets a read-only database user save queries', () => {
    assert.equal(can(reader, 'queries.manage'), true);
    assert.equal(can(reader, 'sql.write'), false);
  });

  it('never lets an MCP client decide on disclosure', () => {
    assert.equal(can(reader, 'disclosure.decide'), true);
    assert.equal(can({ ...reader, source: 'mcp', profileId: 'mcp_1' }, 'disclosure.decide'), false);
  });
});
