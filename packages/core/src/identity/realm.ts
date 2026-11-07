import { ROLES, type Role } from '../domain/types.js';

export interface RealmOptions {
  /** Origin of the workbench, for example https://db.example.com (no path). */
  publicUrl: string;
  realm?: string;
  guiClientId?: string;
  mcpClientId?: string;
  apiAudience?: string;
  /** Local callback port Claude Code listens on during the OAuth flow. */
  mcpCallbackPort?: number;
  /**
   * For disposable test realms only: enables the password grant on both clients and creates
   * users. Never use for a real deployment.
   */
  testing?: { users: { username: string; password: string; roles: Role[] }[] };
}

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  'query:read': 'Run read-only SQL, browse metadata, save queries and decide on MCP disclosure',
  'query:write': 'Run modifying SQL where the connection and MCP profile allow it',
  'monitor:read': 'View target database monitoring',
  admin: 'Manage connections, MCP profiles and settings; does not grant database writes',
};

const audienceMapper = (audience: string) => ({
  name: `audience ${audience}`,
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-mapper',
  consentRequired: false,
  config: {
    'included.custom.audience': audience,
    'access.token.claim': 'true',
    'id.token.claim': 'false',
    'introspection.token.claim': 'true',
  },
});

/**
 * Builds a Keycloak realm representation for import. It only generates configuration and never
 * contacts Keycloak. Both clients are public clients with PKCE S256; each adds its own audience so
 * that GUI tokens are rejected at the MCP endpoint and MCP tokens are rejected by the API.
 * Audience mappers sit on the clients instead of custom client scopes, so Keycloak keeps its
 * built-in default scopes (basic, profile, email, roles, web-origins).
 */
export function buildRealm(options: RealmOptions): Record<string, unknown> {
  const url = new URL(options.publicUrl);
  if (url.pathname !== '/' || url.search || url.hash)
    throw new Error('publicUrl must be an origin without a path');
  const origin = url.origin;
  const port = options.mcpCallbackPort ?? 8765;
  const testing = options.testing;
  const client = (clientId: string, extra: Record<string, unknown>) => ({
    clientId,
    enabled: true,
    protocol: 'openid-connect',
    publicClient: true,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: Boolean(testing),
    serviceAccountsEnabled: false,
    fullScopeAllowed: true,
    ...extra,
  });
  return {
    realm: options.realm ?? 'workbench',
    displayName: 'Database Workbench',
    enabled: true,
    registrationAllowed: false,
    loginWithEmailAllowed: true,
    accessTokenLifespan: 300,
    roles: { realm: ROLES.map((name) => ({ name, description: ROLE_DESCRIPTIONS[name] })) },
    clients: [
      client(options.guiClientId ?? 'workbench-gui', {
        name: 'Database Workbench',
        rootUrl: origin,
        baseUrl: '/',
        redirectUris: [`${origin}/auth/callback`],
        webOrigins: [origin],
        attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': `${origin}/*` },
        protocolMappers: [audienceMapper(options.apiAudience ?? 'workbench-api')],
      }),
      client(options.mcpClientId ?? 'workbench-mcp', {
        name: 'Database Workbench MCP (Claude Code)',
        redirectUris: [`http://localhost:${port}/callback`, `http://127.0.0.1:${port}/callback`],
        webOrigins: [],
        attributes: { 'pkce.code.challenge.method': 'S256' },
        protocolMappers: [audienceMapper(`${origin}/mcp`)],
      }),
    ],
    ...(testing
      ? {
          users: testing.users.map((u) => ({
            username: u.username,
            enabled: true,
            emailVerified: true,
            firstName: u.username,
            lastName: 'Test',
            email: `${u.username}@example.test`,
            credentials: [{ type: 'password', value: u.password, temporary: false }],
            realmRoles: u.roles,
          })),
        }
      : {}),
  };
}
