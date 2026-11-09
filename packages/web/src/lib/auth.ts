import { UserManager, WebStorageStateStore, type User } from 'oidc-client-ts';

export interface ClientConfig {
  issuer: string;
  clientId: string;
  scope: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  mcp: { url: string; audience: string; clientId: string };
}

let manager: UserManager | null = null;
const listeners = new Set<(reason: 'expired' | 'renew_failed') => void>();

export async function loadClientConfig(): Promise<ClientConfig> {
  const response = await fetch('/api/v1/client-config', { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`The server did not provide its sign-in settings (${response.status}).`);
  return (await response.json()) as ClientConfig;
}

/**
 * Sign-in through Keycloak with the authorization code flow and PKCE (decision 0017). The app never
 * shows a password form. Tokens live in session storage so a reload keeps the session; refresh
 * tokens renew them silently.
 */
export function initAuth(config: ClientConfig, store: Storage = sessionStorage): UserManager {
  manager = new UserManager({
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    response_type: 'code',
    scope: config.scope,
    automaticSilentRenew: true,
    loadUserInfo: false,
    userStore: new WebStorageStateStore({ store }),
  });
  manager.events.addAccessTokenExpired(() => listeners.forEach((l) => l('expired')));
  manager.events.addSilentRenewError(() => listeners.forEach((l) => l('renew_failed')));
  return manager;
}

export function onSessionLost(listener: (reason: 'expired' | 'renew_failed') => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function required(): UserManager {
  if (!manager) throw new Error('Sign-in is not initialised.');
  return manager;
}

export async function currentUser(): Promise<User | null> {
  const user = await required().getUser();
  return user && !user.expired ? user : null;
}

/** Sends the browser to Keycloak and returns to `returnTo` afterwards. */
export async function signIn(returnTo = location.pathname + location.search): Promise<void> {
  await required().signinRedirect({ state: { returnTo } });
}

/** Completes the redirect back from Keycloak; returns where to go next. */
export async function completeSignIn(): Promise<string> {
  const user = await required().signinRedirectCallback();
  const state = user.state as { returnTo?: string } | undefined;
  return state?.returnTo && state.returnTo.startsWith('/') && !state.returnTo.startsWith('/auth/')
    ? state.returnTo
    : '/';
}

export async function signOut(): Promise<void> {
  await required().signoutRedirect();
}

/** A valid access token, renewing it first when it is about to expire. */
export async function accessToken(): Promise<string> {
  const m = required();
  let user = await m.getUser();
  if (user && (user.expires_in ?? 0) < 30) {
    try {
      user = await m.signinSilent();
    } catch {
      // Fall through: the caller sees the session as lost.
    }
  }
  if (!user || user.expired) throw new SessionLostError();
  return user.access_token;
}

export class SessionLostError extends Error {
  constructor() {
    super('Your session has ended.');
    this.name = 'SessionLostError';
  }
}
