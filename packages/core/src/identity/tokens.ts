import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../domain/errors.js';
import { ROLES, type Clock, type Role } from '../domain/types.js';

export type Channel = 'gui' | 'mcp';

export interface TokenVerifierOptions {
  /** Keycloak realm issuer, for example https://auth.example.com/realms/workbench */
  issuer: string;
  guiClientId: string;
  /** Audience required on GUI and API tokens. */
  apiAudience: string;
  /** Audience required on MCP tokens: `${PUBLIC_URL}/mcp`. */
  mcpAudience: string;
  /** Key source; defaults to the realm's JWKS endpoint with caching. Tests pass a local key set. */
  jwks?: JWTVerifyGetKey;
  clockToleranceSeconds?: number;
  /** Time source for expiry checks; tests use it to check expiry of real tokens. */
  clock?: Clock;
}

export interface VerifiedToken {
  subject: string;
  username: string;
  displayName: string;
  email: string | null;
  roles: Role[];
  /** OAuth client that obtained the token (`azp`). */
  clientId: string;
  expiresAt: string;
}

const KNOWN_ROLES = new Set<string>(ROLES);

function rolesOf(payload: JWTPayload, clientId: string): Role[] {
  const realm = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
  const client = (payload.resource_access as Record<string, { roles?: unknown }> | undefined)?.[clientId]
    ?.roles;
  const all = [...(Array.isArray(realm) ? realm : []), ...(Array.isArray(client) ? client : [])];
  return [...new Set(all.filter((r): r is Role => typeof r === 'string' && KNOWN_ROLES.has(r)))];
}

/**
 * Validates Keycloak access tokens: signature (JWKS, cached and refreshed on key rotation),
 * issuer, audience for the channel, expiry and authorized client. Each failure maps to a stable
 * error code so clients know whether to refresh, sign in again or fix configuration.
 */
export class TokenVerifier {
  readonly #options: TokenVerifierOptions;
  readonly #jwks: JWTVerifyGetKey;

  constructor(options: TokenVerifierOptions) {
    this.#options = options;
    this.#jwks =
      options.jwks ??
      createRemoteJWKSet(new URL(`${options.issuer}/protocol/openid-connect/certs`), {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
      });
  }

  async verify(token: string, channel: Channel): Promise<VerifiedToken> {
    const o = this.#options;
    const audience = channel === 'gui' ? o.apiAudience : o.mcpAudience;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#jwks, {
        issuer: o.issuer,
        audience,
        algorithms: ['RS256', 'PS256', 'ES256'],
        requiredClaims: ['exp', 'iat', 'sub', 'azp'],
        clockTolerance: o.clockToleranceSeconds ?? 30,
        ...(o.clock ? { currentDate: o.clock.now() } : {}),
      }));
    } catch (error) {
      if (error instanceof errors.JWTExpired) {
        throw new AppError('token_expired', 'The access token has expired. Refresh it or sign in again.');
      }
      if (error instanceof errors.JWTClaimValidationFailed && error.claim === 'aud') {
        throw new AppError(
          'wrong_audience',
          channel === 'gui'
            ? `This token is not meant for the workbench API (expected audience ${audience}).`
            : `This token is not meant for the MCP endpoint (expected audience ${audience}).`,
        );
      }
      if (error instanceof errors.JWTClaimValidationFailed && error.claim === 'iss') {
        throw new AppError('invalid_token', 'The access token was issued by another identity provider.');
      }
      throw new AppError('invalid_token', 'The access token is invalid.');
    }
    const clientId = String(payload.azp);
    if (channel === 'gui' && clientId !== o.guiClientId) {
      throw new AppError(
        'wrong_client',
        `Tokens for the workbench API must come from client ${o.guiClientId}.`,
      );
    }
    if (payload.typ !== undefined && payload.typ !== 'Bearer') {
      throw new AppError('invalid_token', 'Only access tokens are accepted.');
    }
    const username = String(payload.preferred_username ?? payload.sub);
    return {
      subject: String(payload.sub),
      username,
      displayName: typeof payload.name === 'string' && payload.name.trim() ? payload.name : username,
      email: typeof payload.email === 'string' ? payload.email : null,
      roles: rolesOf(payload, clientId),
      clientId,
      expiresAt: new Date(Number(payload.exp) * 1000).toISOString(),
    };
  }
}
