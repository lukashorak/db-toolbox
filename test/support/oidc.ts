import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';

export const ISSUER = 'https://auth.example.test/realms/workbench';
export const PUBLIC_URL = 'https://db.example.test';
export const API_AUDIENCE = 'workbench-api';
export const MCP_AUDIENCE = `${PUBLIC_URL}/mcp`;
export const GUI_CLIENT = 'workbench-gui';
export const MCP_CLIENT = 'workbench-mcp';

export interface TokenOptions {
  subject: string;
  roles?: string[];
  audience?: string | string[];
  clientId?: string;
  issuer?: string;
  /** Seconds from now; negative for an expired token. */
  expiresIn?: number;
  claims?: Record<string, unknown>;
}

export interface TestIssuer {
  jwks: JWTVerifyGetKey;
  /** A token for the GUI channel (audience workbench-api, client workbench-gui) unless overridden. */
  gui(options: TokenOptions): Promise<string>;
  /** A token for the MCP channel (audience PUBLIC_URL/mcp, client workbench-mcp) unless overridden. */
  mcp(options: TokenOptions): Promise<string>;
  /** Signed by a key that is not in the JWKS. */
  foreign(options: TokenOptions): Promise<string>;
}

/** A local stand-in for Keycloak's signing keys, shaped like Keycloak access tokens. */
export async function createTestIssuer(): Promise<TestIssuer> {
  const own = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(own.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const jwks = createLocalJWKSet({ keys: [jwk] });

  type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  const sign = (key: SigningKey, defaults: { audience: string; clientId: string }) => (o: TokenOptions) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      typ: 'Bearer',
      azp: o.clientId ?? defaults.clientId,
      preferred_username: o.subject,
      name: `${o.subject} Test`,
      email: `${o.subject}@example.test`,
      realm_access: { roles: o.roles ?? ['query:read'] },
      ...o.claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })
      .setIssuer(o.issuer ?? ISSUER)
      .setSubject(o.subject)
      .setAudience(o.audience ?? defaults.audience)
      .setIssuedAt(now - 5)
      .setExpirationTime(now + (o.expiresIn ?? 300))
      .sign(key);
  };

  return {
    jwks,
    gui: sign(own.privateKey, { audience: API_AUDIENCE, clientId: GUI_CLIENT }),
    mcp: sign(own.privateKey, { audience: MCP_AUDIENCE, clientId: MCP_CLIENT }),
    foreign: sign(other.privateKey, { audience: API_AUDIENCE, clientId: GUI_CLIENT }),
  };
}
