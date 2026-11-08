# Target databases: adapters, read-only enforcement and metadata

Core code in `packages/core/src/sql/` (analysis) and `packages/core/src/db/` (adapters). Nothing outside core imports a database driver.

## Connections and pools

Each stored connection gets one adapter, opened on first use and replaced when the configuration changes. Its pools are bounded:

| Pool     | Size                                                  | Used for                                                     |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| work     | `concurrencyPerConnection` (2), shared by GUI and MCP | Executions                                                   |
| metadata | 1                                                     | Object browser, connection details                           |
| control  | 1                                                     | Cancellation (`pg_cancel_backend`, `KILL QUERY`), monitoring |

Cancellation works even when every work slot is busy. Idle connections close after 30 seconds.

A session goes back to the pool only when its state is known to be clean. It is closed instead when any of these happened:

- a statement changed session state (`SET`, `USE`, `PREPARE`, `LISTEN`);
- a statement was cancelled or timed out outside a transaction;
- the connection reported an error;
- the transaction could not be rolled back.

Transport is an interface. Direct TCP is the only implementation today, and an SSH tunnel can be added later without changing execution or authorization.

## TLS

| Mode          | Encrypted | Chain verified | Host name verified | Shown as                                         |
| ------------- | --------- | -------------- | ------------------ | ------------------------------------------------ |
| `verify-full` | yes       | yes            | yes                | Encrypted, certificate and host name verified    |
| `verify-ca`   | yes       | yes            | no                 | Encrypted, chain verified; host name not checked |
| `require`     | yes       | no             | no                 | Encrypted, server identity not verified          |
| `disable`     | no        | —              | —                  | Not encrypted                                    |

A custom CA (PEM) replaces the system trust store for that connection.

The MySQL driver checks certificate names only for host names, so MySQL `verify-full` needs a host name. With an IP address, use `verify-ca`. Saving such a connection is refused with a clear message.

## Connection test

The test runs on its own connection, outside the pools, and reports each step separately:

1. **reach** — TCP connection. A failure is `connectivity` (host not found, refused) or `timeout`.
2. **tls** — handshake and certificate checks (`tls`).
3. **authenticate** — sign-in: `authentication` (wrong password), `configuration` (database does not exist) or `timeout` (the server does not answer).
4. **probe** — server version and capabilities.

The report lists these capabilities:

- `read_only_transactions`
- `cancellation`
- `monitoring` — PostgreSQL `pg_monitor`; MySQL `PROCESS` and `performance_schema`.
- `read_only_account` — whether the account itself can modify data.
- `writable_server` — false on a standby or a server with `read_only`.

It also warns about privileged accounts. The report never contains the password. Stored tests are recorded on the connection and audited.

## Statement splitting

`splitStatements` is lexical and dialect-aware. Each statement comes with its offsets plus line and column, for the editor. A delimiter does not split inside any of these:

- strings: `''` and, in MySQL, `""`, with backslash escapes; PostgreSQL `E''` strings;
- quoted identifiers;
- comments: `--` (MySQL requires a space after it), MySQL `#`, and block comments (nested in PostgreSQL);
- PostgreSQL dollar quotes and `BEGIN ATOMIC … END` bodies.

MySQL `DELIMITER` lines change the delimiter, and are needed for procedure bodies, as in the MySQL client. A statement whose quote or comment is not closed is flagged and never runs.

## Classification

Every statement gets:

- a kind: `read`, `write`, `transaction`, `session` or `unknown`;
- whether it may run under a read-only policy (`readOnlySafe`), with reasons;
- whether it changes session state, probably returns rows, or controls transactions;
- MySQL implicit commit, and PostgreSQL "cannot run in a transaction block";
- the tables it writes to, and any declared storage engine.

PostgreSQL uses its real parser (libpg-query, WASM). MySQL uses keyword rules for commands whose nature does not depend on their content, and node-sql-parser for `SELECT`, `WITH` and DML. The corpus in `test/fixtures/classification.ts` covers indirect writes and bypass attempts, and runs in unit tests and against both databases.

How read-only is enforced, and where each engine's limits are: [decision 0022](decisions/0022-read-only-layers.md).

## Preflight

`preflight()` checks a whole script before anything runs. Any problem blocks the run.

| Code                       | When                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty_script`             | No statements                                                                                                                                                                                                                                                                                                                            |
| `incomplete_statement`     | A string, identifier or comment is not closed                                                                                                                                                                                                                                                                                            |
| `parse_error`              | Under a read-only policy, a statement cannot be parsed                                                                                                                                                                                                                                                                                   |
| `read_only_violation`      | Under a read-only policy, a statement is not read-only safe. The message names the policy source                                                                                                                                                                                                                                         |
| `transaction_control`      | `BEGIN`, `COMMIT`, `SAVEPOINT`, `SET autocommit`, `LOCK TABLES` … in an automatic mode                                                                                                                                                                                                                                                   |
| `implicit_commit`          | Single-transaction mode, MySQL statement that commits implicitly                                                                                                                                                                                                                                                                         |
| `no_transaction_block`     | Single-transaction mode, PostgreSQL `VACUUM`, `CREATE INDEX CONCURRENTLY` …                                                                                                                                                                                                                                                              |
| `non_transactional_engine` | Single-transaction mode, MySQL write to a MyISAM, MEMORY … table, or `ENGINE=` that cannot roll back                                                                                                                                                                                                                                     |
| `unsupported_statement`    | `COPY`, cursors, two-phase commit, XA, `HANDLER`, changing the client encoding to anything but UTF-8 (PostgreSQL `SET client_encoding`, `SET NAMES` and `set_config('client_encoding', …)`; MySQL `SET NAMES`, `SET CHARACTER SET` and `character_set_client` other than `utf8mb4`), since the drivers exchange SQL and results as UTF-8 |

## Execution primitives

`DbSession.execute` streams rows in batches to a sink, which can stop reading at any point (the preview capture stops after 1,001 rows). Statements run with a server-side time limit (PostgreSQL `statement_timeout`; MySQL `KILL QUERY` on a timer) and can be cancelled through an `AbortSignal`. A cancel travels over another connection, so it cannot end a wait on a connection that stopped answering without closing (a network partition, a frozen host): when the statement's connection stays silent for 5 s after a cancel or the time limit, it is closed and the statement ends as a lost connection (`connectivity`, outcome `unknown` for a write). The same bound covers the commands around statements: `BEGIN`, `COMMIT` and the session label wait for the execution's cancel or time limit, then for the grace period; a `ROLLBACK` and the reset before a session goes back to the pool get the grace period alone (closing the connection rolls back too). Cancel requests themselves give up after 5 s without an answer; that control connection is closed, so a stalled one cannot hold up later cancels or shutdown.

Values are lossless text, and binary values are `\x` hex ([decision 0023](decisions/0023-values-as-text.md)), also when PostgreSQL's `bytea_output` is `escape`. MySQL procedures can return several result sets. Notices and warnings are collected with the outcome.

Errors map to a category with the engine's code (SQLSTATE or MySQL error number), message, detail, hint and position. The categories are `syntax`, `permission`, `read_only`, `not_found`, `constraint`, `conflict`, `timeout`, `cancelled`, `connectivity`, `authentication` and others. A statement's `timeout` is one the server confirmed (or its time limit); a socket or driver timeout on an open connection is `connectivity`, because what was in flight may have been applied. Only a timeout while connecting is `timeout`.

The execution engine (queue, capture, transaction modes) is built on these primitives in step 4.

## Metadata

Each list states whether it is complete:

- `ok` — the full list, which may really be empty;
- `insufficient_permission` — the database restricts what the account may see or use;
- `unavailable` — the object does not exist or is not visible.

| Engine     | What is listed                                                                                                                                                             | Permission behaviour                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL | Databases; schemas (USAGE flag); tables, partitioned and foreign tables, views, materialized views, functions, procedures, aggregates; columns, keys, indexes, definitions | Catalogs are readable, so objects are listed with an `accessible` flag. A schema without USAGE is `insufficient_permission`. Table definitions are reconstructed from the catalog and marked so. |
| MySQL      | Databases, tables (with engine), views, procedures, functions; columns, keys, indexes; `SHOW CREATE` definitions                                                           | MySQL hides objects the account has no privileges on, so a missing object is "not visible". A view or routine definition the account may not read is `insufficient_permission`.                  |

Extension-owned PostgreSQL objects are left out of object lists.

## Running the integration tests

```sh
scripts/integration/start.sh postgres mysql    # TLS with a throwaway CA; prints the variables
POSTGRES_TEST_URL=postgres://postgres:workbench-it@localhost:15432/postgres \
MYSQL_TEST_URL=mysql://root:workbench-it@localhost:13306/mysql \
INTEGRATION_CERTS=$PWD/.integration/certs npm run test:integration
scripts/integration/stop.sh
```
