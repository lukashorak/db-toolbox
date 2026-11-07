# 0021. MCP profiles are shared and bound to an OAuth client

Status: Accepted · 7 November 2026

## Context

Administrators create MCP profiles. Each profile is bound to one Keycloak OAuth client, and the profile is resolved from the token's authorized party (`azp`). If a profile could only be used by the person who created it, only that administrator could use MCP.

## Decision

A profile is shared configuration. Any user who signs in through the bound client gets that profile. The user's own roles, the connection policy and the profile policy all apply, and the strongest restriction wins. The `owner` column records who created the profile, for audit. It does not restrict who may use it.

Different access levels use different clients. For example, `workbench-mcp` is bound to a read-only profile and `workbench-mcp-ops` to a writable one. Keycloak decides which users may obtain tokens for each client.

## Consequences

- A writable profile never grants writes on its own: the user still needs `query:write`, and the connection must be writable.
- Executions and audit events record the subject, the client and the profile, so shared use stays attributable.
- If per-user profile assignment is needed later, it can be added as an extra check without changing how the profile is resolved.
