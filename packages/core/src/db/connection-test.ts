import { connect as tcpConnect } from 'node:net';
import mysql from 'mysql2';
import pg from 'pg';
import { DbError, mapMysqlError, mapPostgresError, type DbErrorCategory } from './errors.js';
import { mysqlConnectionOptions } from './mysql.js';
import { postgresClientConfig } from './postgres.js';
import { describeTls, mysqlVerifyFullProblem } from './tls.js';
import type { ConnectionTarget, Endpoint } from './types.js';

export type TestStepName = 'reach' | 'tls' | 'authenticate' | 'probe';
export type TestFailureCategory = Extract<
  DbErrorCategory,
  'connectivity' | 'tls' | 'authentication' | 'configuration' | 'timeout' | 'other'
>;

export interface TestStep {
  name: TestStepName;
  status: 'ok' | 'failed' | 'skipped';
  durationMs: number;
  detail: string;
}

export interface Capability {
  name: 'read_only_transactions' | 'cancellation' | 'monitoring' | 'read_only_account' | 'writable_server';
  available: boolean;
  detail: string;
}

export interface ConnectionTestReport {
  ok: boolean;
  testedAt: string;
  failure: { category: TestFailureCategory; message: string; code: string | null } | null;
  steps: TestStep[];
  server: { product: string; version: string } | null;
  tls: { mode: string; description: string; encrypted: boolean | null; protocol: string | null };
  capabilities: Capability[];
  warnings: string[];
}

const now = () => performance.now();
const ms = (start: number) => Math.round(performance.now() - start);

/** Opens and closes a TCP connection, so "cannot reach" is told apart from TLS and login failures. */
function reach(endpoint: Endpoint, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host: endpoint.host, port: endpoint.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new DbError('timeout', `No answer from ${endpoint.host}:${endpoint.port} within ${timeoutMs} ms.`),
      );
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const what =
        error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
          ? `Host ${endpoint.host} was not found.`
          : error.code === 'ECONNREFUSED'
            ? `Nothing accepts connections on ${endpoint.host}:${endpoint.port}.`
            : `Cannot reach ${endpoint.host}:${endpoint.port}: ${error.message}`;
      reject(new DbError('connectivity', what, { code: error.code ?? null }));
    });
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DbError('timeout', `${what} did not finish within ${timeoutMs} ms.`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

interface Probe {
  server: { product: string; version: string };
  encrypted: boolean | null;
  protocol: string | null;
  capabilities: Capability[];
  warnings: string[];
}

async function probePostgres(client: pg.Client, target: ConnectionTarget): Promise<Probe> {
  const q = async (sql: string) => (await client.query(sql)).rows[0] as Record<string, unknown>;
  const info = await q(`SELECT current_setting('server_version') AS version, pg_is_in_recovery() AS standby,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
           pg_has_role(current_user, 'pg_monitor', 'MEMBER') OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER') AS monitor`);
  const ssl = await q('SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()').catch(
    () => undefined,
  );
  await client.query('BEGIN TRANSACTION READ ONLY');
  const ro = await q('SHOW transaction_read_only');
  await client.query('ROLLBACK');
  const writable = await q(`SELECT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
           AND (has_table_privilege(c.oid, 'INSERT') OR has_table_privilege(c.oid, 'UPDATE')
                OR has_table_privilege(c.oid, 'DELETE') OR has_table_privilege(c.oid, 'TRUNCATE'))) AS can_write`);
  const t = (v: unknown) => v === true || v === 't';
  const superuser = t(info.superuser);
  const warnings: string[] = [];
  if (target.schema) {
    const schema = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [target.schema]);
    if (!schema.rowCount)
      warnings.push(`Schema ${target.schema} does not exist in database ${target.database}.`);
  }
  if (superuser)
    warnings.push('The database account is a superuser. Use an account with only the privileges it needs.');
  return {
    server: { product: 'PostgreSQL', version: String(info.version) },
    encrypted: ssl ? t(ssl.ssl) : null,
    protocol: ssl?.version ? String(ssl.version) : null,
    warnings,
    capabilities: [
      {
        name: 'read_only_transactions',
        available: ro.transaction_read_only === 'on',
        detail: 'BEGIN TRANSACTION READ ONLY is enforced by the server.',
      },
      { name: 'cancellation', available: true, detail: 'pg_cancel_backend on the account’s own sessions.' },
      {
        name: 'monitoring',
        available: superuser || t(info.monitor),
        detail:
          superuser || t(info.monitor)
            ? 'Sees all sessions and statistics (pg_monitor or superuser).'
            : 'Sees only its own sessions. Grant pg_monitor for full monitoring.',
      },
      {
        name: 'read_only_account',
        available: !superuser && !t(writable.can_write),
        detail:
          !superuser && !t(writable.can_write)
            ? 'The account cannot modify tables: a third barrier besides the workbench and read-only transactions.'
            : 'The account can modify tables. Prefer a read-only account for read-only connections.',
      },
      {
        name: 'writable_server',
        available: !t(info.standby),
        detail: t(info.standby)
          ? 'The server is a standby; writes are impossible.'
          : 'The server accepts writes.',
      },
    ],
  };
}

async function probeMysql(connection: mysql.Connection): Promise<Probe> {
  const q = (sql: string) =>
    new Promise<Record<string, unknown>[]>((resolve, reject) =>
      connection.query(sql, (error, rows) =>
        error ? reject(error) : resolve(rows as Record<string, unknown>[]),
      ),
    );
  const [info] = await q(
    'SELECT VERSION() AS version, @@read_only AS read_only, @@super_read_only AS super_read_only, @@performance_schema AS perf',
  );
  const [ssl] = await q("SHOW SESSION STATUS LIKE 'Ssl_version'");
  await q('START TRANSACTION READ ONLY');
  await q('ROLLBACK');
  const grants = (await q('SHOW GRANTS')).map((r) => String(Object.values(r)[0] ?? ''));
  const all = grants.join('\n').toUpperCase();
  const canWrite = /ALL PRIVILEGES|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bCREATE\b|\bALTER\b/.test(all);
  const process = /ALL PRIVILEGES|\bPROCESS\b/.test(all);
  const warnings: string[] = [];
  const global = grants
    .filter((g) => /\bON \*\.\*/i.test(g))
    .join('\n')
    .toUpperCase();
  if (/ALL PRIVILEGES|\bSUPER\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bCREATE\b/.test(global)) {
    warnings.push('The database account has write or administrative privileges on all databases (ON *.*).');
  }
  const protocol = ssl?.Value ? String(ssl.Value) : '';
  return {
    server: {
      product: /mariadb/i.test(String(info?.version)) ? 'MariaDB' : 'MySQL',
      version: String(info?.version),
    },
    encrypted: Boolean(protocol),
    protocol: protocol || null,
    warnings,
    capabilities: [
      {
        name: 'read_only_transactions',
        available: true,
        detail: 'START TRANSACTION READ ONLY is enforced by the server.',
      },
      { name: 'cancellation', available: true, detail: 'KILL QUERY on the account’s own threads.' },
      {
        name: 'monitoring',
        available: process && Number(info?.perf) === 1,
        detail: !process
          ? 'Sees only its own threads. Grant PROCESS for full monitoring.'
          : Number(info?.perf) === 1
            ? 'PROCESS privilege and performance_schema are available.'
            : 'performance_schema is off; statement statistics are unavailable.',
      },
      {
        name: 'read_only_account',
        available: !canWrite,
        detail: canWrite
          ? 'The account can modify data. Prefer a read-only account for read-only connections.'
          : 'The account cannot modify data: a third barrier besides the workbench and read-only transactions.',
      },
      {
        name: 'writable_server',
        available: Number(info?.read_only) !== 1 && Number(info?.super_read_only) !== 1,
        detail:
          Number(info?.read_only) === 1
            ? 'The server runs with read_only; writes are refused.'
            : 'The server accepts writes.',
      },
    ],
  };
}

/**
 * Tests a connection step by step on a fresh, unpooled connection: TCP reachability, then TLS and
 * login, then a probe of the server version and capabilities. Never returns the password.
 */
export async function testConnection(
  target: ConnectionTarget,
  endpoint: Endpoint,
  timeoutMs = 10_000,
): Promise<ConnectionTestReport> {
  const report: ConnectionTestReport = {
    ok: false,
    testedAt: new Date().toISOString(),
    failure: null,
    steps: [],
    server: null,
    tls: {
      mode: target.tlsMode,
      description: describeTls(target.tlsMode, Boolean(target.caPem)),
      encrypted: null,
      protocol: null,
    },
    capabilities: [],
    warnings: [],
  };
  const fail = (error: unknown, remaining: TestStepName[]) => {
    const e =
      error instanceof DbError
        ? error
        : target.engine === 'postgresql'
          ? mapPostgresError(error)
          : mapMysqlError(error);
    const category: TestFailureCategory = (
      ['connectivity', 'tls', 'authentication', 'configuration', 'timeout'] as const
    ).includes(e.category as never)
      ? (e.category as TestFailureCategory)
      : 'other';
    report.failure = { category, message: e.message, code: e.code };
    for (const name of remaining)
      report.steps.push({ name, status: 'skipped', durationMs: 0, detail: 'Not attempted.' });
    return report;
  };

  let start = now();
  try {
    await reach(endpoint, timeoutMs);
    report.steps.push({
      name: 'reach',
      status: 'ok',
      durationMs: ms(start),
      detail: `${endpoint.host}:${endpoint.port} accepts connections.`,
    });
  } catch (error) {
    report.steps.push({
      name: 'reach',
      status: 'failed',
      durationMs: ms(start),
      detail: (error as Error).message,
    });
    return fail(error, ['tls', 'authenticate', 'probe']);
  }

  start = now();
  let close: () => Promise<void> = async () => undefined;
  /** Drops a connection whose handshake never finished; a polite close would wait for the server. */
  let abort: () => void = () => undefined;
  let probe: () => Promise<Probe>;
  try {
    if (target.engine === 'postgresql') {
      const client = new pg.Client(
        postgresClientConfig(target, endpoint, timeoutMs, 'database-workbench (test)'),
      );
      client.on('error', () => undefined);
      close = () => client.end().catch(() => undefined);
      abort = () =>
        (
          client as unknown as { connection?: { stream?: { destroy(): void } } }
        ).connection?.stream?.destroy();
      await withTimeout(client.connect(), timeoutMs + 1000, 'Signing in');
      probe = () => probePostgres(client, target);
    } else {
      const refusal = mysqlVerifyFullProblem(target.tlsMode, endpoint.host);
      if (refusal) throw refusal;
      const connection = mysql.createConnection(mysqlConnectionOptions(target, endpoint, timeoutMs));
      connection.on('error', () => undefined);
      close = () => new Promise((resolve) => connection.end(() => resolve()));
      abort = () => connection.destroy();
      await withTimeout(
        new Promise<void>((resolve, reject) =>
          connection.connect((error) => (error ? reject(error) : resolve())),
        ),
        timeoutMs + 1000,
        'Signing in',
      );
      probe = () => probeMysql(connection);
    }
    const elapsed = ms(start);
    report.steps.push({
      name: 'tls',
      status: target.tlsMode === 'disable' ? 'skipped' : 'ok',
      durationMs: elapsed,
      detail: target.tlsMode === 'disable' ? 'TLS is disabled for this connection.' : report.tls.description,
    });
    report.steps.push({
      name: 'authenticate',
      status: 'ok',
      durationMs: elapsed,
      detail: `Signed in as ${target.username}.`,
    });
  } catch (error) {
    abort();
    await Promise.race([close(), new Promise((r) => setTimeout(r, 1000))]);
    const mapped =
      error instanceof DbError
        ? error
        : target.engine === 'postgresql'
          ? mapPostgresError(error)
          : mapMysqlError(error);
    if (mapped.category === 'tls') {
      report.steps.push({ name: 'tls', status: 'failed', durationMs: ms(start), detail: mapped.message });
      return fail(mapped, ['authenticate', 'probe']);
    }
    report.steps.push({
      name: 'tls',
      status: target.tlsMode === 'disable' ? 'skipped' : 'ok',
      durationMs: 0,
      detail: target.tlsMode === 'disable' ? 'TLS is disabled for this connection.' : report.tls.description,
    });
    report.steps.push({
      name: 'authenticate',
      status: 'failed',
      durationMs: ms(start),
      detail: mapped.message,
    });
    return fail(mapped, ['probe']);
  }

  start = now();
  try {
    const result = await withTimeout(probe(), timeoutMs, 'The capability probe');
    report.server = result.server;
    report.tls.encrypted = result.encrypted;
    report.tls.protocol = result.protocol;
    report.capabilities = result.capabilities;
    report.warnings = result.warnings;
    if (target.tlsMode !== 'disable' && result.encrypted === false)
      report.warnings.push('The connection is not encrypted.');
    report.steps.push({
      name: 'probe',
      status: 'ok',
      durationMs: ms(start),
      detail: `${result.server.product} ${result.server.version}`,
    });
    report.ok = true;
    return report;
  } catch (error) {
    report.steps.push({
      name: 'probe',
      status: 'failed',
      durationMs: ms(start),
      detail: (error as Error).message,
    });
    return fail(error, []);
  } finally {
    await close();
  }
}
