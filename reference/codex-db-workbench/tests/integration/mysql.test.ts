import test from 'node:test';
import assert from 'node:assert/strict';
import { MysqlAdapter } from '../../src/core/adapters.js';
import type { Row } from '../../src/core/types.js';

const configured =
  !!process.env.MYSQL_TEST_HOST &&
  !!process.env.MYSQL_TEST_DATABASE &&
  !!process.env.MYSQL_TEST_USER;
test(
  'MySQL TCP streaming, precision, read-only transaction and cancellation',
  {
    skip: configured
      ? false
      : 'Set MYSQL_TEST_HOST, MYSQL_TEST_DATABASE and MYSQL_TEST_USER for a disposable test database.',
  },
  async () => {
    const session = await new MysqlAdapter().open(
      {
        id: 'mysql-test',
        owner: 'test',
        name: 'MySQL test',
        engine: 'mysql',
        host: process.env.MYSQL_TEST_HOST!,
        port: Number(process.env.MYSQL_TEST_PORT ?? 3306),
        database: process.env.MYSQL_TEST_DATABASE!,
        username: process.env.MYSQL_TEST_USER!,
        password: process.env.MYSQL_TEST_PASSWORD ?? '',
        tls: process.env.MYSQL_TEST_TLS === 'true',
        readOnly: false,
        enabled: true,
      },
      5000,
    );
    const query = async (sql: string, signal = AbortSignal.timeout(5000)) => {
      const rows: Row[] = [];
      for await (const batch of session.query(sql, signal)) rows.push(...batch.rows);
      return rows;
    };
    try {
      const digits =
        '(SELECT 0 AS n UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9)';
      for (const count of [0, 250, 500, 1200])
        assert.equal(
          (
            await query(
              `SELECT a.n FROM ${digits} a CROSS JOIN ${digits} b CROSS JOIN ${digits} c CROSS JOIN ${digits} d LIMIT ${count}`,
            )
          ).length,
          count,
        );
      assert.deepEqual(
        (
          await query(
            "SELECT CAST(9007199254740993 AS UNSIGNED),CAST('9007199254740993.25' AS DECIMAL(25,2)),NULL",
          )
        )[0],
        ['9007199254740993', '9007199254740993.25', null],
      );
      await session.begin(true);
      await assert.rejects(query(`CREATE TABLE workbench_readonly_denied_${Date.now()}(id INT)`));
      await session.rollback();
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 100);
      try {
        await assert.rejects(query('SELECT SLEEP(10)', abort.signal));
      } finally {
        clearTimeout(timer);
      }
      await session.rollback();
      assert.equal((await query('SELECT 42'))[0]![0], 42);
    } finally {
      await session.close();
    }
  },
);
