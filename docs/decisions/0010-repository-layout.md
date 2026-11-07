# 0010. npm workspaces with enforced module boundaries

Status: Accepted · 7 November 2026

## Context

The requirements describe three logical components (API and core, MCP integration, GUI) in one repository and one image. The MCP adapter must not implement its own permission system or reach databases directly.

## Decision

Use npm workspaces: `packages/core`, `packages/api`, `packages/mcp`, `packages/web`. ESLint `no-restricted-imports` rules enforce the boundaries, and a test proves the rules.

## Consequences

Only `core` uses database drivers. `api` and `mcp` import the public `@workbench/core` entry point only; `mcp` never imports `api`; the browser app talks to the server over HTTP only.
