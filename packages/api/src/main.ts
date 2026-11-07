import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppError,
  Authenticator,
  ConfigError,
  createCore,
  createLogger,
  DATABASE_FILE,
  loadConfig,
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
mkdirSync(config.dataDir, { recursive: true });
mkdirSync(config.exportDir, { recursive: true });

const { version } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
function openCore(): Core {
  try {
    return createCore({
      databaseFile: join(config.dataDir, DATABASE_FILE),
      encryptionKey: config.encryptionKey,
      limits: config.limits,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === 'encryption_key_mismatch') {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

const core = openCore();
const verifier = new TokenVerifier({
  issuer: config.keycloakIssuer,
  guiClientId: config.guiClientId,
  apiAudience: config.apiAudience,
  mcpAudience: config.mcpAudience,
});
const authenticator = new Authenticator(verifier, { users: core.users, profiles: core.profiles });
const app = await buildServer(config, { logger, core, authenticator, version });

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await core.shutdown();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
logger.info(
  { publicUrl: config.publicUrl, mcp: describeMcpEndpoint(config).url, env: config.env, version },
  'database workbench started',
);
