/**
 * Prints a Keycloak realm import for Database Workbench: realm roles and the two public PKCE
 * clients. It contains no users and no secrets.
 *
 *   npm run keycloak:realm -- --public-url https://db.example.com [--realm workbench] [--callback-port 8765] > realm.json
 *
 * Import it with the admin console (Create realm → Resource file) or
 * `kc.sh import --file realm.json`. Assign roles to users in Keycloak afterwards.
 */
import { parseArgs } from 'node:util';
import { buildRealm } from '@workbench/core';

const { values } = parseArgs({
  options: {
    'public-url': { type: 'string' },
    realm: { type: 'string', default: 'workbench' },
    'callback-port': { type: 'string', default: '8765' },
  },
});

const publicUrl = values['public-url'] ?? process.env.PUBLIC_URL;
if (!publicUrl) {
  process.stderr.write(
    'Pass --public-url (or set PUBLIC_URL), for example --public-url https://db.example.com\n',
  );
  process.exit(2);
}
const port = Number(values['callback-port']);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  process.stderr.write('--callback-port must be a port number between 1024 and 65535\n');
  process.exit(2);
}

process.stdout.write(
  `${JSON.stringify(buildRealm({ publicUrl, realm: values.realm, mcpCallbackPort: port }), null, 2)}\n`,
);
