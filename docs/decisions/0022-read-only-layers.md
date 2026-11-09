# 0022. Read-only enforcement layers and their limits

Status: Accepted · 7 November 2026

## Context

A read-only policy (from the user, the connection or the MCP profile) must hold even when the database account could write. Integration tests against PostgreSQL 16 and MySQL 8.4 showed how far each engine's read-only transaction reaches:

- PostgreSQL `BEGIN TRANSACTION READ ONLY` rejects DML, DDL, `SELECT … INTO`, `SELECT … FOR UPDATE/SHARE`, `nextval()` and `EXPLAIN ANALYZE` of writes.
- MySQL `START TRANSACTION READ ONLY` rejects DML, including on MyISAM tables. It does **not** stop DDL: `CREATE`, `DROP`, `TRUNCATE`, `ALTER` and `RENAME` commit the transaction implicitly and then run.

## Decision

Three layers, each enough on its own for the cases it covers:

1. **Classification before execution.** Every statement is parsed (libpg-query for PostgreSQL; keyword rules plus node-sql-parser for MySQL). Under a read-only policy, writes, side-effect functions (for example `dblink`, `set_config`, `pg_terminate_backend`, `GET_LOCK`, `LOAD_FILE`), locking reads, file output, settings that would turn read-only off, and anything that cannot be parsed are rejected before anything runs. MySQL executable comments (`/*! … */`) are analysed as if they run.
2. **A read-only transaction** around every statement that runs under a read-only policy. It catches writes hidden in user-defined functions and procedures.
3. **The database account.** A read-only account is the only layer that also covers MySQL DDL hidden where the classifier cannot see it. The connection test reports whether the account can write.

## Consequences

- MySQL DDL under a read-only policy relies on layers 1 and 3. Layer 1 rejects DDL by statement type, so this matters only for SQL the classifier misreads. The integration suite keeps a test showing that MySQL runs DDL inside a read-only transaction, so a change in this behaviour becomes visible.
- Unparsable SQL is never run under a read-only policy. Without one, the database reports its own syntax error.
- User-defined functions are allowed in read-only SQL, because the read-only transaction (layer 2) limits what they can do.
