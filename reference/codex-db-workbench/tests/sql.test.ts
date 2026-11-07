import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, previewSql, splitStatements } from '../src/core/sql.js';
import { effectiveReadOnly } from '../src/core/policy.js';
import { human, connectionSettings } from './helpers.js';

test('read-only restrictions combine at all three levels', () => {
  for (const connectionReadOnly of [false, true])
    for (const profileReadOnly of [false, true])
      for (const userReadOnly of [false, true]) {
        const actor = {
          ...human,
          channel: 'mcp' as const,
          profileId: 'profile',
          clientId: 'mcp',
          roles: userReadOnly ? ['query:read'] : human.roles,
        };
        const connection = {
          ...connectionSettings,
          id: 'connection',
          owner: human.subject,
          readOnly: connectionReadOnly,
        };
        const profile = {
          id: 'profile',
          owner: human.subject,
          name: 'Test',
          clientId: 'mcp',
          connectionIds: ['connection'],
          readOnly: profileReadOnly,
          enabled: true,
        };
        assert.equal(
          effectiveReadOnly(actor, connection, profile),
          connectionReadOnly || profileReadOnly || userReadOnly,
        );
      }
});
test('an OAuth client cannot switch to another profile', () => {
  assert.throws(
    () =>
      effectiveReadOnly(
        { ...human, channel: 'mcp', profileId: 'p', clientId: 'readonly-client' },
        { ...connectionSettings, id: 'c', owner: human.subject },
        {
          id: 'p',
          owner: human.subject,
          name: 'RW',
          clientId: 'write-client',
          connectionIds: ['c'],
          readOnly: false,
          enabled: true,
        },
      ),
    { code: 'PROFILE_DENIED' },
  );
});
test('lexer preserves quoted semicolons comments and PostgreSQL dollar quotes', () => {
  assert.deepEqual(
    splitStatements(
      "SELECT ';'; -- a ; comment\n SELECT $$x;y$$; /* ; */ SELECT 'it''s; ok';",
      'postgres',
    ),
    ["SELECT ';'", '-- a ; comment\n SELECT $$x;y$$', "/* ; */ SELECT 'it''s; ok'"],
  );
  assert.equal(splitStatements("SELECT 'a\\\';b'; # comment;\n SELECT 2;", 'mysql').length, 2);
});
test('preview changes only the outer row limit and preserves exact literals', () => {
  for (const engine of ['postgres', 'mysql'] as const) {
    const sql =
      'SELECT 9007199254740993.25 AS exact FROM sample WHERE id IN (SELECT id FROM sample LIMIT 20) LIMIT 5000';
    const statement = analyze(sql, engine, true, 'atomic')[0]!;
    assert.equal(previewSql(statement, engine, 1001), sql.replace(/5000$/, '1001'));
    assert.equal(statement.sql, sql);
    assert.equal(
      previewSql(analyze('SELECT * FROM sample LIMIT 7', engine, true, 'atomic')[0]!, engine, 1001),
      'SELECT * FROM sample LIMIT 7',
    );
  }
});
test('MySQL offset and a trailing SQL comment survive preview limiting', () => {
  assert.equal(
    previewSql(
      analyze('SELECT * FROM sample LIMIT 10, 4000', 'mysql', true, 'atomic')[0]!,
      'mysql',
      1001,
    ),
    'SELECT * FROM sample LIMIT 10, 1001',
  );
  assert.equal(
    previewSql(analyze('SELECT 1 -- hi', 'postgres', true, 'atomic')[0]!, 'postgres', 1001),
    'SELECT 1 -- hi\nLIMIT 1001',
  );
});
for (const engine of ['postgres', 'mysql'] as const)
  for (const sql of [
    'DELETE FROM sample',
    "UPDATE sample SET label='x'",
    'CREATE TABLE dangerous(id int)',
    'COMMIT',
    'SET TRANSACTION READ WRITE',
    'SELECT dangerous_function()',
  ]) {
    test(`${engine} read-only rejects ${sql}`, () =>
      assert.throws(() => analyze(sql, engine, true, 'per_statement')));
  }
test('read-only rejects file output executable comments and writable CTEs', () => {
  for (const [engine, sql] of [
    ['mysql', "SELECT 1 INTO OUTFILE '/tmp/data'"],
    ['mysql', "SELECT 1 /*! INTO OUTFILE '/tmp/data' */"],
    ['postgres', 'WITH x AS (DELETE FROM sample RETURNING *) SELECT * FROM x'],
    ['postgres', 'SELECT pg_terminate_backend(1)'],
  ] as const)
    assert.throws(() => analyze(sql, engine, true, 'per_statement'));
});
test('atomic mode rejects implicit-commit statements before executing anything', () => {
  assert.throws(
    () =>
      analyze('INSERT INTO sample VALUES (1); CREATE TABLE t(id int)', 'mysql', false, 'atomic'),
    { code: 'NON_ATOMIC_SQL' },
  );
});
