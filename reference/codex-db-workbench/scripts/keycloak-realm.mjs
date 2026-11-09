// Generate configuration only. This script never modifies a Keycloak instance.
const publicUrl = new URL(process.argv[2] ?? 'https://db.example.com');
if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash)
  throw new Error('Use an origin URL without a path, query, or fragment.');
const origin = publicUrl.origin;
const scope = (name, audience) => ({
  name,
  protocol: 'openid-connect',
  attributes: { 'include.in.token.scope': 'true', 'display.on.consent.screen': 'false' },
  protocolMappers: [
    {
      name: 'workbench-audience',
      protocol: 'openid-connect',
      protocolMapper: 'oidc-audience-mapper',
      consentRequired: false,
      config: {
        'included.custom.audience': audience,
        'id.token.claim': 'false',
        'access.token.claim': 'true',
      },
    },
  ],
});
const client = (clientId, redirectUris, scopes, webOrigins = []) => ({
  clientId,
  enabled: true,
  protocol: 'openid-connect',
  publicClient: true,
  standardFlowEnabled: true,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: false,
  redirectUris,
  webOrigins,
  fullScopeAllowed: true,
  attributes: { 'pkce.code.challenge.method': 'S256' },
  defaultClientScopes: ['profile', 'roles', 'web-origins', ...scopes],
  optionalClientScopes: ['email', 'offline_access'],
});
const realm = {
  realm: 'db-workbench',
  displayName: 'Database Workbench',
  enabled: true,
  registrationAllowed: false,
  resetPasswordAllowed: true,
  accessTokenLifespan: 300,
  roles: {
    realm: [
      { name: 'admin', description: 'Manage workbench connections and MCP profiles' },
      { name: 'query:read', description: 'Query and read allowed databases' },
      {
        name: 'query:write',
        description: 'Execute modifying SQL where connection and MCP profile allow it',
      },
      { name: 'monitor:read', description: 'Read target database monitoring views' },
    ],
  },
  clientScopes: [scope('workbench:api', 'workbench-api'), scope('workbench:mcp', origin + '/mcp')],
  clients: [
    client('workbench-gui', [origin + '/auth/callback'], ['workbench:api'], [origin]),
    client(
      'workbench-mcp',
      ['http://localhost:8765/callback', 'http://127.0.0.1:8765/callback'],
      ['workbench:mcp'],
    ),
  ],
};
realm.clients[0].attributes['post.logout.redirect.uris'] = origin + '/*';
process.stdout.write(JSON.stringify(realm, null, 2) + '\n');
