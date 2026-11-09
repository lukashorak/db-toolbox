# 0015. Official MCP SDK over Streamable HTTP

Status: Accepted · 7 November 2026

## Context

Claude Code and other MCP clients connect over authenticated HTTP.

## Decision

Use the official `@modelcontextprotocol/sdk` with the Streamable HTTP transport at `/mcp`.

## Consequences

Tool names, input schemas, error codes and structured outputs are kept stable and tested with the official client.
