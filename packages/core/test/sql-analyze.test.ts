import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MYSQL_CORPUS, POSTGRES_CORPUS } from '../../../test/fixtures/classification.js';
import { analyzeScript, analyzeStatement } from '../src/sql/analyze.js';
import { preflight } from '../src/sql/preflight.js';
import { UNRESOLVED_VIEW } from '../src/sql/types.js';

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
    // Temporary objects outlive the statement: the connection must not be reused by others.
    for (const sql of ['create temporary table t (a int)', 'create temporary table `t` like base']) {
      assert.equal((await analyzeStatement(sql, 'mysql')).changesSession, true, sql);
    }
    for (const sql of [
      'create temp table t (a int)',
      'create temporary table t as select 1',
      'select 1 as a into temp t',
      'create table pg_temp.t (a int)',
      'create temp view v as select 1',
      'create function pg_temp.f() returns int language sql as $$ select 1 $$',
    ]) {
      assert.equal((await analyzeStatement(sql, 'postgresql')).changesSession, true, sql);
    }
    assert.equal((await analyzeStatement('create table t (a int)', 'postgresql')).changesSession, false);
    // Session-level locks outlive the transaction; transaction-level ones do not.
    for (const sql of ['select pg_advisory_lock(1)', 'select pg_try_advisory_lock_shared(1, 2)']) {
      assert.equal((await analyzeStatement(sql, 'postgresql')).changesSession, true, sql);
    }
    assert.equal(
      (await analyzeStatement('select pg_advisory_xact_lock(1)', 'postgresql')).changesSession,
      false,
    );
    assert.equal((await analyzeStatement("select get_lock('x', 0)", 'mysql')).changesSession, true);
    assert.equal((await analyzeStatement('create table t (a int)', 'mysql')).changesSession, false);
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

  it('checks the tables a MySQL USE points unqualified names at', async () => {
    const engines: Record<string, string> = { 'a.t': 'InnoDB', 'b.t': 'MyISAM' };
    const asked: string[] = [];
    const tableEngine = async (t: { schema: string | null; name: string }) => {
      const key = `${t.schema ?? 'a'}.${t.name}`;
      asked.push(key);
      return engines[key] ?? null;
    };
    const script = 'insert into t values (1); use `b`; insert into t values (2); select 1 from missing';
    const problems = await run(script, 'mysql', { transactionMode: 'atomic', tableEngine });
    assert.deepEqual(asked, ['a.t', 'b.t']);
    assert.deepEqual(
      problems.map((p) => [p.code, p.statement]),
      [['non_transactional_engine', 2]],
    );
    assert.deepEqual(
      await run('use b; insert into a.t values (1)', 'mysql', { transactionMode: 'atomic', tableEngine }),
      [],
    );
  });

  it('checks names in exact case, and refuses writes through views whose tables are unknown', async () => {
    const asked: string[] = [];
    const tableEngine = async (t: { schema: string | null; name: string }) => {
      asked.push(t.name);
      return { Ledger: 'InnoDB', ledger: 'MyISAM', v: UNRESOLVED_VIEW }[t.name] ?? null;
    };
    const problems = await run(
      'insert into Ledger values (1); insert into ledger values (2); insert into v values (3); select 1 from missing',
      'mysql',
      { transactionMode: 'atomic', tableEngine },
    );
    assert.deepEqual(asked, ['Ledger', 'ledger', 'v']);
    assert.deepEqual(
      problems.map((p) => [p.code, p.statement]),
      [
        ['non_transactional_engine', 1],
        ['unchecked_write_target', 2],
      ],
    );
  });

  it('checks the target of MySQL LOAD DATA, and refuses writes whose targets are unknown, in single-transaction mode', async () => {
    const tableEngine = async (t: { schema: string | null; name: string }) =>
      t.name === 'legacy' ? 'MyISAM' : 'InnoDB';
    const load = await analyzeStatement(
      "load data infile '/tmp/x.csv' ignore into table `app`.`legacy` fields terminated by ','",
      'mysql',
    );
    assert.deepEqual(load.writesTables, [{ schema: 'app', name: 'legacy' }]);
    const problems = await run(
      "insert into t values (1); load data infile '/tmp/x.csv' into table legacy; select 1 from missing",
      'mysql',
      { transactionMode: 'atomic', tableEngine },
    );
    assert.deepEqual(
      problems.map((p) => [p.code, p.statement]),
      [['non_transactional_engine', 1]],
    );
    const unknown = await run("load data infile '/tmp/x.csv'", 'mysql', {
      transactionMode: 'atomic',
      tableEngine,
    });
    assert.equal(unknown[0]?.code, 'unchecked_write_target');
    assert.deepEqual(await run("load data infile '/tmp/x.csv' into table t", 'mysql', { tableEngine }), []);
  });

  it('rejects MySQL procedure calls in single-transaction mode, because a procedure can commit', async () => {
    const script = 'insert into a values (1); call commits_inside(); select 1 from missing';
    assert.deepEqual(await run(script, 'mysql'), []);
    const problems = await run(script, 'mysql', { transactionMode: 'atomic' });
    assert.deepEqual(
      problems.map((p) => [p.code, p.statement]),
      [['routine_may_commit', 1]],
    );
    // In PostgreSQL a procedure that commits inside a transaction block fails, so CALL may stay.
    assert.equal(
      (await run('call p()', 'postgresql', { transactionMode: 'atomic' })).some(
        (p) => p.code === 'routine_may_commit',
      ),
      false,
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
