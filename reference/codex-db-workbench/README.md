# Database Workbench

An initial implementation of the agreed personal database workbench: a TypeScript API/core, an authenticated HTTP MCP adapter, and a Svelte GUI. Configuration, execution history and captured result chunks live in SQLite. Exports are written to a mounted directory.

This is the **first development milestone**, not a completed production release. The functional baseline is in [docs/requirements.md](docs/requirements.md). Implementation status and remaining work are in [docs/implementation-status.md](docs/implementation-status.md).

## What this build does

- Manage encrypted MySQL and PostgreSQL connections using TCP or verified TLS.
- Run SQL from tabs, selected text, or a complete tab, with per-statement or atomic transaction modes.
- Run jobs on the server, inspect history, request cancellation, and enforce time and result-storage limits.
- Preview no more than 1,000 rows and explicitly capture a full result. CSV and JSON exports use the captured result, without rerunning SQL.
- Require a separate, expiring GUI approval before an MCP client reads beyond its preview allowance or downloads a full export.
- Bind each MCP profile to a unique Keycloak OAuth client and connection allowlist. User, connection and profile restrictions combine.
- Save named queries using folder paths; inspect database objects and columns; view live sessions, blocking and available aggregate statistics.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
# Configure the existing Keycloak realm and URLs, then fill .env.
npm run check
npm test
npm run build
node --env-file=.env dist/api/main.js
```

For frontend development, set PUBLIC_URL to http://localhost:5173, configure that exact GUI redirect URI and origin in Keycloak, and run the backend with `node --env-file=.env --import tsx --watch src/api/main.ts`. Run `npm run dev:web` separately. The Vite server proxies API calls to localhost:3000. Native MCP testing uses the backend URL; production serves everything under one origin.

The application has no unauthenticated development mode. Automated tests inject a local test identity provider and disposable database fixtures instead of connecting to your infrastructure.

## Keycloak setup

Generate a realm configuration for the actual application origin:

```sh
node scripts/keycloak-realm.mjs https://db.example.com > keycloak-realm.json
```

Import it as a **new realm** in the existing Keycloak instance. The generator does not contact or change Keycloak. It contains no users, passwords or client secrets. Review compatibility with your installed Keycloak version before import.

1. Create your user and assign `query:read`, `query:write`, `monitor:read` and `admin` as needed. Administrative permission alone does not imply database write permission.
2. Keep `workbench-gui` as a public client with authorization code flow and PKCE S256. Its API token audience is `workbench-api`.
3. Keep `workbench-mcp` as a separate public client with PKCE S256 and audience exactly `https://db.example.com/mcp`.
4. In the GUI, create a profile bound to `workbench-mcp` and select its allowed connections. It defaults to read-only. One OAuth client ID can belong to only one profile.
5. For a second MCP profile, create a distinct OAuth client in Keycloak with the same MCP audience and its own allowed redirect URIs.

Fixed client registration and audience mappers avoid requiring dynamic client registration or experimental Keycloak features. The app publishes OAuth protected-resource metadata and validates issuer, signature, expiry, audience and authorized client. GUI tokens and MCP tokens are deliberately different.

In Claude Code:

```sh
claude mcp add --transport http --client-id workbench-mcp --callback-port 8765 workbench https://db.example.com/mcp
```

Then authenticate through `/mcp` in Claude Code. The local callback port must match the Keycloak client configuration. No client secret is used for this public client. See the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp) and [Keycloak MCP guide](https://www.keycloak.org/securing-apps/mcp-authz-server).

## Dockge deployment

Place the project in a Dockge stack directory, create `.env` from the example, and configure HTTPS through your reverse proxy. The initial deployment supports an origin URL, without a subpath.

```sh
mkdir -p data exports
# The image runs as UID/GID 1000. On the host, make these two directories writable by that identity.
docker compose up -d --build
```

The default published port binds to host loopback for a host reverse proxy. If your proxy is another container, attach the workbench to its Docker network and proxy to `workbench:3000`, or configure the host binding for your network. The public URL, Keycloak audience, redirect URI and browser origin must match.

Keep the encryption key in deployment secrets or a protected `.env`; never commit it. The existing Keycloak instance remains external. The application does not contain or configure a VPN, SSH tunnel or target database server.

## Result semantics

**Run preview** adds a validated outer LIMIT of at most 1,001 to supported side-effect-free SELECT statements. At most 1,000 rows are retained for preview; the extra row only detects truncation. This limits returned rows, not database scan cost. Exact original SQL is recorded, alongside the SQL actually executed.

**Run full result** executes the original SQL and captures all returned rows until it completes or reaches an explicit timeout or storage quota. The GUI still displays at most 1,000 rows. A quota-limited or interrupted result is never labeled as a complete export.

Modifying statements are never re-executed for export. For UPDATE/INSERT output, preview limits only captured output, not affected rows; the original statement must complete or be rolled back. A full run after a previous preview is a new execution and may see changed data.

CSV uses CRLF records, quotes every non-null field and writes SQL NULL as an unquoted `\N`. Binary values use `base64:`. CSV preserves raw values, including text that spreadsheet applications may interpret as formulas. JSON uses `{columns, executionId, resultId, rows}`, with array rows so duplicate column names are preserved. Exact numeric values may be strings, and binary values are `{base64: ...}`.

Results default to 24 hours, optionally 7 days. Metadata defaults to 90 days. Per-execution captured data defaults to 100 MiB; total captured chunks default to 1 GiB. Export files consume additional disk space and expire with their source results. Leave room for exports, SQLite metadata and WAL files.

## Read-only behavior

The strongest restriction wins across the user, stored connection and MCP profile. The core checks all entry points. Read-only SQL passes a conservative dialect-aware parser and function allowlist and executes in a database read-only transaction. Session-policy changes, ambiguous SQL, executable comments and unsupported functions fail closed.

Use restricted database accounts as well. SQL classification is intentionally conservative and is not a replacement for database grants, especially when stored functions or extension code can have side effects. This milestone rejects some valid advanced SQL; see the status document for current compatibility limits.

## Tests

```sh
npm run check
npm test
npm run build
npx playwright install chromium
node --import tsx tests/browser-smoke.ts
```

Core tests use SQLite and PGlite, a real PostgreSQL engine compiled to WASM. HTTP and MCP tests use signed JWTs, a local JWKS server and the official MCP client. These fixtures do not establish compatibility with your actual Keycloak configuration or all target database versions. Network-driver tests and their prerequisites are documented in the implementation status.

## Backup and recovery

For this initial build, stop the application, back up the entire `data` directory and retained `exports`, then restart it. Keep the encryption key separately and securely. Restore to the same application version before attempting an upgrade. Do not copy only the SQLite main file while it is running in WAL mode, and do not mount it on a network filesystem.

A restarted process marks unfinished executions interrupted and never replays them automatically. If a connection was lost near COMMIT, the outcome is reported as unknown. Inspect the target database before retrying modifying SQL.
