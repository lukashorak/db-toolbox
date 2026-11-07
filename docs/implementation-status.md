# Implementation status

Tracks progress against the [implementation plan](implementation-plan.md). Each step updates this file.

| Step | Title                                       | Status                                                    |
| ---- | ------------------------------------------- | --------------------------------------------------------- |
| 0    | Foundation and decision records             | Done (in review)                                          |
| 1    | Domain model, persistence, policy and audit | Done (in review)                                          |
| 2    | Identity with Keycloak                      | Done (in review); manual Claude Code check pending inputs |
| 3–14 | See the plan                                | Not started                                               |

## Step 8 — Monitoring backend

Reference: [monitoring.md](monitoring.md).

### What works

- Activity snapshots per connection: sessions, lock-wait chains and counter rates, each marked available, limited or unavailable with a reason.
  - PostgreSQL: `pg_stat_activity`, `pg_blocking_pids` with `pg_locks`, and `pg_stat_database`.
  - MySQL: `performance_schema` threads, data and metadata lock waits, and global status, falling back to the process list.
- Statement statistics: `pg_stat_statements` (with `stats_reset`) and MySQL statement digests.
- Rates with reset detection, and bounded polling (a 2-second cache per connection).
- This tool's sessions are tagged with their execution ID: PostgreSQL `application_name`, MySQL a leading comment.
- An optional separate monitoring account per connection, sealed and used only for the fixed queries on a reserved connection.
- API: `…/monitoring/activity` and `…/monitoring/statements`. MCP: `get_activity` and `get_slow_statements`.
- `monitor:read` now includes viewing connection settings, so monitoring users can choose a connection. Metadata browsing requires `sql.read`.

### How it was verified

- `npm run check` passes: 161 tests, 160 passing and 1 skipped when running as root. New tests cover rate and reset logic, tag parsing, and the monitoring API contract.
- `npm run test:integration` passes: 108 tests. The monitoring tests run on both engines (AC12):
  - a second client creates a row-lock wait, and both sessions and queries show;
  - a running execution is found by its ID;
  - rates, bounded polling, and a PostgreSQL statistics reset;
  - `pg_stat_statements` missing is reported as unavailable, while MySQL digests are available;
  - a read-only account sees limited and unavailable parts, never zeros;
  - a monitoring account restores full visibility;
  - the role is required.

### Pending (needs input)

- Whether monitoring accounts (`pg_monitor`; MySQL `PROCESS` with SELECT on `performance_schema`) can be created for the real targets, and whether `pg_stat_statements` is available there.

## Step 7 — MCP server and disclosure control (milestone M1)

Reference: [mcp.md](mcp.md).

### What works

- Tools: `whoami`, `list_connections`, `inspect_database`, `execute_sql`, `run_saved_query`, `get_execution`, `cancel_execution`, `get_result` and `export_result`.
  - Inputs require explicit transaction and capture modes and a request key.
  - Outputs carry identifiers and metadata.
  - Errors use the stable codes.
- Database values are returned as data, with a notice. No MCP resources are offered.
- Allowance per execution and profile (1,000 rows, 256 KiB by default), counted across result sets, pages and calls.
- Disclosure:
  - a pending request is opened beyond the allowance;
  - only the owner approves, in the GUI, scoped to one result set and profile, an amount and an expiry bounded by retention;
  - deny, revoke and expiry stop further pages;
  - a client-supplied approval flag is ignored.
- API: `GET /approvals`, `POST /approvals/{id}/approve`, `…/deny` and `…/revoke`.
- Milestone M1: both engines can be connected, a background query can be run from Claude Code or the API, its status found again by ID, and its complete captured result exported.

### How it was verified

- `npm run check` passes: 156 tests, 155 passing and 1 skipped when running as root. New disclosure unit tests cover:
  - the allowance, and one pending request;
  - owner-only approval in the GUI, where an administrator may deny but not approve, and strangers get not found;
  - expiry bounded by retention;
  - deny, revoke and disabled profiles.
- `npm run test:integration`: 94 tests across Keycloak, PostgreSQL and MySQL pass. `test/integration/mcp.test.ts` uses the official MCP client and covers:
  - every tool;
  - the 8-combination read-only matrix (AC1);
  - the allowance and approvals;
  - bypass attempts through pages, resources, a client flag and export links (AC5);
  - request keys;
  - cancellation;
  - token errors (AC13).

### Pending

- The manual Claude Code check against the real Keycloak (see step 2).
- `get_activity` and `get_slow_statements` were added in step 8.

## Step 6 — HTTP API

Reference: [api.md](api.md), and the generated `GET /api/v1/openapi.json`.

### What works

- Versioned resources over the core services:
  - connections, including tests and references;
  - metadata;
  - executions: submit, list, status, cancel, result pages, result deletion;
  - exports and downloads;
  - folders and saved queries;
  - MCP profiles and their effective access;
  - execution settings and audit.
- One error model with stable codes, including `idempotency_conflict`, `not_complete`, `read_only_policy`, `preflight_rejected` (with the stored execution) and `database_error` (with category and engine code).
- Server-sent events for execution and export status, limited to what the caller may see. The stream ends when the token expires, and clients resume by fetching executions by ID.
- An OpenAPI 3.0 document built from the route registry and the services' zod schemas.
- Downloads stream the file with a safe `Content-Disposition`.

### How it was verified

- `npm run check` passes. The contract tests (`packages/api/test/contract.test.ts`) call every endpoint without a token and with the reader, writer, administrator and monitor-only roles, and check status codes, error codes and the key response shapes. They also check:
  - the SSE stream: owner-only events, and the stream ending at token expiry;
  - that the OpenAPI document covers every route.
- Integration (`test/integration/api.test.ts`, PostgreSQL):
  - metadata over HTTP;
  - a submission followed over SSE;
  - a dropped stream, then a reconnect that resumes by ID and reaches the same final state (AC7);
  - rows read back;
  - an idempotent resubmission.

### Deferred

- Approval endpoints arrive in step 7, and monitoring endpoints in steps 9–10.

## Step 5 — Exports and retention

Format reference: [exports.md](exports.md).

### What works

- CSV:
  - RFC 4180, UTF-8, CRLF, a header row;
  - NULL is an empty unquoted field and empty text is `""`;
  - exact numbers, binary as `\x` hex, duplicate column names kept.
- JSON:
  - a `columns` array, and rows as arrays;
  - `null` for NULL, exact numeric strings, binary as `{ "base64": … }`;
  - completeness, and captured and exported row counts.
- Full exports only from complete results. "Preview only" is labelled in the file name and in the metadata.
- Lifecycle:
  - `generating` → `ready` or `failed` (disk full, write permission, generation error);
  - a server-controlled path, with the file name published only when complete;
  - no partial files.
- Regenerate rebuilds the file from the captured data and never submits SQL. Downloads check access and that the file exists, and never regenerate.
- Deleting stored results removes rows and export files and revokes disclosure. The execution stays in history.
- Retention cleanup in order: export files, then captured rows, then metadata after 90 days with its export folder. `core.cleanup()` runs every 10 minutes.

### How it was verified

- `npm run check` passes. New unit tests:
  - byte-exact CSV and parsed JSON for the fidelity fixture: duplicate `id` columns, NULL versus empty, quotes, CRLF, Unicode, 64-bit limits, `numeric(38,10)`, binary;
  - preview-only labelling and refusing incomplete results;
  - repeat exports and regeneration with an unchanged execution count;
  - a missing file that is not regenerated;
  - failed generation and error mapping;
  - access control;
  - result deletion, and cleanup that keeps metadata.
- Integration, on both engines:
  - 1,200-row CSV and JSON exports counted by parsing, with no new execution;
  - a fidelity row exported exactly as each database returned it. This found that MySQL `CHAR(10)` without `USING` yields a binary string, which is correctly exported as hex.

## Step 4 — Execution engine, queue and result capture

Details: [executions.md](executions.md).

### What works

- Submission:
  - the execution, its SQL snapshot and its statements are stored before the call returns;
  - request-key idempotency, with `idempotency_conflict` for a changed payload;
  - timeout bounds per capture mode and MCP profile;
  - preflight rejections are stored with their problems.
- Scheduling:
  - FIFO per connection with 2 slots shared by GUI and MCP, and a global cap;
  - queue position and reason are visible;
  - authorization is checked again at start: connection, MCP profile, policy with the submitter's roles.
- Per-statement mode (stop at the first error, or continue after errors) and single-transaction mode, on one pinned session.
- Statement and execution outcomes: committed, partial commit, rolled back, or unknown when the connection is lost during a write or COMMIT.
- Cancellation:
  - queued work is cancelled at once;
  - running work goes through `cancel_requested` until the database confirms;
  - work that finished first says so.
- An execution-wide time limit, ending as `timed_out`.
- Capture:
  - preview of 1,000 rows plus detection of more rows without COUNT;
  - full capture into chunks within 100 MiB per execution and a shared 1 GiB total, `quota_limited` when cut;
  - duplicate column names and several result sets are kept;
  - row paging.
- Restart reconciliation (interrupted, never replayed; queued work stays queued) and retention cleanup every 10 minutes (results 24 h, or up to 7 days when retained; metadata 90 days).
- `main.ts` reconciles at startup, resumes the queue and schedules the cleanup.
- Schema (migration 1, not yet deployed anywhere) gained:
  - on executions: the submitter's roles, the policy and a status note;
  - on statements: command, offsets and columns, notices and more statuses.

### How it was verified

- `npm run check` passes: 133 tests, 132 passing and 1 skipped when running as root. The 10 new execution tests cover:
  - storing before acknowledging, and idempotency per owner;
  - preflight rejections, including the user layer;
  - timeout bounds, and MCP limits for connection, timeout and read-only;
  - visibility, queue position, and cancelling queued work;
  - reconciliation outcomes and retention cleanup.
- `npm run test:integration` passes: 79 tests against Keycloak 26.4, PostgreSQL 16 and MySQL 8.4. The 29 new execution tests run on both engines:
  - the 1,200-row fixture: the preview shows 1,000 and "more available", and a full run captures exactly 1,200;
  - the three-statement script with statement 2 failing: partial commit per statement, continue after error, and rolled back as a single transaction;
  - single-transaction preflight (MySQL implicit commit and MyISAM, PostgreSQL `CREATE INDEX CONCURRENTLY`);
  - a read-only connection;
  - duplicate request keys;
  - FIFO queueing with its reason;
  - cancelling running and queued work, with the session still usable;
  - time limits;
  - MySQL procedure result sets;
  - `quota_limited` capture;
  - a simulated crash during a run: the execution is interrupted and the write is not replayed.

### Deferred

- Export files and the retention UI arrive in step 5.
- API endpoints and live status (server-sent events) arrive in step 6. The service already emits change events.
- The MCP disclosure budget arrives in step 7.

## Step 3 — Database adapters, SQL analysis and read-only enforcement

Details: [databases.md](databases.md). Decisions: [0022](decisions/0022-read-only-layers.md) (read-only layers and their limits) and [0023](decisions/0023-values-as-text.md) (values as text).

### What works

- Statement splitting for both dialects, with line and column ranges:
  - comments and quoting rules, PostgreSQL dollar quotes and `BEGIN ATOMIC`;
  - MySQL `DELIMITER` and executable comments;
  - unclosed quotes or comments are flagged.
- Classification with libpg-query (PostgreSQL) and keyword rules plus node-sql-parser (MySQL). It covers:
  - writable CTEs, `SELECT … INTO` and `INTO OUTFILE`, locking reads;
  - `EXPLAIN ANALYZE` of writes, `COPY`, `DO` and `CALL`;
  - side-effect functions;
  - settings that would turn read-only off;
  - session changes, transaction control, MySQL implicit commits, and PostgreSQL statements that cannot run in a transaction block.
  - Unparsable SQL is never read-only safe.
- Preflight for whole scripts, with nine problem codes (read-only violation with its policy source, transaction control in automatic modes, implicit commits and non-transactional MySQL tables in single-transaction mode, and others).
- Adapters for PostgreSQL (`pg`, `pg-cursor`) and MySQL (`mysql2`):
  - bounded pools per connection: work slots plus a reserved metadata and a reserved control connection;
  - sessions discarded when their state is not known to be clean;
  - batched streaming that the sink can stop;
  - read-only transactions;
  - server-side time limits, and cancellation that works with all slots busy;
  - lossless text values with binary as hex;
  - several MySQL result sets;
  - notices and warnings;
  - error mapping with codes and positions.
- TLS verify-full, verify-ca, require and disable, with a custom CA. MySQL verify-full refuses IP addresses, because the driver would not check the name.
- Connection test with separate steps (reach, TLS, authenticate, probe), failure categories and capabilities, including whether the account itself can write. Results are recorded and audited without the password.
- Metadata readers for both engines. Each list says whether it is complete, not permitted, or unavailable.
- `core.databases`:
  - adapter for a connection the actor may use: enabled, and for MCP in the profile;
  - stored and draft connection tests;
  - pools replaced when a connection changes.

### How it was verified

- `npm run check` passes: 123 tests, 122 passing and 1 skipped when running as root. New tests cover:
  - the splitter;
  - the classification corpus: 48 PostgreSQL and 48 MySQL statements, including indirect writes and bypass attempts;
  - preflight;
  - error mapping and TLS options;
  - connection validation and MCP connection access.
- `npm run test:integration` against Keycloak 26.4, PostgreSQL 16 and MySQL 8.4 passes (50 tests). The database tests cover:
  - the connection test, including each failure type: connectivity (refused, unknown host), authentication, TLS (hostname mismatch, other CA, no CA), configuration and timeout;
  - verify-ca and require behaviour;
  - every corpus write the database must reject inside a read-only transaction (22 statements), and every read-only-safe statement running inside one;
  - MySQL DDL running inside a read-only transaction, which is why the classifier rejects it first;
  - MyISAM detection for preflight;
  - value fidelity;
  - streaming with an early stop, time limits, and cancellation while the work slots are full;
  - error codes and positions, notices, procedure result sets, and replacement of dirty sessions;
  - metadata against fixture schemas, including permission-limited accounts;
  - connection tests through core.
- The built packages load the WASM parser from `dist`.

### Pending (needs input)

- The PostgreSQL and MySQL versions of the real targets. The tests use 16 and 8.4.
- Whether read-only and monitoring accounts can be created for the real connections. The connection test already reports both.

### Deferred

- The execution engine, queue, capture and transaction modes arrive in step 4.
- SSH transport comes after v1.
- MySQL compound statements need `DELIMITER`, as in the MySQL client.

## Step 2 — Identity with Keycloak

Details, endpoints and the setup guide: [identity.md](identity.md).

### What works

- `buildRealm` and `npm run keycloak:realm`: a realm import with the four roles and two public PKCE clients, `workbench-gui` (audience `workbench-api`) and `workbench-mcp` (audience `<PUBLIC_URL>/mcp`). No users or secrets.
- `TokenVerifier`:
  - signature through the realm JWKS, cached and refreshed on key rotation, with asymmetric algorithms only;
  - issuer, audience per channel, expiry, authorized party and access-token type;
  - a stable error code for each failure.
- `Authenticator`:
  - turns the bearer token into an actor with its roles, and refuses users without a workbench role;
  - for MCP, resolves the profile from the token's OAuth client and refuses unknown clients and disabled profiles;
  - records the user on each request.
- MCP profiles are shared per OAuth client ([decision 0021](decisions/0021-shared-mcp-profiles.md)). The user's roles still apply.
- API:
  - one error model: code, message, details and request ID, with no internal detail on 500;
  - `WWW-Authenticate` challenges;
  - `GET /api/v1/client-config` (public) and `GET /api/v1/session`;
  - JSON 404 for unknown API paths.
- MCP:
  - protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource/mcp` and at the root form;
  - a stateless Streamable HTTP endpoint with one tool, `whoami`;
  - `GET` and `DELETE` answer 405.
- The server process opens the application database at startup and stops with a clear message when the encryption key does not match.
- CI runs the integration job against a Keycloak 26.4 container (`scripts/integration/start.sh`). With `WORKBENCH_REQUIRE_INTEGRATION=1` a missing service fails the run instead of skipping.

### How it was verified

- `npm run check` passes: 90 tests, 89 passing and 1 skipped when running as root. New tests:
  - local-JWKS token tests for each failure: expiry, both audience directions, issuer, unknown key, HS256 and `alg: none`, wrong client, ID token, missing `azp`;
  - authenticator and realm-template tests;
  - API and MCP tests through Fastify, including MCP `initialize`, `tools/list` and `tools/call`.
- `npm run test:integration` against Keycloak 26.4 passes (5 tests):
  - GUI sign-in through the real login page with the authorization code flow and PKCE;
  - Keycloak refuses a missing code challenge and a wrong verifier;
  - refresh, and expiry of a real token;
  - GUI and MCP tokens are not interchangeable; a user without a role is refused;
  - the official MCP SDK client discovers Keycloak from the protected resource metadata, signs in with PKCE and the `resource` parameter, then lists and calls `whoami`. This is the flow Claude Code uses.
- The compiled server (`node packages/api/dist/main.js`) was started and checked with curl: readiness, client config, the `/mcp` challenge and the metadata.

### Pending (needs input)

- The manual check with the real Keycloak and Claude Code ([checklist](identity.md#manual-check-with-the-real-keycloak-and-claude-code)). It needs the Keycloak version, URL and realm, the public URL of the workbench and the Claude Code version.

### Deferred

- The GUI sign-in screens arrive in step 4.
- Profile management endpoints arrive in step 6.
- The workbench MCP tools arrive in step 7.

## Step 1 — Domain model, persistence, policy and audit

### What works

- SQLite schema, migration 1, covering the whole v1 data model: configuration, executions, statements, result sets and chunks, exports, disclosure approvals, MCP usage, audit and settings. Documented in [data-model.md](data-model.md).
- `Database` wrapper over `node:sqlite` with WAL, foreign keys, busy timeout, IMMEDIATE transactions and versioned migrations.
- Prefixed, time-sortable identifiers.
- `SecretBox`: AES-256-GCM sealing of credentials, bound to the record. An encryption key check at startup fails fast with `encryption_key_mismatch`.
- Permissions per role. `admin` manages configuration but gets no database writes; `query:read` users can save queries; MCP clients can never decide on disclosure.
- `evaluateWritePolicy`: user, connection and profile layers; the strongest wins and the result names its sources.
- Services:
  - users (touch on each request);
  - connections:
    - validation, unique names, a write-only password where blank means keep;
    - references disclosed before deleting; deletion refused while executions are active;
    - enable and disable;
  - MCP profiles:
    - one OAuth client per profile, limits within the deployment maximums;
    - effective access per connection;
    - pending requests are denied when the profile loses access;
  - library:
    - nested folders with cycle checks, saved queries with name-conflict detection per folder;
    - move and duplicate;
    - folder deletion either moving contents to the parent or deleting them;
    - private per owner;
  - settings: execution defaults for administrators, bounded by the deployment limits.
- Audit log with redaction of sensitive keys at any depth, filters and cursor pagination.
- Stable error codes (`AppError`) for the API and MCP to share.

### How it was verified

- `npm run check` passes. 64 tests, 63 passing and 1 skipped when running as root. They include:
  - all eight combinations of the three read-only layers;
  - administrator non-bypass;
  - encryption round-trip, wrong key, wrong record and tampering;
  - migrations from empty, plus reopen;
  - CHECK constraints;
  - each service's rules and audit trail.

### Deferred

- Execution, result and export behavior on top of these tables arrives in steps 4 and 5.
- No API endpoints yet (step 6).

## Step 0 — Foundation and decision records

### What works

- npm workspaces `@workbench/core`, `@workbench/mcp`, `@workbench/api` and `@workbench/web`, with TypeScript project references for the server packages and Vite for the web app.
- Module boundaries enforced by ESLint and proven by `test/boundaries.test.ts`:
  - database drivers only in `core`;
  - `api` and `mcp` import only the public `@workbench/core` entry point;
  - `mcp` does not import `api`;
  - `core` does not import its interfaces;
  - the browser app imports no server code;
  - nothing imports `reference/`.
- Configuration validation (`loadConfig`):
  - required `PUBLIC_URL`, `KEYCLOAK_ISSUER` and `ENCRYPTION_KEY`;
  - an origin without a path, HTTPS in production, an issuer naming a realm, a 32-byte base64 key;
  - the agreed limits as defaults.
  - All problems are reported at once, without echoing values.
- Structured JSON logging (pino) that redacts passwords, tokens, cookies, authorization headers, keys, SQL text, SQL parameters and rows.
- `GET /healthz` (liveness) and `GET /readyz` (the application database can take a write lock; the export folder is writable), returning 503 when not ready.
- The API process serves the built web app with a fallback to `index.html` for browser routes and JSON 404s otherwise.
- Placeholder web page that shows the readiness checks.
- GitHub Actions workflow: format, lint, type check, unit tests and build. The integration job was defined here and enabled in step 2.
- Decision records 0001–0020 in [`decisions/`](decisions/README.md).

### How it was verified

- `npm run check` passes: Prettier, ESLint, `tsc -b`, type check of tests, `svelte-check`, and 19 unit tests. One test is skipped when running as root, because root ignores file permissions.
- `npm run build` produces `packages/*/dist` and the web bundle.
- The production server started with valid configuration answered `/healthz` (200), `/readyz` (200 with both checks writable), served `index.html` for a browser route, and returned JSON 404 for an unknown API path.
- Started without configuration, it exited with status 1 and listed the three missing variables.
- `npm run dev` served `/readyz` from the TypeScript sources.

### Deferred or not verified

- No Dockerfile yet (step 13); `.dockerignore` already excludes `reference/`.
- The first CI run on GitHub (run 42378646950, 7 Nov 2026) passed format, lint, type check, unit tests and build in about 20 seconds; the integration job was skipped as intended.
- The local environment used here has Node.js 22 by default; checks ran with Node.js 24.22.2.
