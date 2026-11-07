# 0013. pg with pg-cursor; mysql2 streaming

Status: Accepted · 7 November 2026

## Context

Results must stream without loading everything into memory, and preview capture must stop after 1,001 rows.

## Decision

Use `pg` with `pg-cursor` for PostgreSQL and `mysql2` with streaming for MySQL.

## Consequences

Adapters live in `core` behind a transport interface so SSH can be added later.
