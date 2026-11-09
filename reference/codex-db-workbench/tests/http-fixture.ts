import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../src/api/app.js';
import { createAuthenticator } from '../src/api/auth.js';
import { fixture, human } from './helpers.js';

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
export async function httpFixture() {
  const f = await fixture();
  const keys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const identity = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        req.url?.endsWith('/certs')
          ? { keys: [jwk] }
          : {
              issuer: `http://127.0.0.1:${identity.address() && (identity.address() as any).port}/realms/workbench`,
              jwks_uri: `http://127.0.0.1:${(identity.address() as any).port}/realms/workbench/protocol/openid-connect/certs`,
            },
      ),
    );
  });
  const identityPort = await listen(identity);
  const issuer = `http://127.0.0.1:${identityPort}/realms/workbench`;
  const config = {
    issuer,
    guiClientId: 'workbench-gui',
    apiAudience: 'workbench-api',
    publicUrl: 'http://127.0.0.1',
    mcpAudience: 'http://127.0.0.1/mcp',
  };
  const server = createServer();
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  config.publicUrl = url;
  config.mcpAudience = url + '/mcp';
  server.on('request', createApp(f.core, createAuthenticator(config, f.store), config));
  const token = async (channel: 'gui' | 'mcp', overrides: Record<string, unknown> = {}) =>
    new SignJWT({
      azp: channel === 'gui' ? config.guiClientId : f.profile.clientId,
      realm_access: { roles: human.roles },
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(issuer)
      .setSubject(String(overrides.sub ?? human.subject))
      .setAudience(
        String(overrides.aud ?? (channel === 'gui' ? config.apiAudience : config.mcpAudience)),
      )
      .setIssuedAt()
      .setExpirationTime(Number(overrides.exp ?? Math.floor(Date.now() / 1000) + 3600))
      .sign(keys.privateKey);
  const guiToken = await token('gui');
  const mcpToken = await token('mcp');
  const request = async (path: string, options: RequestInit = {}, authorization = guiToken) => {
    const response = await fetch(url + path, {
      ...options,
      headers: {
        Authorization: `Bearer ${authorization}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return {
    ...f,
    url,
    config,
    guiToken,
    mcpToken,
    token,
    request,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      identity.closeAllConnections();
      await new Promise<void>((resolve) => identity.close(() => resolve()));
      await f.close();
    },
  };
}
