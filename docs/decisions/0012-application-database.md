# 0012. Built-in node:sqlite with WAL

Status: Accepted · 7 November 2026

## Context

SQLite stores configuration, history, audit events and result chunks on a local volume.

## Decision

Use Node's built-in `node:sqlite` (no native addon) with WAL, a busy timeout, foreign keys and versioned migrations.

## Consequences

Node may print an experimental warning for `node:sqlite`; start scripts suppress it. better-sqlite3 remains a fallback if the built-in module proves insufficient.
