import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MYSQL_CORPUS, POSTGRES_CORPUS } from '../../../test/fixtures/classification.js';
import { analyzeScript, analyzeStatement } from '../src/sql/analyze.js';
import { preflight } from '../src/sql/preflight.js';

describe('statement classification', () => {
  for (const [engine, corpus] of [
    ['postgresql', POSTGRES_CORPUS],
    ['mysql', MYSQL_CORPUS],
  ] as const) {
    it(`classifies the ${engine} corpus`, async () => {
      const wrong: string[] = [];
      for (const entry of corpus) {
        const a = await analyzeStatement(entry.sql, engine);
        if (a.kind !== entry.kind || a.readOnlySafe !== entry.safe) {
          wrong.push(
            `${entry.sql}\n    expected ${entry.kind}/${entry.safe}, got ${a.kind}/${a.readOnlySafe} (${a.reasons.join('; ')})`,
          );
        }
      }
      assert.deepEqual(wrong, []);
    });
  }

  it('gives reasons and parse positions', async () => {
    const cte = await analyzeStatement('with g as (delete from t returning *) select * from g', 'postgresql');
    assert.deepEqual(cte.reasons, ['contains a data-modifying statement']);
    const broken = await analyzeStatement('select from where', 'postgresql');
    assert.equal(broken.parseError?.message, 'syntax error at or near "where"');
    assert.equal(broken.parseError?.offset, 12);
    const brokenMy = await analyzeStatement('select * frm t', 'mysql');
    assert.ok(brokenMy.parseError);
  });

  it('reports rows, session changes and transaction control', async () => {
    const returning = await analyzeStatement('insert into t values (1) returning id', 'postgresql');
    assert.equal(returning.returnsRows, true);
    assert.equal((await analyzeStatement('set search_path = x', 'postgresql')).changesSession, true);
    assert.equal((await analyzeStatement('set local search_path = x', 'postgresql')).changesSession, false);
    assert.equal((await analyzeStatement('use other', 'mysql')).changesSession, true);
    assert.equal((await analyzeStatement('savepoint a', 'postgresql')).transactionControl, 'savepoint');
    assert.equal(
      (await analyzeStatement('rollback to savepoint a', 'mysql')).transactionControl,
      'savepoint',
    );
    assert.equal((await analyzeStatement('set autocommit = 1', 'mysql')).transactionControl, 'autocommit');
  });

  it('marks MySQL implicit commits and PostgreSQL statements that need autocommit', async () => {
    assert.equal((await analyzeStatement('create table t (a int)', 'mysql')).implicitCommit, true);
    assert.equal((await analyzeStatement('create temporary table t (a int)', 'mysql')).implicitCommit, false);
    assert.equal((await analyzeStatement('insert into t values (1)', 'mysql')).implicitCommit, false);
    assert.equal(
      (await analyzeStatement('create index concurrently i on t (a)', 'postgresql')).noTransactionBlock,
      true,
    );
    assert.equal((await analyzeStatement('vacuum t', 'postgresql')).noTransactionBlock, true);
    assert.equal((await analyzeStatement('create index i on t (a)', 'postgresql')).noTransactionBlock, false);
    assert.deepEqual(
      (await analyzeStatement('update shop.t join u on t.id = u.id set t.a = 1', 'mysql')).writesTables,
      [{ schema: 'shop', name: 't' }],
    );
    assert.equal(
      (await analyzeStatement('create table t (a int) engine = MyISAM', 'mysql')).declaredEngine,
      'MyISAM',
    );
  });
});

describe('preflight', () => {
  const run = async (
    sql: string,
    engine: 'postgresql' | 'mysql',
    options: Partial<Parameters<typeof preflight>[1]> = {},
  ) =>
    preflight(await analyzeScript(sql, engine), {
      engine,
      transactionMode: 'per_statement',
      readOnly: false,
      ...options,
    });

  it('accepts a plain read script under read-only', async () => {
    assert.deepEqual(await run('select 1; select 2', 'postgresql', { readOnly: true }), []);
  });

  it('rejects writes and unparsable SQL under read-only, naming the policy source', async () => {
    const problems = await run('select 1;\nupdate t set a = 1;\nselec 2', 'postgresql', {
      readOnly: true,
      readOnlySources: ['connection'],
    });
    assert.deepEqual(
      problems.map((p) => [p.code, p.statement]),
      [
        ['read_only_violation', 1],
        ['parse_error', 2],
      ],
    );
    assert.match(
      problems[0]?.message ?? '',
      /Statement 2 \(line 2\).*read-only from: connection.*modifies data/,
    );
  });

  it('lets unparsable SQL through without a read-only policy', async () => {
    assert.deepEqual(await run('selec 1', 'postgresql'), []);
  });

  it('rejects transaction control in automatic modes', async () => {
    for (const mode of ['per_statement', 'atomic'] as const) {
      const problems = await run('begin; update t set a = 1; commit', 'postgresql', {
        transactionMode: mode,
      });
      assert.deepEqual(
        problems.map((p) => [p.code, p.statement]),
        [
          ['transaction_control', 0],
          ['transaction_control', 2],
        ],
      );
    }
    assert.equal((await run('set autocommit = 0', 'mysql'))[0]?.code, 'transaction_control');
  });

  it('rejects implicit commits and non-transactional engines only in single-transaction mode', async () => {
    const script = 'insert into a values (1); create table b (id int); insert into legacy values (2)';
    const tableEngine = async (t: { name: string }) => (t.name === 'legacy' ? 'MyISAM' : 'InnoDB');
    assert.deepEqual(await run(script, 'mysql', { tableEngine }), []);
    const problems = await run(script, 'mysql', { transactionMode: 'atomic', tableEngine });
    assert.deepEqual(
      problems.map((p) => [p.code, p.statement]),
      [
        ['implicit_commit', 1],
        ['non_transactional_engine', 2],
      ],
    );
    assert.equal(
      (await run('create table m (id int) engine=MEMORY', 'mysql', { transactionMode: 'atomic' })).some(
        (p) => p.code === 'non_transactional_engine',
      ),
      true,
    );
  });

  it('rejects PostgreSQL statements that cannot run in a transaction block in single-transaction mode', async () => {
    const problems = await run('create index concurrently i on t (a)', 'postgresql', {
      transactionMode: 'atomic',
    });
    assert.equal(problems[0]?.code, 'no_transaction_block');
    assert.deepEqual(await run('create index concurrently i on t (a)', 'postgresql'), []);
  });

  it('rejects unsupported and incomplete statements and empty scripts', async () => {
    assert.equal((await run('copy t to stdout', 'postgresql'))[0]?.code, 'unsupported_statement');
    assert.equal((await run("select 'open", 'mysql'))[0]?.code, 'incomplete_statement');
    assert.equal((await run(' -- nothing', 'mysql'))[0]?.code, 'empty_script');
  });
});
