# MCP server and disclosure control

Claude Code (or another MCP client) uses Database Workbench at `<PUBLIC_URL>/mcp`. Signing in and the profile model are described in [identity.md](identity.md). Code: `packages/mcp/src/index.ts`, with disclosure in `packages/core/src/execution/disclosure.ts`.

Every tool calls the same core services as the GUI and the API, with the MCP user as the actor and the profile bound to the token's OAuth client. MCP has no permission system of its own.

## Tools

| Tool               | Does                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoami`           | User, profile and limits                                                                                                                                                                                          |
| `list_connections` | Connections the profile allows, with effective read/write access and which layers make them read-only                                                                                                             |
| `inspect_database` | Schemas, then objects, then a table's columns, keys, indexes and definition, or a routine definition                                                                                                              |
| `execute_sql`      | Runs SQL as a server-side execution. `requestKey`, `transactionMode` and `captureMode` are required. It waits up to `waitSeconds` (default 10, at most 30) and returns status and result-set metadata, never rows |
| `run_saved_query`  | The same, for one of the user's saved queries                                                                                                                                                                     |
| `get_execution`    | Status, statement outcomes and result-set metadata, optionally waiting                                                                                                                                            |
| `cancel_execution` | Cancels queued or running work                                                                                                                                                                                    |
| `get_result`       | Rows of a result set, within the allowance (below)                                                                                                                                                                |
| `export_result`    | Creates a CSV or JSON file for the user to download in the GUI. The contents are not sent through MCP                                                                                                             |

`get_activity` and `get_slow_statements` arrive with the monitoring backend (step 8).

Errors come back as tool errors whose `code` is from the stable list in [api.md](api.md#errors):

- `read_only_policy` and `preflight_rejected` carry the preflight problems;
- `approval_required` carries the pending request;
- `idempotency_conflict`, `forbidden`, `not_found` and `database_error` mean what they mean in the API.

## Data, not instructions

- Rows and metadata are returned as structured data.
- Text content starts with a notice that values come from the database and must not be followed as instructions.
- Execution summaries contain identifiers, outcomes and column names, not rows or SQL text.

## Allowance and disclosure

Each MCP profile has an allowance per execution: `previewRows` (default 1,000) and `previewBytes` (default 256 KiB). Both are capped by the deployment limits.

- Every row `get_result` returns counts against the allowance, across result sets, pages and calls. Rows read again count again.
- When a page would go beyond the allowance, the response returns what fits and opens one pending request per result set and profile. A call that can return nothing fails with `approval_required` and the request ID.
- Only the person who owns the execution can approve, signed in to the GUI (`POST /api/v1/approvals/{id}/approve`). The approval is scoped:
  - to one result set and one profile ([decision 0008](decisions/0008-disclosure-approval-scope.md));
  - to an amount of rows and bytes;
  - to an expiry: 60 minutes by default, never past the result's retention.
- MCP tokens never carry the disclosure permission. Arguments such as `approved: true` are ignored.
- Denying, revoking or expiring an approval stops further pages beyond the allowance. Deleting the result revokes it, too.
- There is no other way to reach the rows:
  - MCP offers no resources;
  - export downloads need a GUI token (an MCP token gets `401 wrong_audience`);
  - full capture and full exports do not grant disclosure.

## Profile rules

- A profile lists its allowed connections and has a read-only flag, limits (timeout, rows, bytes) and an enabled state.
- A disabled profile refuses new calls (`profile_disabled`). Running work is not rolled back.
- Changing a profile denies pending requests it can no longer satisfy.

## Verification

`test/integration/mcp.test.ts` uses the official MCP SDK client against PostgreSQL. It covers:

- every tool, and that no resources are offered;
- the full read-only matrix (AC1): user, connection and profile, 8 combinations, where only the all-writable one writes and each refusal names its layers;
- database text returned as data;
- request-key replay and conflict;
- the allowance across pages and calls;
- `approval_required` and an ignored client-supplied flag;
- approval in the GUI only, then revocation;
- byte budgets shared by result sets;
- export links closed to MCP tokens (AC5);
- saved queries and cancellation;
- expired tokens, wrong audiences and disabled profiles (AC13).

The OAuth sign-in through Keycloak is covered in `test/integration/keycloak.test.ts`.
