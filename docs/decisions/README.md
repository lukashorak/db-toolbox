# Decision records

Short records of decisions that shape the implementation. A decision changes only through a new record that supersedes the old one.

Each record states its status, date, context, decision and consequences.

| #                                                | Decision                                                          | Status   |
| ------------------------------------------------ | ----------------------------------------------------------------- | -------- |
| [0001](0001-fresh-start-with-codex-reference.md) | Start fresh; keep the Codex prototype as reference                | Accepted |
| [0002](0002-manual-transactions-after-v1.md)     | Manual transactions come after v1                                 | Accepted |
| [0003](0003-concurrency-per-connection.md)       | Two running executions per connection, shared by GUI and MCP      | Accepted |
| [0004](0004-operations-connection-writable.md)   | Operations demo connection is writable at connection level        | Accepted |
| [0005](0005-environment-labels.md)               | Environment labels: Production and Development only               | Accepted |
| [0006](0006-preview-only-export.md)              | Keep "Export preview only", clearly labelled                      | Accepted |
| [0007](0007-csv-null-representation.md)          | CSV: NULL is an empty unquoted field                              | Accepted |
| [0008](0008-disclosure-approval-scope.md)        | MCP disclosure approval covers one result set                     | Accepted |
| [0009](0009-runtime-and-language.md)             | Node.js 24 LTS and strict TypeScript                              | Accepted |
| [0010](0010-repository-layout.md)                | npm workspaces with enforced module boundaries                    | Accepted |
| [0011](0011-http-server.md)                      | Fastify 5 with zod                                                | Accepted |
| [0012](0012-application-database.md)             | Built-in node:sqlite with WAL                                     | Accepted |
| [0013](0013-target-database-drivers.md)          | pg with pg-cursor; mysql2 streaming                               | Accepted |
| [0014](0014-sql-analysis.md)                     | Own splitter; libpg-query and node-sql-parser; reject when unsure | Accepted |
| [0015](0015-mcp-sdk.md)                          | Official MCP SDK over Streamable HTTP                             | Accepted |
| [0016](0016-gui-stack.md)                        | Svelte 5 + Vite SPA with CodeMirror 6                             | Accepted |
| [0017](0017-gui-sign-in.md)                      | oidc-client-ts with authorization code flow and PKCE              | Accepted |
| [0018](0018-live-job-status.md)                  | Server-sent events with polling fallback                          | Accepted |
| [0019](0019-testing.md)                          | node:test, containers for integration, Playwright end-to-end      | Accepted |
| [0020](0020-continuous-integration.md)           | GitHub Actions with service containers                            | Accepted |
| [0021](0021-shared-mcp-profiles.md)              | MCP profiles are shared and bound to an OAuth client              | Accepted |
| [0022](0022-read-only-layers.md)                 | Read-only enforcement layers and their limits                     | Accepted |
| [0023](0023-values-as-text.md)                   | Result values are captured as the engine's text form              | Accepted |
