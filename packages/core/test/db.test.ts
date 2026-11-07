import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapMysqlError, mapPostgresError } from '../src/db/errors.js';
import { describeTls, mysqlTls, mysqlVerifyFullProblem, postgresTls } from '../src/db/tls.js';
import { AppError } from '../src/domain/errors.js';
import { actor, admin, pgInput, testCore } from './helpers.js';

describe('database error mapping', () => {
  it('maps PostgreSQL SQLSTATEs to categories with detail and position', () => {
    const e = mapPostgresError({
      severity: 'ERROR',
      code: '42601',
      message: 'syntax error at or near "FROM"',
      position: '8',
      hint: 'Check it',
    });
    assert.equal(e.category, 'syntax');
    assert.equal(e.sqlState, '42601');
    assert.deepEqual(e.position, { offset: 7 });
    assert.equal(e.hint, 'Check it');
    const cases: [string, string, string][] = [
      ['57014', 'canceling statement due to statement timeout', 'timeout'],
      ['57014', 'canceling statement due to user request', 'cancelled'],
      ['25006', 'cannot execute UPDATE in a read-only transaction', 'read_only'],
      ['28P01', 'password authentication failed', 'authentication'],
      ['3D000', 'database "x" does not exist', 'configuration'],
      ['42501', 'permission denied for table t', 'permission'],
      ['23505', 'duplicate key value', 'constraint'],
      ['40P01', 'deadlock detected', 'conflict'],
    ];
    for (const [code, message, category] of cases) {
      assert.equal(mapPostgresError({ severity: 'ERROR', code, message }).category, category, code);
    }
  });

  it('maps MySQL error numbers, including the line of syntax errors', () => {
    const e = mapMysqlError({
      errno: 1064,
      sqlState: '42000',
      sqlMessage: "You have an error in your SQL syntax; check the manual near 'FRM t' at line 2",
    });
    assert.deepEqual([e.category, e.code, e.position?.line], ['syntax', '1064', 2]);
    assert.equal(
      mapMysqlError({ errno: 1792, sqlMessage: 'Cannot execute statement in a READ ONLY transaction.' })
        .category,
      'read_only',
    );
    assert.equal(mapMysqlError({ errno: 1045, sqlMessage: 'Access denied' }).category, 'authentication');
  });

  it('classifies transport failures', () => {
    assert.equal(
      mapPostgresError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1' }).category,
      'connectivity',
    );
    assert.equal(mapMysqlError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }).category, 'timeout');
    assert.equal(
      mapPostgresError({
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        message: "Hostname/IP does not match certificate's altnames",
      }).category,
      'tls',
    );
    assert.equal(
      mapPostgresError({
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
        message: 'self-signed certificate in certificate chain',
      }).category,
      'tls',
    );
  });
});

describe('TLS options', () => {
  const endpoint = { host: 'db.example.test', port: 5432, servername: 'db.example.test' };

  it('verifies chain and name only where the mode says so', () => {
    assert.equal(postgresTls({ mode: 'disable', caPem: null }, endpoint), false);
    assert.deepEqual(postgresTls({ mode: 'require', caPem: null }, endpoint), { rejectUnauthorized: false });
    const ca = postgresTls({ mode: 'verify-ca', caPem: 'PEM' }, endpoint);
    assert.ok(ca && ca.rejectUnauthorized && 'ca' in ca && ca.ca === 'PEM');
    const full = postgresTls({ mode: 'verify-full', caPem: null }, endpoint);
    assert.ok(
      full && full.rejectUnauthorized && 'servername' in full && full.servername === 'db.example.test',
    );
    assert.equal(mysqlTls({ mode: 'disable', caPem: null }), undefined);
    assert.deepEqual(mysqlTls({ mode: 'verify-full', caPem: 'PEM' }), {
      rejectUnauthorized: true,
      verifyIdentity: true,
      ca: 'PEM',
    });
    assert.deepEqual(mysqlTls({ mode: 'verify-ca', caPem: null }), {
      rejectUnauthorized: true,
      verifyIdentity: false,
    });
  });

  it('never sends an IP address as the TLS server name', () => {
    const full = postgresTls(
      { mode: 'verify-full', caPem: null },
      { host: '10.0.0.5', port: 5432, servername: '10.0.0.5' },
    );
    assert.ok(full && !('servername' in full));
  });

  it('refuses MySQL verify-full with an IP address', () => {
    assert.equal(mysqlVerifyFullProblem('verify-full', '10.0.0.5')?.category, 'tls');
    assert.equal(mysqlVerifyFullProblem('verify-full', 'db.example.test'), null);
    assert.equal(mysqlVerifyFullProblem('verify-ca', '10.0.0.5'), null);
  });

  it('describes each mode honestly', () => {
    assert.match(describeTls('require', false), /not verified/);
    assert.match(describeTls('verify-full', true), /host name verified against the custom CA/);
    assert.match(describeTls('disable', false), /Not encrypted/);
  });
});

describe('connection use', () => {
  it('rejects MySQL verify-full with an IP address when saving', () => {
    const core = testCore();
    assert.throws(
      () =>
        core.connections.create(admin, {
          ...pgInput,
          engine: 'mysql',
          schema: null,
          port: 3306,
          host: '10.0.0.5',
        }),
      (e: unknown) => e instanceof AppError && e.code === 'validation_failed',
    );
    const ok = core.connections.create(admin, {
      ...pgInput,
      engine: 'mysql',
      schema: null,
      port: 3306,
      host: '10.0.0.5',
      tlsMode: 'verify-ca',
    });
    assert.throws(
      () => core.connections.update(admin, ok.id, { tlsMode: 'verify-full' }),
      (e: unknown) => e instanceof AppError,
    );
  });

  it('lets MCP use only the profile’s connections, and nobody a disabled one', () => {
    const core = testCore();
    const allowed = core.connections.create(admin, pgInput);
    const other = core.connections.create(admin, { ...pgInput, name: 'Other' });
    const profile = core.profiles.create(admin, {
      name: 'Claude',
      clientId: 'workbench-mcp',
      connectionIds: [allowed.id],
    });
    const mcp = actor('u-1', ['query:read'], {
      source: 'mcp',
      clientId: 'workbench-mcp',
      profileId: profile.id,
    });
    assert.equal(core.databases.usable(mcp, allowed.id).id, allowed.id);
    assert.throws(
      () => core.databases.usable(mcp, other.id),
      (e: unknown) => e instanceof AppError && e.code === 'forbidden',
    );
    core.connections.setEnabled(admin, allowed.id, false);
    assert.throws(
      () => core.databases.usable(mcp, allowed.id),
      (e: unknown) => e instanceof AppError && e.code === 'connection_disabled',
    );
    assert.throws(
      () => core.databases.usable(admin, allowed.id),
      (e: unknown) => e instanceof AppError && e.code === 'connection_disabled',
    );
    core.close();
  });

  it('allows connection tests to administrators only', async () => {
    const core = testCore();
    const c = core.connections.create(admin, pgInput);
    await assert.rejects(
      core.databases.test(actor('reader', ['query:read']), c.id),
      (e: unknown) => e instanceof AppError && e.code === 'forbidden',
    );
    core.close();
  });
});
