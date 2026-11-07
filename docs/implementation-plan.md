# Database Workbench — implementation plan

Status: proposal for review · 7 November 2026

This plan turns the agreed requirements and the interactive design prototype into a first release (v1). It is split into 15 steps (0–14). Each step is one reviewable pull request with its own tests and a clear definition of done.

## Sources

| Source | Role |
| - | - |
| [Database Workbench requirements](requirements.md) (baseline, 7 Nov 2026) | Functional scope, defaults and the 14 acceptance criteria (AC1–AC14) referenced below |
| Interactive design prototype, iterations 1–3 ([Claude Design canvas](https://claude.ai/artifact/JdcsDg4L4npnuTN4EBwYZH)) | UI specification: screens, states, copy, visual tokens, handoff notes and coverage matrix |
| [Codex prototype `db-workbench` 0.1.0](../reference/codex-db-workbench/) | Reference only; see [`reference/README.md`](../reference/README.md). Useful for adapter details, the 1,200-row test fixture and early MCP/OAuth findings. Not imported as a base. |

## Decisions already taken

| Decision | Consequence for the plan |
| - | - |
| Fresh start; the Codex code is reference material | Step 0 creates a new structure. Code is copied from Codex only deliberately, with tests. |
| Manual transactions come after v1 | v1 ships per-statement and single-transaction modes. The GUI shows no manual-mode controls. The data model leaves room for a later transaction session entity. |
| Concurrency limit is per connection: 2 running executions, then a FIFO queue | GUI and MCP share the same slots. There is no reserved slot per source. |
| Operations connection is writable at connection level | Demo and test data reflect this; MCP profiles restrict it. |
| No Staging environment label yet | The environment enum has `production` and `development` and stays extensible. |
| "Export preview only" is kept | It is labelled `PREVIEW-ONLY` in the file name, and JSON uses `completeness: "preview_only"`. |
| CSV: NULL is an empty unquoted field; an empty string is `""` | Documented in the export format notes and covered by tests. |
| MCP disclosure approval is scoped to one result set of one execution for one profile | The approval table key is `(execution_id, result_set, profile_id)`. |

## Technical choices

Confirmed on 7 Nov 2026. Step 0 records each one as a short decision record in `docs/decisions/`; changing one later needs a new decision record.

| Area | Choice | Alternative considered |
| - | - | - |
| Runtime and language | Node.js 24 LTS, TypeScript (strict), ESM | — |
| Repository layout | npm workspaces: `packages/core`, `packages/api`, `packages/mcp`, `packages/web`, built into one image | Single package with folders |
| HTTP server | Fastify 5 with zod schemas | Express 5 (used by Codex) |
| Application database | Built-in `node:sqlite` (WAL, busy timeout, no native addon) | better-sqlite3 |
| Target database drivers | `pg` with `pg-cursor`; `mysql2` with streaming | — |
| SQL analysis | Own dialect-aware splitter; PostgreSQL parser via `libpg-query` (WASM); `node-sql-parser` for MySQL; conservative rejection when parsing fails | `node-sql-parser` for both |
| MCP | Official `@modelcontextprotocol/sdk`, Streamable HTTP transport | — |
| GUI | Svelte 5 + Vite single-page app; CodeMirror 6 with `@codemirror/lang-sql`; `sql-formatter`; own virtualized grid (≤ 1,000 rows) | SvelteKit with static adapter |
| GUI sign-in | `oidc-client-ts`, authorization code flow with PKCE | — |
| Live job status | Server-sent events with polling fallback | Polling only |
| Tests | `node:test` + `tsx` for unit tests; database and Keycloak containers for integration; Playwright for end-to-end | Vitest |
| CI | GitHub Actions with service containers for PostgreSQL 16, MySQL 8.4 and Keycloak | Self-hosted runner |

## Working agreements for every step

- One pull request per step on its own branch. Large steps may be split into parts (a, b) but keep the same definition of done.
- CI must pass: format, lint, type check, unit tests, and the integration tests the step touches.
- Permission checks live in `core`, never only in the GUI or MCP tool descriptions. `api` and `mcp` never import database adapters directly. A lint rule enforces this.
- New user-visible states use the names from the prototype (for example "Preview-limited", "Partial commit", "Rejected before start").
- Every sensitive action writes an audit event. Logs and audit details never contain passwords, tokens or result data.
- Each step updates `docs/implementation-status.md` with what works, what is deferred and how it was verified.
- Code taken from `reference/codex-db-workbench/` is copied on purpose, adapted and tested in the same pull request; nothing imports from `reference/`.

## Overview

| Step | Title | Main output | Depends on | Acceptance criteria |
| - | - | - | - | - |
| 0 | Foundation and decision records | Repository skeleton, CI, health endpoint | — | — |
| 1 | Domain model, persistence, policy and audit | SQLite schema and migrations, permission evaluation, audit service | 0 | AC1 (policy part) |
| 2 | Identity with Keycloak | GUI/API and MCP token validation, realm template, early Claude Code proof | 1 | AC13 |
| 3 | Database adapters, SQL analysis and read-only enforcement | PostgreSQL and MySQL adapters, splitter, classifier, preflight | 1 | AC1, AC2, AC6 (preflight) |
| 4 | Execution engine, queue and result capture | Server-owned jobs, per-connection queue, cancellation, capture, restart reconciliation | 3 | AC3, AC6, AC7, AC8, AC9 |
| 5 | Exports and retention | CSV/JSON exports, preview-only exports, quotas and cleanup | 4 | AC3, AC4, AC10, AC11 |
| 6 | HTTP API | Versioned API, event stream, error model, OpenAPI document | 4, 5 | AC7 |
| 7 | MCP server and disclosure control | MCP tools, allowance accounting, approvals, idempotency | 2, 4, 5 | AC1, AC2, AC4, AC5, AC13 |
| 8 | Monitoring backend | Capability probing, activity, blocking, aggregated statements | 3 | AC12 |
| 9 | GUI foundation | App shell, design tokens, components, sign-in, live jobs | 6 | AC13 (GUI part) |
| 10 | GUI: Connections, Explorer, Saved queries | Three screens with their flows | 9 | — |
| 11 | GUI: Workbench, results and Executions | Editor, runs, results, export and share panels, history | 9, 10 | AC3, AC6, AC7 |
| 12 | GUI: Monitoring, MCP access, Settings and audit | Remaining screens | 9, 8, 7 | AC5, AC12 |
| 13 | Packaging and operations | Image, Compose for Dockge, backup and restore | 6, 7 | AC14 |
| 14 | Acceptance and hardening | End-to-end suite for AC1–AC14, security, accessibility and load review | all | AC1–AC14 |

Steps 5, 6 and 8 can run in parallel after step 4. GUI work (9–12) can start against the API contract from step 6 with mocked responses.

### Milestones

| Milestone | After step | What a user can do |
| - | - | - |
| M1 · Headless first use | 7 | Connect both engines, run a background query from Claude Code or the API, reconnect to its status by ID and export its complete captured result. This is the requirements' "first usable milestone". |
| M2 · Workbench usable | 11 | Do daily SQL work in the GUI: connections, explorer, saved queries, workbench, results, exports and history. |
| M3 · v1 release | 14 | All screens, monitoring, MCP administration, deployment on Dockge and every acceptance criterion verified. |

---

## Step 0 — Foundation and decision records

**Goal.** A clean repository that builds, tests and deploys an empty application, with the main technical choices written down.

**Scope**
- npm workspaces (`packages/core`, `packages/api`, `packages/mcp`, `packages/web`), TypeScript project references, ESLint, Prettier, `svelte-check`.
- `reference/` excluded from builds, lint, formatting, tests and the Docker context.
- Module boundaries enforced by lint: `mcp` and `api` depend on `core` services only.
- Configuration loading with validation (zod). Fail fast on missing `PUBLIC_URL`, `KEYCLOAK_ISSUER` and `ENCRYPTION_KEY`.
- Structured logging with redaction of secrets and SQL parameters.
- `GET /healthz` (liveness) and `GET /readyz` (SQLite writable, export folder writable).
- GitHub Actions: lint, type check, unit tests. Integration jobs are stubbed and enabled in later steps.
- `docs/decisions/` with records for every row of "Decisions already taken" and "Technical choices".

**Done when** CI is green on an empty app, `npm run dev` serves the health endpoints, and the decision records exist for every decision and technical choice above.

## Step 1 — Domain model, persistence, policy and audit

**Goal.** The core data model and rules every interface relies on, with no database connectivity yet.

**Scope**
- SQLite with WAL, busy timeout, foreign keys and versioned migrations. Short write transactions; large result data goes into chunk tables.
- Tables:
  - users (stable Keycloak subject), connections (with encrypted credentials), MCP profiles;
  - folders and saved queries (with owner and timestamps);
  - executions, statements, result sets, result chunks, exports, disclosure approvals and requests, MCP usage counters;
  - audit events, settings, monitoring samples (optional);
  - an idempotency table for request keys.
- Credential encryption with AES-256-GCM and a key supplied by the deployment, never stored in SQLite. Passwords are write-only through every interface.
- Domain enums matching the prototype:
  - Execution status: `queued`, `running`, `cancel_requested`, `succeeded`, `failed`, `rejected`, `preflight_rejected`, `cancelled`, `timed_out`, `interrupted`, `unknown`.
  - Transaction outcome: `none`, `not_started`, `committed`, `rolled_back`, `partial_commit`, `unknown`.
  - Capture completeness: `capturing`, `complete`, `preview_limited`, `interrupted`, `quota_limited`, `expired`, `deleted`.
  - Export status: `generating`, `ready`, `failed`, `expired`, `deleted`.
  - Approval status: `pending`, `active`, `expired`, `revoked`, `denied`.
- Permission evaluation:
  - Roles: `query:read`, `query:write`, `monitor:read`, `admin`.
  - Three read-only layers (user, connection, MCP profile); the strongest wins, and the decision records its source.
  - Application-configuration permission is separate from database writes. An administrator never bypasses a restriction.
- Audit service with redaction rules and a query API (filter by actor, source, action, time).

**Verification.** Unit tests for all eight combinations of the three read-only layers, role checks, migrations from empty, encryption round-trip and key mismatch, and audit redaction.

**Done when** the policy matrix tests pass and the schema is documented in `docs/data-model.md`.

## Step 2 — Identity with Keycloak

**Goal.** Prove early that the GUI and Claude Code can authenticate against the existing Keycloak and that tokens are validated correctly.

**Scope**
- Realm template generator (no users or secrets):
  - `workbench-gui`: public client with PKCE S256, audience `workbench-api`;
  - `workbench-mcp`: public client with PKCE S256, audience `<PUBLIC_URL>/mcp`;
  - role mappers.
- API token validation: signature via JWKS with caching and key rotation, issuer, audience, expiry, authorized party, and mapping roles to the internal actor.
- MCP OAuth protected-resource metadata (`/.well-known/oauth-protected-resource`), audience binding, and resolving the profile from the OAuth client. A profile ID sent by a client is never accepted as authorization.
- Distinct error responses for expired token, wrong audience, unknown client and disabled profile.
- A manual verification checklist with the real Keycloak version and Claude Code: `claude mcp add --transport http --client-id workbench-mcp --callback-port 8765 workbench <PUBLIC_URL>/mcp`, then `/mcp` sign-in.

**Verification.** Unit tests with a local JWKS fixture. A CI integration test against a Keycloak container with an imported realm covers sign-in, refresh, expiry and wrong audience. A manual Claude Code check is recorded in the step's status notes.

**Inputs needed.** Keycloak version, external Keycloak URL and realm name, intended public URL of the workbench, Claude Code version.

## Step 3 — Database adapters, SQL analysis and read-only enforcement

**Goal.** Reliable, engine-aware access to PostgreSQL and MySQL, and enforcement of read-only policy in the core.

**Scope**
- Transport interface (direct TCP and TLS now; SSH later without changes to execution or authorization).
- TLS: verification of certificate and hostname by default, custom CA, verify-CA option, and an explicitly labelled "require without verification".
- Bounded, lazily opened pools per connection. Capacity is reserved for cancellation and monitoring. A session is discarded when its state is not provably clean.
- Connection test with separate results for connectivity, authentication, TLS, timeout and capability limits, plus engine version and capability probing.
- Dialect-aware statement splitting: comments, quoted semicolons, PostgreSQL dollar quoting, MySQL backticks and executable comments. Statement ranges come back with line and column positions for the editor.
- Classification of read versus write, using a parser instead of prefix checks. It covers writable CTEs, functions and procedures, `SELECT … INTO`, `COPY`, file output and session commands. Unsupported or ambiguous SQL is rejected under a read-only policy.
- Database-level read-only transactions (`SET TRANSACTION READ ONLY` / `START TRANSACTION READ ONLY`) as a second barrier. Session commands that would disable it are rejected.
- Preflight checks:
  - transaction-control statements (`BEGIN`, `COMMIT`, `SAVEPOINT`, `SET autocommit`) combined with automatic modes;
  - MySQL statements that commit implicitly in single-transaction mode;
  - non-transactional MySQL storage engines in atomic mode.
- Error mapping with SQLSTATE or MySQL code, message, detail and position.
- Metadata inspection:
  - PostgreSQL: databases, schemas, tables, views, routines, columns, keys, indexes, definitions.
  - MySQL: databases, tables, views, routines.
  - Each object is reported as "unavailable" or "insufficient permission" when it cannot be read; an empty list is reported only when it really is empty.

**Verification.** Integration tests against PostgreSQL 16 and MySQL 8.4 containers:
- a classification corpus, including indirect writes and attempts to bypass read-only;
- TLS with a custom CA and a hostname mismatch;
- each failure type of the connection test;
- metadata accuracy against fixture schemas.

**Inputs needed.** Representative PostgreSQL and MySQL versions in use. Whether read-only and monitoring database accounts can be created for the real connections.

## Step 4 — Execution engine, queue and result capture

**Goal.** Server-owned executions with honest status, transaction and capture reporting.

**Scope**
- Submission:
  - The execution record and its SQL snapshot are persisted before acknowledging.
  - Request-key idempotency: the same key with the same payload returns the existing execution; the same key with different SQL or settings is a conflict.
  - Authorization is checked at submission and again when a queued job starts.
- Scheduling: 2 running executions per connection shared by GUI and MCP, a FIFO queue per connection with visible position and reason, and a global safety cap.
- Modes:
  - one transaction per statement, with an optional "continue after error" (off by default);
  - one transaction for the script, on a pinned session.
  - Statements run sequentially; there is no parallel execution inside a session.
- Timeouts: ordinary 30 s; explicit full capture up to the administrator maximum (5 min by default).
- Cancellation:
  - `cancel_requested` changes only when the database confirms;
  - outcomes are `cancelled`, completed before the cancel took effect, or `unknown` when the connection is lost;
  - a connection lost during COMMIT is reported as an unknown transaction outcome.
- Capture:
  - Preview: fetch at most 1,001 rows to detect "more available" without COUNT, keep 1,000, and enforce the 256 KiB MCP budget per execution.
  - Full capture: streams into result chunks within 100 MiB per execution and 1 GiB in total, with space reserved for metadata. Reaching a limit gives `quota_limited`, never `complete`.
- Value encoding: big integers and decimals as exact strings, timestamps as returned, binary marked as binary, duplicate column names preserved, multiple result sets kept separate.
- Restart reconciliation: in-flight work becomes `interrupted`, queued work stays queued and is re-authorized, and nothing is replayed.
- Retention: working results 24 hours, explicit retention up to 7 days, scheduled cleanup, execution metadata kept 90 days.

**Verification.**
- The 1,200-row fixture: preview shows 1,000 and "more available"; a full run captures exactly 1,200.
- The three-statement script with statement 2 failing ends as a partial commit (per statement) or rolled back (single transaction) on both engines.
- The MySQL implicit-commit preflight.
- Cancel and timeout leave a clean or discarded session.
- Restarting during a write does not replay it.
- Duplicate request keys and quota limits.

## Step 5 — Exports and retention

**Goal.** Complete exports that never run SQL, and storage that stays within budget.

**Scope**
- CSV: RFC 4180, UTF-8, header row, NULL as an empty unquoted field, empty string as `""`, exact numbers, binary as hexadecimal.
- JSON: a `columns` array plus rows as arrays (duplicate names preserved), `null` for NULL, exact numeric strings, binary as `{ "base64": … }`, and `completeness` plus captured and exported row counts.
- An export is created only from a retained complete result. The preview-only variant is labelled in the file name and metadata.
- Export records: `generating` → `ready` or `failed`. Files go to the mounted folder under server-controlled paths, and the final file name is published only when complete.
- Failures: disk full, write permission and generation errors. "Regenerate" rebuilds from captured data and never submits SQL.
- Authorized downloads. Download errors do not regenerate the file.
- Deleting a stored result removes its exports and ends any active disclosure; execution metadata stays.

**Verification.**
- Byte-level tests for a fidelity fixture: duplicate `id` columns, NULL versus empty, quotes, newlines, Unicode, 64-bit limits, `numeric(38,10)`, binary.
- 1,200-row CSV and JSON exports counted by parsing.
- A repeat export leaves the execution count unchanged.
- Cleanup removes files and chunks but keeps metadata.

## Step 6 — HTTP API

**Goal.** A stable, documented API for the GUI and for automation.

**Scope**
- Versioned resources:
  - connections (CRUD, test, enable/disable, delete with references);
  - metadata, executions (submit, status, cancel, result pages within the cap), exports and downloads;
  - folders and saved queries, MCP profiles, approvals, monitoring, settings, audit.
- One error model with stable codes, used by the API and MCP: for example `read_only_policy`, `preflight_rejected`, `idempotency_conflict`, `not_complete`, `quota_limited`, `approval_required`.
- Server-sent events for execution and export status changes, so the GUI can reconnect and resume by ID.
- OpenAPI document generated from the zod schemas, plus contract tests.

**Verification.** Contract tests for every endpoint and role. Reconnecting after a dropped event stream returns the same execution states (AC7).

## Step 7 — MCP server and disclosure control

**Goal.** Claude Code can do bounded, authorized work through the same core.

**Scope**
- Tools:
  - discovery: `list_connections`, `inspect_database`;
  - execution: `execute_sql`, `run_saved_query`, with explicit transaction and capture modes and a request key;
  - control: `get_execution`, `cancel_execution`;
  - results: `get_result`;
  - export: `export_result`;
  - monitoring: `get_activity`, `get_slow_statements`.
  - Inputs, outputs and error codes are stable.
- Responses carry identifiers and metadata rather than large datasets. Database text is always returned as data, never as instructions.
- Allowance accounting: 1,000 rows and 256 KiB per execution, across result sets, pages, resources and calls.
- Disclosure:
  - a call beyond the allowance creates a pending request;
  - only an authenticated human approves it in the GUI, scoped to one result set, one profile, an amount and an expiry (1 hour suggested, bounded by retention);
  - a client-supplied "approved" flag is ignored;
  - revocation and expiry deny further pages and downloads.
- Profile rules: allowed connections, a read-only flag, limits and enabled state. Disabling a profile rejects new calls but rolls nothing back.

**Verification.**
- Official MCP client tests for every tool.
- The full read-only matrix through MCP: a writable connection used from the GUI, the same write rejected through a read-only profile (AC1).
- Bypass attempts through pages, resources and export links (AC5).
- Token errors (AC13), duplicate and conflicting request keys.

**Milestone M1 is reached here.**

## Step 8 — Monitoring backend

**Goal.** Honest database-wide activity, separate from this tool's history.

**Scope**
- Capability probing per connection, shown as available, limited or unavailable with a reason.
- PostgreSQL: `pg_stat_activity`, `pg_locks` blocking chains, `pg_stat_database` rates, `pg_stat_statements` aggregates with `stats_reset`.
- MySQL: Performance Schema threads, `data_lock_waits` and `metadata_locks`, global status counters, statement digests.
- Samples carry timestamps; rates handle counter resets; polling is bounded. Missing visibility is never shown as zero.
- Sessions of this tool are tagged with their execution ID (for example through `application_name`).
- Optional separate monitoring credential, limited to the fixed monitoring queries.
- No terminating sessions, installing extensions or changing server settings.

**Verification.** Integration tests with a second client generating activity and lock waits on both engines, plus missing-extension and missing-privilege cases (AC12).

## Step 9 — GUI foundation

**Goal.** The application shell and shared components from the prototype's visual system.

**Scope**
- Design tokens as CSS variables (colors, type scale, spacing, radii, elevation) taken from the "Visual system" artboard.
- Components:
  - status pill, policy chip, environment label, connectivity indicator;
  - key-value list, tree row, virtualized data grid (≤ 1,000 rows);
  - side panel with focus management, confirm and form panels;
  - banners, toasts in a live region, menus and listboxes.
- Shell: sidebar navigation with badges, a header with a "Jobs" popover backed by server-sent events, and a "Demo data" flag only in demo builds.
- Sign-in through Keycloak, refresh, an expired-session dialog that preserves drafts, access-denied and sign-in-failure pages. The app never shows a password form.
- Tabs and SQL drafts saved in browser storage and restored after reload.
- An accessibility baseline: keyboard navigation, visible focus, Escape behavior, focus returning after a panel closes.

**Verification.** Component tests for states; a Playwright smoke test of sign-in with the test realm, navigation and job indicator updates.

## Step 10 — GUI: Connections, Explorer, Saved queries

**Scope**
- Connections:
  - list and detail, effective policy layers, capabilities, usage;
  - add, edit with a blank password meaning "keep", test separately from save;
  - TLS options, SSH shown as Planned;
  - disable and delete with disclosed references.
- Explorer: an engine-aware tree, search, refresh, reveal, object details (columns, keys, indexes, definitions), "Open SELECT" and "Preview data", plus loading, stale, renamed, unavailable and permission states.
- Saved queries: nested folders, search, open, save as, rename, move, duplicate, delete; folder create, rename and delete, with name-conflict validation and the consequences listed before confirming.

**Verification.** Playwright flows from the prototype's coverage matrix (connection lifecycle, explorer states, saved query management).

## Step 11 — GUI: Workbench, results and Executions

**Scope**
- Workbench:
  - tabs with their own connection, database, schema and settings;
  - CodeMirror 6 with PostgreSQL and MySQL dialects, completion from metadata, formatting, keyboard shortcuts with a reference panel;
  - run statement, selection or script, with the target shown precisely;
  - capture mode, transaction mode, timeout and retention controls, locked while a run is active;
  - error positions shown in the editor.
- Results:
  - runs of a tab, statement tabs, and separate badges for status, transaction outcome and capture;
  - the grid with local sort and filter labelled as such, and a row inspector;
  - "Run full result", "Export full result", "Export preview only" and "Share full result with MCP" panels, with the reason shown whenever an action is unavailable.
- Executions: filters (source, status, connection, time), detail with the SQL snapshot, statements, timeline, transaction outcome, capture, exports, disclosure, request key, retain and delete, and guidance for unknown outcomes.

**Verification.**
- Playwright: preview to full to export with row counts checked from the downloaded files (AC3);
- partial commit versus atomic (AC6);
- closing and reopening the browser recovers a running execution by ID (AC7).

**Milestone M2 is reached here.**

## Step 12 — GUI: Monitoring, MCP access, Settings and audit

**Scope**
- Monitoring: connection picker, Overview, Activity, Blocking and Slow statements, sample time, pause and refresh, stale and unavailable states, links to this tool's executions.
- MCP access:
  - endpoint, profiles with the effective access table, create and edit profile;
  - Claude Code setup panel;
  - approval inbox with review, approve, deny and revoke, plus recent calls.
- Settings:
  - identity and roles, sign out;
  - execution defaults for administrators (read-only otherwise);
  - retention and storage with the retained-results list, quota and cleanup warnings;
  - audit events with filters and redacted details.

**Verification.** Playwright: an approval granted, used and revoked across MCP calls (AC5); external activity and unavailable statistics shown correctly (AC12).

## Step 13 — Packaging and operations

**Scope**
- Non-root multi-stage image with a read-only root file system, health checks and graceful shutdown that lets running work settle or marks it for reconciliation.
- Compose file for Dockge, an environment template, volumes for `data` and `exports`, and reverse proxy and HTTPS notes so the GUI, OAuth callbacks and MCP discovery agree on the external URL.
- Backup and restore of SQLite with the online backup API, handled separately from the encryption key; documented upgrade and migration procedure.

**Verification.** A deployment test on a clean host or VM: migrate, back up, restore, and check that no credentials appear in logs (AC14).

**Inputs needed.** Dockge host details, reverse proxy in use, external URLs.

## Step 14 — Acceptance and hardening

**Scope**
- An automated end-to-end suite mapped one-to-one to AC1–AC14, running in CI against the containers.
- Security review: threat model, read-only bypass corpus, token handling, CSRF and CORS, rate limits on MCP and the API, prompt-injection hygiene for database text, dependency audit.
- Accessibility review (WCAG 2.1 AA for the main flows) and a narrow-screen check.
- Load sanity: 1-million-row tables, concurrent jobs on one connection, cancellation under load.
- Final documentation: operations guide, MCP setup guide, export format reference.

**Done when** all fourteen acceptance criteria pass in CI and the review findings are resolved or explicitly accepted.

---

## After v1

1. Manual transactions (the prototype's design proposal): pinned sessions, Begin/Commit/Roll back, idle expiry with automatic rollback, MCP transaction tools.
2. SSH tunnels through the transport interface (queries, metadata, monitoring and cancellation).
3. Scheduled executions reusing submission, authorization, capture and export.
4. Optional VPN deployment layer, native slow-log ingestion, team sharing and a Staging environment label.

## Acceptance criteria traceability

| Criterion | Built in | Verified in |
| - | - | - |
| AC1 Writable GUI vs read-only MCP, all policy combinations | 1, 3, 7 | 1, 7, 14 |
| AC2 No bypass through session commands or other routes | 3, 7 | 3, 7, 14 |
| AC3 Preview 1,000 of 1,200; full export of exactly 1,200 | 4, 5, 11 | 4, 5, 11, 14 |
| AC4 Downloads never rerun SQL; preview never poses as full | 4, 5 | 5, 7, 14 |
| AC5 Separate human approval across calls, pages, resources, downloads | 7, 12 | 7, 12, 14 |
| AC6 Halfway failure: per-statement vs single transaction; MySQL implicit commit | 3, 4 | 4, 11, 14 |
| AC7 Execution reachable by ID after closing the browser | 4, 6, 9 | 6, 11, 14 |
| AC8 Cancel, timeout, lost connection leave accurate status | 3, 4 | 4, 14 |
| AC9 No replay after restart; request keys prevent duplicates | 4, 7 | 4, 7, 14 |
| AC10 Quotas and retention clean up; partial results marked | 4, 5 | 5, 14 |
| AC11 Export fidelity | 5 | 5, 14 |
| AC12 External activity visible; missing capability unavailable | 8, 12 | 8, 12, 14 |
| AC13 Keycloak sign-in; token, audience, profile and connection rejections | 2, 7, 9 | 2, 7, 14 |
| AC14 Compose deployment, migration, backup and restore | 13 | 13, 14 |

AC8 also mentions idle transaction expiry. That part moves with manual transactions to after v1.

## Inputs needed from the owner

| Input | Needed by |
| - | - |
| Keycloak version, external URL, realm name | Step 2 |
| Public URL of the workbench (no subpath) | Step 2 |
| Claude Code version used for MCP | Step 2 |
| PostgreSQL and MySQL versions of the real targets; possibility of read-only and monitoring accounts | Step 3 |
| Dockge host, reverse proxy, backup location | Step 13 |
