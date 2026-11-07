import { mkdirSync } from 'node:fs';
import { ConfigError, createLogger, loadConfig, type Config } from '@workbench/core';
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

const app = await buildServer(config, { logger });

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
logger.info(
  { publicUrl: config.publicUrl, mcp: describeMcpEndpoint(config).url, env: config.env },
  'database workbench started',
);
