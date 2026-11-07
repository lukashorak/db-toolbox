import type { FastifyInstance } from 'fastify';
import { AppError, type Authenticator, type Config, type Core } from '@workbench/core';
import { handleMcpRequest, MCP_PATH, protectedResourceMetadata } from '@workbench/mcp';

export interface McpRouteOptions {
  config: Config;
  core: Core;
  authenticator: Authenticator;
  version: string;
}

/**
 * Streamable HTTP MCP endpoint. It is stateless: each POST is authenticated on its own and the
 * profile is resolved from the token's OAuth client, never from anything the client sends.
 */
export function mcpRoutes(options: McpRouteOptions) {
  const { config, core, authenticator, version } = options;
  const metadata = protectedResourceMetadata(config);
  return async (app: FastifyInstance) => {
    // RFC 9728 path-insertion form for the resource `${PUBLIC_URL}/mcp`, plus the root form that
    // some clients try first.
    for (const url of [
      `/.well-known/oauth-protected-resource${MCP_PATH}`,
      '/.well-known/oauth-protected-resource',
    ]) {
      app.get(url, async (_request, reply) => {
        reply.header('cache-control', 'public, max-age=300');
        return metadata;
      });
    }

    app.post(MCP_PATH, async (request, reply) => {
      const actor = await authenticator.authenticate(request.headers.authorization, 'mcp');
      reply.hijack();
      try {
        await handleMcpRequest(request.raw, reply.raw, request.body, actor, { core, version });
      } catch (error) {
        request.log.error({ err: error }, 'mcp request failed');
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'content-type': 'application/json' });
          reply.raw.end(
            JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }),
          );
        } else {
          reply.raw.end();
        }
      }
    });

    // Stateless server: no standalone SSE stream and no sessions to delete.
    app.route({
      method: ['GET', 'DELETE'],
      url: MCP_PATH,
      handler: async (_request, reply) => {
        reply.header('allow', 'POST');
        throw new AppError('method_not_allowed', 'This MCP endpoint accepts POST requests only.');
      },
    });
  };
}
