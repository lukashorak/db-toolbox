import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { PostgresAdapter } from '../../src/core/adapters.js';
import type { Row, Session } from '../../src/core/types.js';

test('PostgreSQL TCP driver streams exact batch boundaries and preserves values', async () => {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port: 0 });
  await server.start();
  let session: Session | undefined;
  try {
    const url = new URL(`postgresql://${server.getServerConn()}`);
    session = await new PostgresAdapter().open(
      {
        id: 'wire',
        owner: 'test',
        name: 'wire',
        engine: 'postgres',
        host: '127.0.0.1',
        port: Number(url.port),
        database: 'postgres',
        username: 'postgres',
        tls: false,
        readOnly: false,
        enabled: true,
      },
      5000,
    );
    const query = async (sql: string) => {
      const rows: Row[] = [];
      let columns: any[] = [];
      for await (const batch of session!.query(sql, AbortSignal.timeout(5000))) {
        columns = batch.columns;
        rows.push(...batch.rows);
      }
      return { columns, rows };
    };
    for (const count of [0, 250, 500, 1200]) {
      const value = await query(`SELECT i FROM generate_series(1,${count}) AS i`);
      assert.equal(value.rows.length, count);
      assert.equal(value.columns[0].name, 'i');
    }
    const exact = await query(
      "SELECT 9007199254740993::bigint AS n,9007199254740993.25::numeric AS n,NULL::text AS empty,TIMESTAMP '2026-11-07 12:34:56' AS at",
    );
    assert.deepEqual(exact.rows[0], [
      '9007199254740993',
      '9007199254740993.25',
      null,
      '2026-11-07 12:34:56',
    ]);
    assert.equal(exact.columns[0].name, exact.columns[1].name);
    await session.begin(true);
    await assert.rejects(query('CREATE TABLE denied(id integer)'));
    await session.rollback();
    await session.begin(false);
    await query('CREATE TABLE rolled_back(id integer)');
    await session.rollback();
    await assert.rejects(query('SELECT * FROM rolled_back'));
  } finally {
    await session?.close().catch(() => {});
    await server.stop();
    await db.close();
  }
});
