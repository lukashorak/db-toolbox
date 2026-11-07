/**
 * Operations commands. In the container:
 *   docker compose exec workbench node packages/api/dist/cli.js backup
 *   docker compose stop workbench
 *   docker compose run --rm workbench node packages/api/dist/cli.js restore /data/backups/<file>
 * They read the same environment as the server (DATA_DIR, ENCRYPTION_KEY, ...).
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  AppError,
  backupDatabase,
  buildRealm,
  ConfigError,
  Database,
  DATABASE_FILE,
  inspectBackup,
  loadConfig,
  restoreDatabase,
} from '@workbench/core';

const USAGE = `Usage: node packages/api/dist/cli.js <command> [--json]

  backup [file]    Online backup of the application database, safe while the server runs.
                   Default: $DATA_DIR/backups/workbench-<UTC time>.sqlite
  verify <file>    Check a backup: integrity, schema version, and whether ENCRYPTION_KEY
                   opens the credentials stored in it.
  restore <file>   Replace the application database with a backup. Stop the server first;
                   the replaced file is kept next to it.
  migrate          Apply pending migrations and print the schema version (the server also
                   does this when it starts).
  realm --public-url <url> [--realm workbench] [--callback-port 8765]
                   Print the Keycloak realm import (roles and the two public PKCE clients; no
                   users, no secrets). Needs no other configuration.

Backups contain sealed credentials but never ENCRYPTION_KEY. Keep the key separately.
`;

const args = process.argv.slice(2);
const json = args.includes('--json');
const [command, file] = args.filter((a) => a !== '--json');

function print(result: Record<string, unknown>, lines: string[]) {
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${lines.join('\n')}\n`);
}
function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function main() {
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (command === 'realm') {
    const { values } = parseArgs({
      args: process.argv.slice(3),
      options: {
        'public-url': { type: 'string' },
        realm: { type: 'string', default: 'workbench' },
        'callback-port': { type: 'string', default: '8765' },
      },
    });
    const publicUrl = values['public-url'] ?? process.env.PUBLIC_URL;
    if (!publicUrl)
      fail('Pass --public-url (or set PUBLIC_URL), for example --public-url https://db.example.com', 2);
    const port = Number(values['callback-port']);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      fail('--callback-port must be a port number between 1024 and 65535', 2);
    process.stdout.write(
      `${JSON.stringify(buildRealm({ publicUrl, realm: values.realm, mcpCallbackPort: port }), null, 2)}\n`,
    );
    return;
  }
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }
  const live = join(config.dataDir, DATABASE_FILE);
  switch (command) {
    case 'backup': {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = resolve(file ?? join(config.dataDir, 'backups', `workbench-${stamp}.sqlite`));
      const report = await backupDatabase(live, target);
      print({ ...report }, [
        `Backup written: ${report.file} (${report.bytes} bytes, schema version ${report.schemaVersion}).`,
        'It does not contain ENCRYPTION_KEY; a restore needs the key that is active now.',
      ]);
      return;
    }
    case 'verify': {
      if (!file) fail(USAGE, 2);
      const inspection = inspectBackup(resolve(file), config.encryptionKey);
      print({ ...inspection, ok: inspection.problems.length === 0 }, [
        `Integrity: ${inspection.integrity}`,
        `Schema version: ${inspection.schemaVersion} (this release: ${inspection.latestVersion})`,
        `Encryption key: ${inspection.key}`,
        ...(inspection.problems.length
          ? inspection.problems.map((p) => `Problem: ${p}`)
          : ['Usable for restore.']),
      ]);
      if (inspection.problems.length) process.exitCode = 1;
      return;
    }
    case 'restore': {
      if (!file) fail(USAGE, 2);
      const report = restoreDatabase(live, resolve(file), config.encryptionKey);
      print({ ...report }, [
        `Restored ${resolve(file)} to ${live}.`,
        report.previous
          ? `The replaced database was kept as ${report.previous}.`
          : 'There was no database before.',
        report.migratedFrom < report.schemaVersion
          ? `Migrated from schema version ${report.migratedFrom} to ${report.schemaVersion}.`
          : `Schema version ${report.schemaVersion}.`,
        'Start the server again.',
      ]);
      return;
    }
    case 'migrate': {
      const db = Database.open(live);
      const version = db.schemaVersion;
      db.close();
      print({ schemaVersion: version }, [`Schema version ${version}.`]);
      return;
    }
    default:
      fail(`Unknown command: ${command}\n\n${USAGE}`, 2);
  }
}

main().catch((error: unknown) => {
  if (error instanceof AppError) fail(error.message);
  fail(error instanceof Error ? error.message : String(error));
});
