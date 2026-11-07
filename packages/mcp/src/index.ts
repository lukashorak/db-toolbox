import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AppError, type Actor, type Config, type Core } from '@workbench/core';

/** Path of the MCP endpoint under the public origin. */
export const MCP_PATH = '/mcp';

export interface McpEndpoint {
  url: string;
  /** Token audience Keycloak must issue for MCP clients. */
  audience: string;
  clientId: string;
}

/**
 * Describes the MCP endpoint for this deployment. The URL and the token audience are the same
 * value so that discovery, OAuth and the Claude Code setup snippet always agree.
 */
export function describeMcpEndpoint(
  config: Pick<Config, 'publicUrl' | 'mcpAudience' | 'mcpClientId'>,
): McpEndpoint {
  return {
    url: `${config.publicUrl}${MCP_PATH}`,
    audience: config.mcpAudience,
    clientId: config.mcpClientId,
  };
}

/** OAuth 2.0 protected resource metadata (RFC 9728) that MCP clients use to find Keycloak. */
export function protectedResourceMetadata(config: Pick<Config, 'mcpAudience' | 'keycloakIssuer'>) {
  return {
    resource: config.mcpAudience,
    authorization_servers: [config.keycloakIssuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['openid', 'profile', 'email'],
    resource_name: 'Database Workbench',
  };
}

export interface McpDeps {
  core: Core;
  version: string;
}

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

const failure = (error: unknown) => ({
  isError: true,
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify({
        code: error instanceof AppError ? error.code : 'internal',
        message: error instanceof AppError ? error.message : 'The operation failed.',
      }),
    },
  ],
});

/**
 * Builds the MCP server for one authenticated request. Every tool delegates to core services
 * with the request's actor, so MCP has no permission system of its own. Step 2 exposes only
 * `whoami` to prove authentication end to end; step 7 adds the workbench tools.
 */
export function buildMcpServer(actor: Actor, deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'database-workbench', version: deps.version });
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Shows the signed-in user, the MCP profile bound to this OAuth client and the effective read/write access per connection. Returns no credentials.',
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const profile = deps.core.profiles.get(actor, actor.profileId ?? '');
        const access = deps.core.profiles.effectiveAccess(actor, profile.id).filter((a) => a.allowed);
        return result({
          user: { subject: actor.subject, username: actor.username, roles: actor.roles },
          profile: {
            id: profile.id,
            name: profile.name,
            readOnly: profile.readOnly,
            limits: {
              timeoutMs: profile.timeoutMs,
              previewRows: profile.previewRows,
              previewBytes: profile.previewBytes,
            },
          },
          connections: access.map((a) => ({
            id: a.connectionId,
            name: a.connectionName,
            readOnly: a.policy?.readOnly ?? true,
            restrictedBy: a.policy?.sources ?? [],
          })),
          tokenExpiresAt: actor.expiresAt ?? null,
        });
      } catch (error) {
        return failure(error);
      }
    },
  );
  return server;
}

/** Handles one stateless Streamable HTTP request. Execution lifetime never depends on it. */
export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  actor: Actor,
  deps: McpDeps,
): Promise<void> {
  const server = buildMcpServer(actor, deps);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response, body);
}
