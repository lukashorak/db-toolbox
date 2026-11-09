# 0017. oidc-client-ts with authorization code flow and PKCE

Status: Accepted · 7 November 2026

## Context

The GUI signs in through the existing Keycloak instance with a public client.

## Decision

Use `oidc-client-ts` with the authorization code flow and PKCE S256 for client `workbench-gui`.

## Consequences

The application never shows its own password form. Token refresh and expiry are handled in the client, and the API validates every token.
