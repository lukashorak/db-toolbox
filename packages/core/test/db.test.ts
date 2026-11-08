import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { afterInterruption, DbError, mapMysqlError, mapPostgresError } from '../src/db/errors.js';
import { settlesWithin, StallGuard } from '../src/db/stall.js';
import { describeTls, mysqlTls, mysqlVerifyFullProblem, postgresTls } from '../src/db/tls.js';
import { triggerVisible } from '../src/db/mysql.js';
import { byteaHex } from '../src/db/postgres.js';
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
      mapPostgresError({ message: 'Connection terminated due to connection timeout' }).category,
      'timeout',
    );
    assert.equal(
      mapPostgresError({ message: 'timeout exceeded when trying to connect' }).category,
      'timeout',
    );
    assert.equal(mapPostgresError({ message: 'timeout expired' }).category, 'timeout');
    // On an open connection, a timeout is a lost connection: what was in flight may have been applied.
    const quiet = { code: 'ETIMEDOUT', errno: -110, syscall: 'read', message: 'read ETIMEDOUT' };
    assert.equal(mapMysqlError(quiet).category, 'connectivity');
    assert.equal(mapPostgresError(quiet).category, 'connectivity');
    assert.equal(mapPostgresError({ message: 'Query read timeout' }).category, 'connectivity');
    assert.equal(
      mapMysqlError({ code: 'PROTOCOL_SEQUENCE_TIMEOUT', message: 'Query inactivity timeout' }).category,
      'connectivity',
    );
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

describe('MySQL TRIGGER visibility from SHOW GRANTS', () => {
  const user = '`u`@`%`';
  it('counts global, schema and table grants', () => {
    assert.equal(triggerVisible([`GRANT TRIGGER ON *.* TO ${user}`], 'app', 't'), true);
    assert.equal(triggerVisible([`GRANT SELECT, TRIGGER ON \`app\`.* TO ${user}`], 'app', 't'), true);
    assert.equal(triggerVisible([`GRANT ALL PRIVILEGES ON \`app\`.\`t\` TO ${user}`], 'app', 't'), true);
    assert.equal(triggerVisible([`GRANT TRIGGER ON \`app\`.\`other\` TO ${user}`], 'app', 't'), false);
    assert.equal(triggerVisible([`GRANT SELECT, INSERT ON \`app\`.* TO ${user}`], 'app', 't'), false);
  });

  it('applies a partial revoke to the global grant only', () => {
    const global = `GRANT TRIGGER ON *.* TO ${user}`;
    const revoke = `REVOKE TRIGGER ON \`app\`.* FROM ${user}`;
    assert.equal(triggerVisible([global, revoke], 'app', 't', true), false);
    assert.equal(triggerVisible([global, revoke], 'other', 't', true), true);
    assert.equal(
      triggerVisible([global, revoke, `GRANT TRIGGER ON \`app\`.\`t\` TO ${user}`], 'app', 't', true),
      true,
      'a table-level grant restores what the partial revoke took',
    );
  });

  it('reads schema wildcards literally when partial revokes are on', () => {
    const grant = [`GRANT TRIGGER ON \`app_%\`.* TO ${user}`];
    assert.equal(triggerVisible(grant, 'app_1', 't'), true);
    assert.equal(triggerVisible(grant, 'appx1', 't'), true);
    assert.equal(triggerVisible(grant, 'app_1', 't', true), false);
    assert.equal(triggerVisible([`GRANT TRIGGER ON \`app\\_1\`.* TO ${user}`], 'appx1', 't'), false);
    assert.equal(triggerVisible([`GRANT TRIGGER ON \`app\\_1\`.* TO ${user}`], 'app_1', 't', true), true);
  });
});

describe('errors after a cancel or the time limit', () => {
  const lost = new DbError('connectivity', 'Connection lost', { code: 'ECONNRESET' });
  const failed = new DbError('syntax', 'Syntax error', { code: '42601', sqlState: '42601' });
  it('keeps a lost connection, whichever came first: the statement may have committed', () => {
    const quiet = mapPostgresError({ code: 'ETIMEDOUT', syscall: 'read', message: 'read ETIMEDOUT' });
    for (const interrupted of ['cancelled', 'timeout', null] as const) {
      assert.equal(afterInterruption(lost, interrupted, 1000).category, 'connectivity', String(interrupted));
      assert.equal(afterInterruption(quiet, interrupted, 1000).category, 'connectivity', String(interrupted));
    }
  });

  it('reports a confirmed cancel or timeout otherwise, keeping the engine code', () => {
    const cancelled = afterInterruption(failed, 'cancelled', 1000);
    assert.deepEqual([cancelled.category, cancelled.code], ['cancelled', '42601']);
    const timedOut = afterInterruption(failed, 'timeout', 1000);
    assert.deepEqual(
      [timedOut.category, timedOut.message],
      ['timeout', 'The statement exceeded its time limit of 1000 ms.'],
    );
    // The server's own timeout counts as one too; anything else is left as it was.
    assert.equal(afterInterruption(new DbError('timeout', 'statement timeout'), null, 5).category, 'timeout');
    assert.equal(afterInterruption(failed, null, 1000), failed);
  });
});

describe('connections that stop answering', () => {
  const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  /** A wait that only `abandon` (closing the connection) ends. */
  const silent = () => {
    let end: (error: Error) => void = () => undefined;
    const wait = new Promise<never>((_, reject) => (end = reject));
    return { wait, end: () => end(new Error('Connection terminated unexpectedly')) };
  };

  it('closes the connection when a wait outlasts the grace period after an interruption', async () => {
    const read = silent();
    let closed = 0;
    const guard = new StallGuard(() => {
      closed++;
      read.end();
    }, 20);
    const waiting = guard.wait(read.wait).catch((e: Error) => e.message);
    await later(40);
    assert.equal(closed, 0, 'a long wait without an interruption is left alone');
    guard.interrupted();
    assert.equal(await waiting, 'Connection terminated unexpectedly');
    assert.deepEqual([closed, guard.abandoned, guard.error().category], [1, true, 'connectivity']);
  });

  it('leaves a connection that answers in time, and starts the grace period with the next wait', async () => {
    const read = silent();
    let closed = 0;
    const guard = new StallGuard(() => {
      closed++;
      read.end();
    }, 30);
    guard.interrupted();
    await later(50);
    assert.equal(closed, 0, 'nothing was waiting');
    assert.equal(await guard.wait(later(10).then(() => 'answered')), 'answered');
    await later(40);
    assert.equal(closed, 0, 'the timer stops with the wait');
    await guard.wait(read.wait).catch(() => undefined);
    assert.equal(closed, 1);
  });

  it('tells whether a promise settles in time', async () => {
    assert.equal(await settlesWithin(Promise.reject(new Error('x')), 50), true);
    assert.equal(await settlesWithin(new Promise(() => undefined), 20), false);
  });
});

describe('PostgreSQL bytea', () => {
  it('is always the hex form, also when bytea_output is escape', () => {
    assert.equal(byteaHex('\\xff00'), '\\xff00');
    // escape form: octal for bytes outside printable ASCII, a doubled backslash, printable as is
    assert.equal(byteaHex('\\377\\000\\\\A'), '\\xff005c41');
    assert.equal(byteaHex(''), '\\x');
  });
});
