import { resolve } from 'node:path';
import { z } from 'zod';
import { Store } from '../core/store.js';
import { SecretBox } from '../core/secrets.js';
import { Workbench } from '../core/service.js';
import { MysqlAdapter, PostgresAdapter } from '../core/adapters.js';
import { createApp } from './app.js';
import { createAuthenticator } from './auth.js';

const env = z
  .object({
    KEYCLOAK_ISSUER: z.url(),
    GUI_CLIENT_ID: z.string().default('workbench-gui'),
    API_AUDIENCE: z.string().default('workbench-api'),
    PUBLIC_URL: z.url(),
    ENCRYPTION_KEY: z.string().min(1),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATA_DIR: z.string().default('./data'),
    EXPORT_DIR: z.string().default('./exports'),
    MAX_RESULT_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(100 * 1024 * 1024),
    MAX_TOTAL_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .default(1024 * 1024 * 1024),
  })
  .parse(process.env);
for (const value of [env.KEYCLOAK_ISSUER, env.PUBLIC_URL]) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Use HTTPS for non-localhost public and Keycloak URLs.');
}
const config = {
  issuer: env.KEYCLOAK_ISSUER.replace(/\/$/, ''),
  guiClientId: env.GUI_CLIENT_ID,
  apiAudience: env.API_AUDIENCE,
  publicUrl: env.PUBLIC_URL.replace(/\/$/, ''),
  mcpAudience: env.PUBLIC_URL.replace(/\/$/, '') + '/mcp',
};
const store = new Store(
  resolve(env.DATA_DIR, 'workbench.sqlite'),
  new SecretBox(env.ENCRYPTION_KEY),
);
const core = new Workbench(
  store,
  { postgres: new PostgresAdapter(), mysql: new MysqlAdapter() },
  resolve(env.EXPORT_DIR),
  { maxResultBytes: env.MAX_RESULT_BYTES, maxTotalBytes: env.MAX_TOTAL_BYTES },
);
await core.cleanup();
const maintenance = setInterval(() => {
  void core.cleanup().catch(() => process.stderr.write('Retention cleanup failed.\n'));
}, 60_000);
maintenance.unref();
const app = createApp(core, createAuthenticator(config, store), config);
const server = app.listen(env.PORT, '0.0.0.0', () =>
  process.stdout.write(`Database Workbench listening on port ${env.PORT}\n`),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(maintenance);
  server.close();
  await core.shutdown();
  store.close();
  process.exit(0);
}
process.on('SIGINT', () => {
  void shutdown();
});
process.on('SIGTERM', () => {
  void shutdown();
});
