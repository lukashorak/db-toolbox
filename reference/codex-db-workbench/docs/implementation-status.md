# Implementation status

Baseline: 7 November 2026. Package version: 0.1.0. This is an initial development milestone, not the completed v1 requirements or a production deployment.

## Implemented

| Area           | Current behavior                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Components     | Shared TypeScript core, Express API, official SDK HTTP MCP adapter, Svelte GUI; one deployable application image.                                                                                                                             |
| Identity       | Keycloak-compatible signed JWT validation, issuer/audience/expiry/client checks, separate GUI and MCP clients, role checks and owner isolation. Offline realm configuration generator.                                                        |
| Permissions    | Read-only restrictions combine across user, connection and MCP profile. Profiles bind to an OAuth client and connection allowlist. Conservative SQL analysis plus database read-only transactions.                                            |
| Connections    | Encrypted PostgreSQL/MySQL credentials in SQLite; direct TCP or TLS with certificate verification; connection test; edit and disable.                                                                                                         |
| Execution      | Server-owned queue, configurable concurrency and timeout, cancellation, selected SQL or complete active tab, per-statement and atomic transaction modes. SQLite history and restart interruption recovery.                                    |
| Results        | Preview of at most 1,000 rows; explicit full execution; bounded capture into SQLite chunks; separate CSV/JSON exports from complete retained results; no export-triggered SQL replay.                                                         |
| MCP disclosure | Preview has row and byte limits across the execution. Larger retrieval and export download require an expiring, revocable GUI approval for that exact result and profile. Creating an export grants no disclosure permission.                 |
| GUI            | SQL tabs, results, saved query names and folder paths, history, connections, profiles, disclosure approval/revocation, basic explorer and monitoring views.                                                                                   |
| Monitoring     | Fixed queries for active sessions, blocking, global counters and aggregate expensive SQL. PostgreSQL requires relevant statistics access/pg_stat_statements; MySQL uses Performance Schema. Missing capabilities are surfaced as unavailable. |
| Operations     | Result retention, cleanup, storage limits, encrypted credentials, audit records, health endpoint, Dockerfile, Compose configuration and setup documentation.                                                                                  |

## Validation

- TypeScript and Svelte static checks, plus production asset compilation.
- 31 core/API/MCP tests: permissions, SQL splitting and precision, execution outcomes, complete 1,200-row CSV/JSON exports, no export replay, expiry, storage quotas, idempotency, identity/client checks, official MCP client calls and disclosure approval.
- PostgreSQL TCP driver integration against PGlite's wire server: 0/250/500/1,200-row cursor boundaries, exact numeric values, duplicate column names, read-only transactions and rollback. PGlite runs PostgreSQL compiled to WASM; this is not a native production database deployment.
- Chromium browser smoke: preview, full capture, complete JSON download, separate MCP approval, query saving, history and narrow viewport layout. Authentication uses signed test tokens and a local JWKS fixture, not a live Keycloak login.

Native PostgreSQL testing is included but skips when the operating-system user is root. The current workspace cannot run PostgreSQL as a non-root user. The MySQL integration test skips until a disposable server is configured. Docker is unavailable in this workspace, so the image and Compose deployment have not been executed. Real Keycloak login, token refresh, Claude Code OAuth, target database TLS, MySQL behavior and network-failure cancellation still require integration validation.

```sh
npm run check
npm test
npm run build
npm run test:integration
npx playwright install chromium
npm run test:browser
```

For native PostgreSQL, run integration tests as a non-root user on Linux with the architecture-specific `embedded-postgres` optional dependency installed. For MySQL, point `MYSQL_TEST_HOST`, `MYSQL_TEST_DATABASE`, `MYSQL_TEST_USER` and optionally `MYSQL_TEST_PORT`, `MYSQL_TEST_PASSWORD`, `MYSQL_TEST_TLS` at a disposable MySQL database. The test user needs ordinary read/write and CREATE privileges so read-only enforcement is meaningful. The test attempts a CREATE inside a read-only transaction and expects rejection. Do not point development tests at production.

## Deliberate limitations

- Manual transactions spanning several user actions, explicit savepoints and reconnectable transaction sessions are not implemented. Atomic scripts reject DDL; MySQL atomic writes require InnoDB targets. Cancellation has a five-second grace period before disconnect, and an unconfirmed commit/rollback is reported as unknown rather than retried.
- SQL support is conservative. Stored procedures, DO blocks, session commands, explicit transaction statements, executable comments and various advanced dialect constructs are rejected. The parser is used for classification, not rewriting the original SQL. Some otherwise valid PostgreSQL INSERT ... SELECT ... RETURNING and locking constructs need additional support and tests.
- The editor is a textarea. Syntax highlighting, autocomplete, current-statement detection, tab persistence/closing and richer error positioning remain to be built. Selecting text runs that selection; otherwise execution uses the active tab.
- Saved queries have folder paths, but the GUI does not yet offer a full folder tree or query move/delete workflows.
- Explorer currently lists databases, tables/views and columns. Indexes, keys, routines, triggers, definitions and a navigable schema tree remain. Results are capped at 1,000 metadata rows.
- Monitoring is manually refreshed. Historical sampling, charts, automatic refresh, slow-query filtering, separate monitoring credentials and cross-application query cancellation are not implemented. Native slow-log file ingestion remains deferred as agreed.
- GUI result display has a 1,000-row cap per result. Large results are accessed through complete exports, or approved MCP pages. Large individual cells may exceed the normal API response byte cap and require export.
- Export files use additional disk beyond the SQLite captured-result quota. A unified disk budget, abandoned partial-export cleanup and more extensive crash/disk-full testing remain. Backups currently require a stopped application.
- MCP profiles use pre-registered public OAuth clients. Automated client provisioning, dynamic registration, service-account workflows and client-specific interoperability beyond the official MCP test client remain.
- Retention is 24 hours or seven days in the GUI; metadata retention is currently 90 days. These are initial defaults, not a finished policy-management screen.
- Single application process and local SQLite storage. No horizontal replication, high availability or multiuser sharing UI. Owner checks exist, but the initial product remains a personal tool.

## Next implementation steps

1. Validate Docker startup, actual Keycloak login/refresh and Claude Code connection using the intended app URL, realm issuer URL and installed Keycloak version. Verify PostgreSQL/MySQL versions, TLS and realistic database grants on disposable databases.
2. Complete native database cancellation, connection-loss, DDL/implicit-commit, quota and export crash-recovery tests. Add unified storage accounting and stronger operational error reporting.
3. Implement manual transaction sessions with idle expiry and rollback, then richer SQL editing and browser-state recovery.
4. Complete explorer navigation, query-folder management and monitoring refresh/history.
5. Add SSH tunnelling, followed by the optional VPN deployment layer. Periodic query scheduling and visual database editing remain later phases.

No infrastructure, Keycloak realm or target database has been changed by this implementation.
