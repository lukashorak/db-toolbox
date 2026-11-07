import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { leadingWords } from '../src/sql/lexer.js';
import { splitStatements } from '../src/sql/split.js';

const texts = (sql: string, dialect: 'postgresql' | 'mysql') =>
  splitStatements(sql, dialect).map((s) => s.text);

describe('statement splitting', () => {
  it('splits on semicolons and drops empty statements', () => {
    assert.deepEqual(texts('select 1;  ;\nselect 2;\n\n', 'postgresql'), ['select 1', 'select 2']);
    assert.deepEqual(texts('select 1', 'mysql'), ['select 1']);
    assert.deepEqual(texts(' -- only a comment\n/* and another */ ', 'postgresql'), []);
  });

  it('ignores semicolons in strings, identifiers and comments', () => {
    const pg = `select 'a;b', "c;d", E'it\\'s;' -- x; y
      /* block; /* nested; */ still comment; */ from t; select 2`;
    assert.deepEqual(texts(pg, 'postgresql').length, 2);
    const my = `select 'a;b', "c;d", 'it\\'s;', \`e;f\` # x; y
      from t; select 2 -- z;`;
    assert.deepEqual(texts(my, 'mysql'), [
      `select 'a;b', "c;d", 'it\\'s;', \`e;f\` # x; y\n      from t`,
      'select 2',
    ]);
  });

  it('treats doubled quotes as escapes', () => {
    assert.deepEqual(texts(`select 'it''s;'; select "a"";b"`, 'postgresql'), [
      `select 'it''s;'`,
      `select "a"";b"`,
    ]);
  });

  it('understands PostgreSQL dollar quoting and parameters', () => {
    const sql = `create function f() returns int language plpgsql as $body$
      begin perform 1; return 2; end; $body$;
      do $$ begin raise notice 'x;'; end $$;
      select $1::int; select a$b from t`;
    const parts = texts(sql, 'postgresql');
    assert.equal(parts.length, 4);
    assert.match(parts[0] as string, /^create function.*\$body\$$/s);
    assert.match(parts[1] as string, /^do \$\$.*\$\$$/s);
    assert.equal(parts[2], 'select $1::int');
    assert.equal(parts[3], 'select a$b from t');
  });

  it('keeps PostgreSQL BEGIN ATOMIC bodies together', () => {
    const sql = `create function add(a int, b int) returns int language sql
      begin atomic select case when a > 0 then a + b else b end; select 1; end;
      select 3`;
    const parts = texts(sql, 'postgresql');
    assert.equal(parts.length, 2);
    assert.match(parts[0] as string, /end$/);
    assert.equal(parts[1], 'select 3');
  });

  it('nests block comments in PostgreSQL but not in MySQL', () => {
    assert.deepEqual(texts('/* a /* b */ ; */ select 1', 'postgresql'), ['select 1']);
    assert.deepEqual(texts('/* a /* b */ select 1; select 2', 'mysql'), ['select 1', 'select 2']);
  });

  it('requires whitespace after -- in MySQL', () => {
    assert.deepEqual(texts('select 1--1; select 2', 'mysql'), ['select 1--1', 'select 2']);
    assert.deepEqual(texts('select 1 -- 1; select 2', 'mysql'), ['select 1']);
  });

  it('handles MySQL DELIMITER and executable comments', () => {
    const sql = `DELIMITER //
CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//
DELIMITER ;
/*!40101 SET NAMES utf8 */;
SELECT 3;`;
    const statements = splitStatements(sql, 'mysql');
    assert.deepEqual(
      statements.map((s) => s.text),
      ['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', '/*!40101 SET NAMES utf8 */', 'SELECT 3'],
    );
    assert.deepEqual(
      statements.map((s) => s.executableComment),
      [false, true, false],
    );
  });

  it('reports ranges with lines and columns', () => {
    const sql = 'select 1;\n  select\n    2 ;\n-- trailing\n';
    const [first, second] = splitStatements(sql, 'postgresql');
    assert.deepEqual(first?.range, {
      start: 0,
      end: 8,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 8,
    });
    assert.deepEqual(second?.range, {
      start: 12,
      end: 24,
      startLine: 2,
      startColumn: 3,
      endLine: 3,
      endColumn: 5,
    });
    assert.equal(sql.slice(second?.range.start, second?.range.end), 'select\n    2');
  });

  it('flags statements whose quotes or comments are not closed', () => {
    const [statement] = splitStatements("select 'oops; select 2", 'postgresql');
    assert.equal(statement?.incomplete, true);
    assert.equal(splitStatements('select $x$ never closed', 'postgresql')[0]?.incomplete, true);
    assert.equal(splitStatements('select 1 /* open', 'mysql')[0]?.incomplete, true);
  });

  it('reads leading keywords past comments', () => {
    assert.deepEqual(leadingWords('/* x */ -- y\n  start transaction read only', 'mysql'), [
      'START',
      'TRANSACTION',
      'READ',
      'ONLY',
    ]);
    assert.deepEqual(leadingWords('# c\nshow tables', 'mysql', 2), ['SHOW', 'TABLES']);
  });
});
