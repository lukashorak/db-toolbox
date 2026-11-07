# 0011. Fastify 5 with zod

Status: Accepted · 7 November 2026

## Context

The API needs request validation, typed routes, streaming downloads, static file serving and a place to mount the MCP transport.

## Decision

Use Fastify 5 with zod schemas. Express 5, used by the Codex prototype, was the alternative.

## Consequences

The MCP Streamable HTTP transport is attached to raw Node requests inside Fastify routes. The OpenAPI document is generated from the zod schemas.
