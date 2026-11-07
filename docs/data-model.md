# Data model

The application database is SQLite (`DATA_DIR/workbench.sqlite`). It uses WAL, a 5-second busy timeout and foreign keys. Every table is `STRICT`.

- **Times** are ISO-8601 UTC text. Booleans are `0`/`1`. Enumerations are enforced with `CHECK` constraints that match `packages/core/src/domain/types.ts`.
- **Identifiers** have a prefix plus a 26-character time-sortable ULID-style suffix, for example `ex_01JD7Q2M4R…`. The prefixes are `cn` (connection), `mcp` (profile), `f` (folder), `q` (saved query), `ex` (execution), `exp` (export) and `apr` (approval).
- **Migrations** are numbered and tracked in `PRAGMA user_version` (`packages/core/src/store/migrations.ts`). Migration 1 creates the whole v1 schema so that later steps add behavior, not structure.

## Configuration

| Table                     | Purpose                                              | Notes                                                                                                                                                                                                                       |
| ------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                   | Every authenticated Keycloak subject                 | Refreshed on each request; identity itself lives in Keycloak                                                                                                                                                                |
| `connections`             | Stored MySQL/PostgreSQL connections                  | Name is unique, case-insensitive. `secret` holds the AES-256-GCM sealed password, bound to the connection ID. The password is never returned. `ca_pem` is public. `transport` is `direct` until SSH arrives.                |
| `mcp_profiles`            | MCP profiles                                         | `client_id` is unique: one OAuth client belongs to one profile. `owner` is the creator; any user of the client gets the profile ([0021](decisions/0021-shared-mcp-profiles.md)). Limits never exceed the deployment limits. |
| `mcp_profile_connections` | Connections a profile may use                        | Rows cascade away when either side is deleted                                                                                                                                                                               |
| `folders`                 | Nested folders of saved queries, per owner           | Name unique per owner and parent, case-insensitive; no cycles                                                                                                                                                               |
| `saved_queries`           | Named SQL per owner                                  | Name unique per owner and folder. `default_connection_id` is set to NULL when the connection is deleted.                                                                                                                    |
| `settings`                | Administrator overrides and the encryption key check | `execution.defaults`, `security.key_check`                                                                                                                                                                                  |

## Executions and results

| Table                  | Purpose                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executions`           | One row per accepted submission                            | Keeps snapshots of the SQL, connection name, profile name and title. It records actor, source, client, request key (unique per owner) with a hash of the payload, capture and transaction mode, timeout and retention. **Status, transaction outcome and result completeness are separate columns.** `connection_id` is set to NULL when the configuration is deleted. |
| `statements`           | Per-statement outcome                                      | Kind, lines, status, transaction outcome, affected rows, error code, message, position, duration                                                                                                                                                                                                                                                                       |
| `result_sets`          | One per result-producing statement                         | Columns as JSON (duplicate names kept), row and byte counts, `more_available`, completeness, capture time and expiry                                                                                                                                                                                                                                                   |
| `result_chunks`        | Ordered row batches of a result set                        | Many small rows instead of one large JSON value, so capture never holds a long write transaction                                                                                                                                                                                                                                                                       |
| `exports`              | CSV/JSON files made from a result set                      | `preview_only` marks partial files. `file_name` is set only when generation completes. Status: generating, ready, failed, expired or deleted.                                                                                                                                                                                                                          |
| `disclosure_approvals` | MCP disclosure requests and approvals                      | Scope: one result set of one execution for one profile. Status: pending, active, expired, revoked or denied. Records who decided, when, and until when.                                                                                                                                                                                                                |
| `mcp_usage`            | Rows and bytes already returned to a profile per execution | Enforces the preview allowance across result sets, pages and calls                                                                                                                                                                                                                                                                                                     |

## Audit

`audit_events` is append-only:

- columns: time, actor subject and label, source (`gui`, `api`, `mcp`, `server`), profile, action, target, outcome, details;
- details are redacted before storage, removing passwords, secrets, tokens, authorization, cookies, keys, SQL text, parameters and rows at any depth;
- the audit list is visible to administrators.

## Credentials and the encryption key

- Credentials are sealed with AES-256-GCM using `ENCRYPTION_KEY` from the deployment. Each ciphertext is bound to its record through associated data, so it cannot be copied onto another connection.
- On first start the core stores a sealed check value. On later starts a different key fails immediately with `encryption_key_mismatch` instead of failing on the first connection.
- Keep the key separate from database backups. Without it, stored credentials cannot be recovered.

## Permissions and read-only policy

| Role (Keycloak) | Permissions                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `query:read`    | view connections, run read-only SQL, manage own saved queries and folders, decide on disclosure (GUI only)         |
| `query:write`   | database writes (still subject to the connection and MCP profile)                                                  |
| `monitor:read`  | view monitoring                                                                                                    |
| `admin`         | view and manage connections, MCP profiles and settings; view the audit log. It does **not** grant database writes. |

Writes are evaluated by `evaluateWritePolicy` from three independent layers:

- the user (`query:write`);
- the stored connection (`read_only`);
- for MCP calls, the profile (`read_only`).

The strongest restriction wins, and the result names every layer that imposes it. An MCP client can never decide on disclosure, even when the user it acts for could.
