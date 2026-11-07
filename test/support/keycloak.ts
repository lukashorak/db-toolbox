/**
 * Helpers for integration tests against a disposable Keycloak container
 * (scripts/integration/start.sh keycloak). Never point them at a shared Keycloak.
 */
import { createServer } from 'node:net';

export const KEYCLOAK_URL = process.env.KEYCLOAK_TEST_URL;

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

const form = (values: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(values),
});

export class KeycloakAdmin {
  constructor(
    private readonly baseUrl: string,
    private readonly username = process.env.KEYCLOAK_TEST_ADMIN ?? 'admin',
    private readonly password = process.env.KEYCLOAK_TEST_ADMIN_PASSWORD ?? 'admin',
  ) {}

  private async token(): Promise<string> {
    const response = await fetch(
      `${this.baseUrl}/realms/master/protocol/openid-connect/token`,
      form({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: this.username,
        password: this.password,
      }),
    );
    if (!response.ok) throw new Error(`Keycloak admin sign-in failed (${response.status})`);
    return ((await response.json()) as TokenResponse).access_token;
  }

  /** Replaces the realm with the given representation. */
  async importRealm(realm: Record<string, unknown>): Promise<void> {
    const headers = { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' };
    await this.deleteRealm(String(realm.realm));
    const response = await fetch(`${this.baseUrl}/admin/realms`, {
      method: 'POST',
      headers,
      body: JSON.stringify(realm),
    });
    if (response.status !== 201)
      throw new Error(`Realm import failed (${response.status}): ${await response.text()}`);
  }

  async deleteRealm(name: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/admin/realms/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await this.token()}` },
    });
    if (response.status !== 204 && response.status !== 404)
      throw new Error(`Realm delete failed (${response.status})`);
  }
}

export async function passwordGrant(issuer: string, clientId: string, username: string, password: string) {
  const response = await fetch(
    `${issuer}/protocol/openid-connect/token`,
    form({ grant_type: 'password', client_id: clientId, username, password, scope: 'openid' }),
  );
  return { status: response.status, body: (await response.json()) as TokenResponse };
}

export async function refreshGrant(issuer: string, clientId: string, refreshToken: string) {
  const response = await fetch(
    `${issuer}/protocol/openid-connect/token`,
    form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }),
  );
  return { status: response.status, body: (await response.json()) as TokenResponse };
}

export async function codeGrant(
  issuer: string,
  values: { clientId: string; code: string; redirectUri: string; codeVerifier: string },
) {
  const response = await fetch(
    `${issuer}/protocol/openid-connect/token`,
    form({
      grant_type: 'authorization_code',
      client_id: values.clientId,
      code: values.code,
      redirect_uri: values.redirectUri,
      code_verifier: values.codeVerifier,
    }),
  );
  return { status: response.status, body: (await response.json()) as TokenResponse };
}

/**
 * Plays the browser part of the authorization code flow: opens the authorization URL, submits
 * Keycloak's login form and returns the redirect back to the client (with `code` or `error`).
 */
export async function signInWithBrowser(
  authorizationUrl: URL,
  username: string,
  password: string,
): Promise<URL> {
  const jar = new Map<string, string>();
  const remember = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0] ?? '';
      const at = pair.indexOf('=');
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const cookies = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

  const page = await fetch(authorizationUrl, { redirect: 'manual' });
  remember(page);
  if (page.status === 302 || page.status === 303) return new URL(String(page.headers.get('location')));
  const html = await page.text();
  const action = /action="([^"]*login-actions\/authenticate[^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
  if (!action) throw new Error(`No login form on the authorization page (${page.status})`);

  const submitted = await fetch(action, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookies(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, credentialId: '' }),
  });
  if (submitted.status !== 302 && submitted.status !== 303) {
    throw new Error(`Sign-in did not redirect (${submitted.status})`);
  }
  return new URL(String(submitted.headers.get('location')));
}

/** Reserves a free local port so the public URL can be known before the server starts. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });
}
