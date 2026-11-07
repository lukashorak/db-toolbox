/**
 * Deployment test (AC14): the production image started with deploy/compose.yaml, its read-only and
 * non-root settings, migration on first start, an online backup, a graceful stop, a restore with
 * the CLI, and logs free of credentials. Needs a built image (DEPLOY_TEST_IMAGE), Docker Compose,
 * and the Keycloak and PostgreSQL test containers (scripts/integration/start.sh keycloak postgres).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { buildRealm } from '@workbench/core';
import { preparePostgres, targetFrom } from '../support/databases.js';
import { freePort, KEYCLOAK_URL, KeycloakAdmin, passwordGrant } from '../support/keycloak.js';
import { skipUnless } from '../support/services.js';

const run = promisify(execFile);
const REALM = 'workbench-deploy-it';

describe(
  'compose deployment',
  {
    skip:
      skipUnless('DEPLOY_TEST_IMAGE') || skipUnless('KEYCLOAK_TEST_URL') || skipUnless('POSTGRES_TEST_URL'),
  },
  () => {
    const pgUrl = String(process.env.POSTGRES_TEST_URL);
    const keycloak = new KeycloakAdmin(String(KEYCLOAK_URL));
    const userPassword = randomUUID();
    const encryptionKey = randomBytes(32).toString('base64');
    let dir: string;
    let base: string;
    let token: string;
    const ids: Record<string, string> = {};

    const compose = async (...args: string[]) => {
      const { stdout, stderr } = await run(
        'docker',
        ['compose', '-f', 'compose.yaml', '-f', 'compose.test.yaml', ...args],
        { cwd: dir, maxBuffer: 32 * 1024 * 1024 },
      );
      return stdout + stderr;
    };
    /** Runs a command and returns its exit code and output instead of throwing. */
    const attempt = async (...args: string[]) => {
      try {
        return { code: 0, output: await compose(...args) };
      } catch (error) {
        const e = error as { code?: number; stdout?: string; stderr?: string };
        return { code: Number(e.code ?? 1), output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    };
    const cli = (verb: 'exec' | 'run', ...args: string[]) =>
      attempt(
        ...(verb === 'exec' ? ['exec', '-T', 'workbench'] : ['run', '--rm', '-T', '--no-deps', 'workbench']),
        'node',
        '--disable-warning=ExperimentalWarning',
        'packages/api/dist/cli.js',
        ...args,
      );
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    async function healthy() {
      const end = Date.now() + 60_000;
      for (;;) {
        const ready = await fetch(`${base}/readyz`).then(
          (r) => r.ok,
          () => false,
        );
        if (ready) return;
        if (Date.now() > end) throw new Error(`not ready:\n${await compose('logs', '--no-color')}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    before(async () => {
      await preparePostgres(pgUrl);
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      await keycloak.importRealm(
        buildRealm({
          publicUrl: base,
          realm: REALM,
          testing: {
            users: [
              { username: 'ops', password: userPassword, roles: ['query:read', 'query:write', 'admin'] },
            ],
          },
        }),
      );
      dir = await mkdtemp(join(tmpdir(), 'workbench-deploy-'));
      await copyFile('deploy/compose.yaml', join(dir, 'compose.yaml'));
      await writeFile(
        join(dir, '.env'),
        [
          `WORKBENCH_IMAGE=${process.env.DEPLOY_TEST_IMAGE}`,
          `PUBLIC_URL=${base}`,
          `KEYCLOAK_ISSUER=${KEYCLOAK_URL}/realms/${REALM}`,
          `ENCRYPTION_KEY=${encryptionKey}`,
          'SHUTDOWN_GRACE_MS=5000',
          'LOG_LEVEL=info',
        ].join('\n'),
      );
      // The test containers listen on the host's loopback, so the workbench joins the host network.
      // Keycloak runs without TLS here, which production configuration refuses.
      await writeFile(
        join(dir, 'compose.test.yaml'),
        [
          'services:',
          '  workbench:',
          '    network_mode: host',
          '    ports: !reset []',
          '    environment:',
          '      NODE_ENV: test',
          '      HOST: 127.0.0.1',
          `      PORT: '${port}'`,
        ].join('\n'),
      );
      for (const folder of ['data', 'exports']) {
        await mkdir(join(dir, folder));
        // As the compose file's header says: the folders belong to the image's user (1000).
        await run(process.getuid?.() === 0 ? 'chown' : 'sudo', [
          ...(process.getuid?.() === 0 ? [] : ['-n', 'chown']),
          '1000:1000',
          join(dir, folder),
        ]);
      }
      await compose('up', '-d');
      await healthy();
      const grant = await passwordGrant(
        `${KEYCLOAK_URL}/realms/${REALM}`,
        'workbench-gui',
        'ops',
        userPassword,
      );
      assert.equal(grant.status, 200);
      token = grant.body.access_token;
    });
    after(async () => {
      if (dir) {
        await attempt('down', '--volumes', '--timeout', '5');
        // Files written by the container belong to uid 1000.
        await run('docker', [
          'run',
          '--rm',
          '-v',
          `${dir}:/stack`,
          '--entrypoint',
          'sh',
          String(process.env.DEPLOY_TEST_IMAGE),
          '-c',
          'rm -rf /stack/data/* /stack/data/.[!.]* /stack/exports/*',
        ]).catch(() => undefined);
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
      await keycloak.deleteRealm(REALM).catch(() => undefined);
    });

    it('runs as a non-root user on a read-only root file system, with migrations applied', async () => {
      const container = (await compose('ps', '-q', 'workbench')).trim();
      const { stdout } = await run('docker', [
        'inspect',
        '--format',
        '{{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{json .HostConfig.CapDrop}}',
        container,
      ]);
      assert.equal(stdout.trim(), 'true node ["ALL"]');
      assert.equal((await compose('exec', '-T', 'workbench', 'id', '-u')).trim(), '1000');
      const write = await attempt('exec', '-T', 'workbench', 'sh', '-c', 'touch /app/x');
      assert.notEqual(write.code, 0, 'the application files are not writable');
      const migrate = await cli('exec', 'migrate', '--json');
      assert.equal(migrate.code, 0, migrate.output);
      assert.ok(JSON.parse(migrate.output.trim().split('\n').at(-1) as string).schemaVersion >= 1);
    });

    it('backs up online, stops gracefully, restores with the CLI and starts again', async () => {
      const t = targetFrom(pgUrl, 'postgresql');
      const created = await api('POST', '/connections', {
        name: 'Deployed',
        engine: 'postgresql',
        environment: 'development',
        host: t.host,
        port: t.port,
        database: t.database,
        schema: 'public',
        username: t.username,
        password: t.password,
        tlsMode: 'verify-full',
        caPem: t.caPem,
        readOnly: false,
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      ids.connection = created.body.id;
      assert.equal((await api('POST', '/queries', { name: 'Kept', sql: 'SELECT 1' })).status, 201);

      const backup = await cli('exec', 'backup', '/data/backups/deploy.sqlite', '--json');
      assert.equal(backup.code, 0, backup.output);
      assert.equal((await api('POST', '/queries', { name: 'After backup', sql: 'SELECT 2' })).status, 201);

      const busy = await cli('exec', 'restore', '/data/backups/deploy.sqlite');
      assert.notEqual(busy.code, 0);
      assert.match(busy.output, /Stop it before restoring/);
      const wrongKey = await attempt(
        'run',
        '--rm',
        '-T',
        '--no-deps',
        '-e',
        `ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
        'workbench',
        'node',
        'packages/api/dist/cli.js',
        'verify',
        '/data/backups/deploy.sqlite',
      );
      assert.notEqual(wrongKey.code, 0);
      assert.match(wrongKey.output, /Encryption key: mismatch/);

      // An open event stream (as a GUI tab keeps) must not hold the shutdown until Docker kills it.
      const stream = await fetch(`${base}/api/v1/events`, { headers: { authorization: `Bearer ${token}` } });
      const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /retry: 3000/);
      const stopping = Date.now();
      await compose('stop', 'workbench');
      assert.ok(Date.now() - stopping < 10_000, 'stopped well within the 30 s grace period');
      assert.equal((await reader.read().catch(() => ({ done: true }))).done, true, 'the stream was ended');
      const container = (await compose('ps', '-a', '-q', 'workbench')).trim();
      const { stdout: exit } = await run('docker', ['inspect', '--format', '{{.State.ExitCode}}', container]);
      assert.equal(exit.trim(), '0', 'stopped on SIGTERM, not killed');
      assert.match(await compose('logs', '--no-color', 'workbench'), /"msg":"stopped"/);

      const restore = await cli('run', 'restore', '/data/backups/deploy.sqlite', '--json');
      assert.equal(restore.code, 0, restore.output);
      assert.match(restore.output, /before-restore/);

      await compose('start', 'workbench');
      await healthy();
      const names = (await api('GET', '/queries')).body.map((q: { name: string }) => q.name);
      assert.deepEqual(names, ['Kept'], 'the change after the backup is gone');
      // The restored credentials still open with the key in .env, which never went into the backup.
      const test = await api('POST', `/connections/${ids.connection}/test`, {});
      assert.equal(test.status, 200, JSON.stringify(test.body));
      assert.equal(test.body.ok, true, JSON.stringify(test.body));
    });

    it('keeps credentials and tokens out of the logs', async () => {
      const execution = await api('POST', '/executions', {
        connectionId: ids.connection,
        sql: 'SELECT 42 AS answer',
        requestKey: 'deploy-log-check-1',
      });
      assert.equal(execution.status, 201, JSON.stringify(execution.body));
      const logs = await compose('logs', '--no-color', 'workbench');
      assert.match(logs, /database workbench started/);
      const t = targetFrom(pgUrl, 'postgresql');
      const secrets: [string, string][] = [
        ['encryption key', encryptionKey],
        ['database password', t.password],
        ['user password', userPassword],
        ['access token', token],
        ['token signature', String(token.split('.')[2])],
      ];
      for (const [label, secret] of secrets) {
        assert.ok(!logs.includes(secret), `the logs contain the ${label}`);
      }
      assert.doesNotMatch(logs, /authorization":\s*"Bearer/i);
    });
  },
);
