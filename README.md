# Database Workbench

A small, self-hosted workbench for MySQL and PostgreSQL: SQL tabs, a read-only explorer, saved queries, background executions with complete CSV/JSON exports, database-wide monitoring, and authenticated MCP access for Claude Code. Identity comes from an existing Keycloak instance; deployment uses Docker Compose in Dockge.

Steps 0–12 of the [implementation plan](docs/implementation-plan.md) are done, and step 13 (packaging) is done apart from the parts that need the target host. Progress is tracked in [docs/implementation-status.md](docs/implementation-status.md).

| Document                                                              | Purpose                                     |
| --------------------------------------------------------------------- | ------------------------------------------- |
| [Requirements](docs/requirements.md)                                  | Functional baseline and acceptance criteria |
| [Implementation plan](docs/implementation-plan.md)                    | Steps, milestones and traceability          |
| [Decision records](docs/decisions/README.md)                          | Decisions and technical choices             |
| [Operations](docs/operations.md)                                      | Deployment, backups, restore and upgrades   |
| [Design prototype](https://claude.ai/artifact/JdcsDg4L4npnuTN4EBwYZH) | Interactive UI specification                |
| [Reference material](reference/README.md)                             | Earlier Codex prototype, read-only          |

## Layout

| Package         | Role                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/core` | Domain model, policy, persistence, adapters, execution engine. The only place that talks to target databases. |
| `packages/mcp`  | MCP protocol handling; delegates to `core`.                                                                   |
| `packages/api`  | HTTP API and the process that serves the web app and MCP endpoint.                                            |
| `packages/web`  | Svelte 5 single-page app.                                                                                     |

## Development

Requires Node.js 24 (see `.nvmrc`) and npm.

```sh
npm ci
cp .env.example .env   # then set ENCRYPTION_KEY
npm run dev            # API on http://127.0.0.1:3000 (health: /healthz, /readyz)
npm run dev:web        # web app on http://127.0.0.1:5173, proxied to the API
```

```sh
npm run check          # format check, lint, type check, unit and component tests
npm run build          # compile server packages and the web app
npm start              # run the built server
```

Integration tests run against disposable containers (Docker required):

```sh
scripts/integration/start.sh             # Keycloak, PostgreSQL 16, MySQL 8.4; prints the variables to export
export KEYCLOAK_TEST_URL=http://127.0.0.1:18080 INTEGRATION_CERTS=$PWD/.integration/certs
export POSTGRES_TEST_URL=postgres://postgres:workbench-it@localhost:15432/postgres
export MYSQL_TEST_URL=mysql://root:workbench-it@localhost:13306/mysql
npm run test:integration
npm run build && npm run test:e2e        # Playwright GUI smoke test (needs KEYCLOAK_TEST_URL)
scripts/integration/stop.sh
```

Target databases, TLS modes, read-only enforcement and metadata are described in [docs/databases.md](docs/databases.md).

Keycloak setup, the realm generator (`npm run keycloak:realm`) and connecting Claude Code are described in [docs/identity.md](docs/identity.md).

## Deployment

```sh
docker build -t database-workbench:0.1.0 .
```

The image runs with [`deploy/compose.yaml`](deploy/compose.yaml) and an `.env` from [`deploy/.env.example`](deploy/.env.example), for example as a Dockge stack. The operations CLI in the image (`node packages/api/dist/cli.js`) takes online backups, verifies and restores them, applies migrations and prints the Keycloak realm import. [docs/operations.md](docs/operations.md) covers the reverse proxy, graceful shutdown, backups, restore and upgrades.

```sh
DEPLOY_TEST_IMAGE=database-workbench:0.1.0 npm run test:deploy   # needs the Keycloak and PostgreSQL test containers
```
