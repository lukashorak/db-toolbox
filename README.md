# Database Workbench

A small, self-hosted workbench for MySQL and PostgreSQL: SQL tabs, a read-only explorer, saved queries, background executions with complete CSV/JSON exports, database-wide monitoring, and authenticated MCP access for Claude Code. Identity comes from an existing Keycloak instance; deployment uses Docker Compose in Dockge.

This repository is at **step 0 (foundation)** of the [implementation plan](docs/implementation-plan.md). Progress is tracked in [docs/implementation-status.md](docs/implementation-status.md).

| Document                                                              | Purpose                                     |
| --------------------------------------------------------------------- | ------------------------------------------- |
| [Requirements](docs/requirements.md)                                  | Functional baseline and acceptance criteria |
| [Implementation plan](docs/implementation-plan.md)                    | Steps, milestones and traceability          |
| [Decision records](docs/decisions/README.md)                          | Decisions and technical choices             |
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
npm run check          # format check, lint, type check, unit tests
npm run build          # compile server packages and the web app
npm start              # run the built server
```
