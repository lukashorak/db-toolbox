# Implementation status

Tracks progress against the [implementation plan](implementation-plan.md). Each step updates this file.

| Step | Title                                       | Status           |
| ---- | ------------------------------------------- | ---------------- |
| 0    | Foundation and decision records             | Done (in review) |
| 1    | Domain model, persistence, policy and audit | Done (in review) |
| 2–14 | See the plan                                | Not started      |

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
- GitHub Actions workflow: format, lint, type check, unit tests and build. The integration job is defined but disabled until step 2.
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
