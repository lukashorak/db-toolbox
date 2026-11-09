import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, chown, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PostgresAdapter } from '../../src/core/adapters.js';
import type { Connection, Row, Session } from '../../src/core/types.js';

test(
  'native PostgreSQL TCP cursor, precision, read-only transaction and cancellation',
  { skip: process.getuid?.() === 0 ? 'Native PostgreSQL requires a non-root OS user.' : false },
  async () => {
    assert.equal(process.platform, 'linux', 'Bundled native fixture currently targets Linux.');
    const directory = await mkdtemp(join(tmpdir(), 'workbench-native-pg-'));
    const asNonRoot = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
    if (asNonRoot.uid !== undefined) await chown(directory, asNonRoot.uid, asNonRoot.gid!);
    const binaries = resolve(`node_modules/@embedded-postgres/linux-${process.arch}/native/bin`);
    const init = spawnSync(
      join(binaries, 'initdb'),
      [
        '-D',
        join(directory, 'db'),
        '-U',
        'workbench',
        '--auth=trust',
        '--no-locale',
        '--encoding=UTF8',
      ],
      { ...asNonRoot, cwd: directory, encoding: 'utf8' },
    );
    assert.equal(init.status, 0, init.stderr);
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const server = spawn(
      join(binaries, 'postgres'),
      [
        '-D',
        join(directory, 'db'),
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
        '-c',
        "unix_socket_directories=''",
      ],
      { ...asNonRoot, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let log = '';
    server.stderr.on('data', (value) => {
      log += value.toString();
    });
    server.stdout.on('data', (value) => {
      log += value.toString();
    });
    let session: Session | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
          if (log.includes('ready to accept connections')) {
            clearInterval(interval);
            clearTimeout(timer);
            resolve();
          }
        }, 20);
        const timer = setTimeout(() => {
          clearInterval(interval);
          reject(new Error(log));
        }, 10_000);
        server.once('exit', () => {
          clearInterval(interval);
          clearTimeout(timer);
          reject(new Error(log));
        });
      });
      const connection: Connection = {
        id: 'test',
        owner: 'test',
        name: 'native',
        engine: 'postgres',
        host: '127.0.0.1',
        port,
        database: 'postgres',
        username: 'workbench',
        tls: false,
        readOnly: false,
        enabled: true,
      };
      session = await new PostgresAdapter().open(connection, 5000);
      const query = async (sql: string, signal = AbortSignal.timeout(5000)) => {
        const rows: Row[] = [];
        let columns: any[] = [];
        for await (const batch of session!.query(sql, signal)) {
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
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 100);
      await assert.rejects(query('SELECT pg_sleep(10)', abort.signal));
      clearTimeout(timer);
      await session.rollback();
      assert.equal((await query('SELECT 42 AS answer')).rows[0]![0], 42);
    } finally {
      await session?.close().catch(() => {});
      server.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        if (server.exitCode !== null) resolve();
        else server.once('exit', () => resolve());
      });
      await rm(directory, { recursive: true, force: true });
    }
  },
);
