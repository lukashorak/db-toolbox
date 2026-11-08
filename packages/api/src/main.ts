import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppError,
  Authenticator,
  ConfigError,
  createCore,
  createLogger,
  DATABASE_FILE,
  loadConfig,
  SchemaTooNewError,
  markAlive,
  markStopped,
  TokenVerifier,
  type Config,
  type Core,
} from '@workbench/core';
import { describeMcpEndpoint } from '@workbench/mcp';
import { buildServer } from './index.js';

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\nSee .env.example for the expected variables.\n`);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
const logger = createLogger({ level: config.logLevel });
for (const [name, dir] of [
  ['DATA_DIR', config.dataDir],
  ['EXPORT_DIR', config.exportDir],
] as const) {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch {
    const uid = process.getuid?.();
    process.stderr.write(
      `${name} (${dir}) is not writable by this process${uid === undefined ? '' : ` (uid ${uid})`}. ` +
        `With a bind mount, give the folder to that user, for example: chown ${uid ?? 1000}:${uid ?? 1000} <folder>\n`,
    );
    process.exit(1);
  }
}

// Release images set WORKBENCH_VERSION (the Git tag); a checkout reports package.json.
const version =
  process.env.WORKBENCH_VERSION ||
  (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string })
    .version;
function openCore(): Core {
  try {
    return createCore({
      databaseFile: join(config.dataDir, DATABASE_FILE),
      encryptionKey: config.encryptionKey,
      limits: config.limits,
      exportDir: config.exportDir,
    });
  } catch (error) {
    if (
      (error instanceof AppError && error.code === 'encryption_key_mismatch') ||
      error instanceof SchemaTooNewError
    ) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const core = openCore();
const reconciled = core.executions.reconcile();
if (reconciled.interrupted)
  logger.warn(reconciled, 'executions interrupted by the restart were not run again');
core.executions.resume();
// Retention: expire captured results and old execution metadata.
const cleanup = setInterval(() => {
  core.cleanup().then(
    (removed) => {
      if (removed.exportsExpired || removed.resultsExpired || removed.executionsDeleted)
        logger.info(removed, 'retention cleanup');
    },
    (error: unknown) => logger.error({ err: error }, 'retention cleanup failed'),
  );
}, 10 * 60_000);
cleanup.unref();
// Lets a restore (scripts and the CLI) see that a server is using the database.
markAlive(core.db, new Date());
const heartbeat = setInterval(() => markAlive(core.db, new Date()), 15_000);
heartbeat.unref();
const verifier = new TokenVerifier({
  issuer: config.keycloakIssuer,
  guiClientId: config.guiClientId,
  apiAudience: config.apiAudience,
  mcpAudience: config.mcpAudience,
});
const authenticator = new Authenticator(verifier, { users: core.users, profiles: core.profiles });
const app = await buildServer(config, { logger, core, authenticator, version });

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal, graceMs: config.shutdownGraceMs }, 'shutting down');
  clearInterval(cleanup);
  clearInterval(heartbeat);
  try {
    // Running executions may finish while the API still answers status requests; new work stays
    // queued for the next start. What is still running after the grace period is interrupted.
    await core.executions.stop(config.shutdownGraceMs);
    await app.close();
    markStopped(core.db);
    await core.shutdown();
    logger.info('stopped');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'shutdown failed');
    process.exit(1);
  }
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
logger.info(
  { publicUrl: config.publicUrl, mcp: describeMcpEndpoint(config).url, env: config.env, version },
  'database workbench started',
);
