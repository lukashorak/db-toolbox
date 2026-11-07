# 0004. Operations demo connection is writable at connection level

Status: Accepted · 7 November 2026

## Context

Demo and test fixtures need a MySQL connection that shows how MCP profile restrictions apply on top of a writable connection.

## Decision

The Operations (MySQL) fixture connection is writable at connection level; the analytics MCP profile makes it read-only for MCP calls.

## Consequences

Fixtures, screenshots and tests use this setup consistently.
