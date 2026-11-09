# 0019. node:test, containers for integration, Playwright end-to-end

Status: Accepted · 7 November 2026

## Context

Behavior must be verified against real engines and a real Keycloak, not only mocks.

## Decision

Use `node:test` with `tsx` for unit tests, PostgreSQL 16, MySQL 8.4 and Keycloak containers for integration tests, and Playwright for end-to-end tests.

## Consequences

Each acceptance criterion gets an automated test by step 14.
