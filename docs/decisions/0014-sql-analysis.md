# 0014. Own splitter; libpg-query and node-sql-parser; reject when unsure

Status: Accepted · 7 November 2026

## Context

Read-only enforcement must not rely on checking whether SQL starts with SELECT.

## Decision

Use an own dialect-aware statement splitter, the PostgreSQL parser through `libpg-query` (WASM), and `node-sql-parser` for MySQL. When parsing fails under a read-only policy, reject.

## Consequences

Database-level read-only transactions remain a second barrier, and restricted database accounts the strongest one.
