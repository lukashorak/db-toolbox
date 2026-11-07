import type { Config } from '@workbench/core';

/** Path of the MCP endpoint under the public origin. The tools arrive in step 7. */
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
