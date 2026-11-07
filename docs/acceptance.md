# Acceptance criteria and their tests

Each of the fourteen acceptance criteria in [requirements.md](requirements.md#acceptance-criteria), split into its clauses, with the automated tests that prove them. Every test listed runs in CI:

- **check** job: unit, contract and component tests;
- **integration** job: Keycloak 26.4, PostgreSQL 16 and MySQL 8.4, then Playwright in Chromium;
- **deploy** job: the built image with the compose file.

Integration tests in `test/integration/executions.test.ts`, `databases.test.ts` and `monitoring.test.ts` run once per engine.

Two things stay manual, because they need the target environment: the [manual Keycloak and Claude Code check](identity.md#manual-check-with-the-real-keycloak-and-claude-code), and the deployment on the Dockge host ([operations.md](operations.md#what-still-depends-on-your-environment)).

## AC1: a writable GUI connection; a read-only MCP profile rejects the same write; every combination

| Clause                                                                       | Test                                                                                                                  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A permitted GUI user writes through a writable connection                    | `test/e2e/workbench.test.ts`: shows a partial commit per statement and a rollback in a single transaction (AC6)       |
| A read-only MCP profile rejects the same write                               | `test/integration/mcp.test.ts`: read-only matrix … (AC1)                                                              |
| All 8 combinations of user, connection and profile, with the reported source | `test/integration/mcp.test.ts`: read-only matrix (AC1); `packages/core/test/policy.test.ts`: one test per combination |
| Administrators gain no bypass                                                | `packages/core/test/policy.test.ts`: never lets an administrator bypass a restriction                                 |

## AC2: no way around the restrictions, by session commands or another route

| Clause                                                                                                 | Test                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session commands, indirect writes and unsupported SQL are classified as writes or refused              | `test/fixtures/classification.ts` (the corpus), `packages/core/test/sql-analyze.test.ts`: classifies the corpus; rejects writes and unparsable SQL under read-only; rejects unsupported and incomplete statements |
| The database refuses every corpus write in a read-only transaction (second barrier)                    | `test/integration/databases.test.ts`: the database rejects every corpus write inside a read-only transaction                                                                                                      |
| MySQL DDL, which a read-only transaction allows, is refused before it runs                             | `test/integration/databases.test.ts`: MySQL DDL is not stopped by a read-only transaction, so the workbench rejects it                                                                                            |
| Non-transactional tables are protected too                                                             | `test/integration/databases.test.ts`: a read-only transaction also stops writes to non-transactional tables                                                                                                       |
| No other MCP route: saved queries get the same checks, and connections outside the profile are refused | `test/integration/mcp.test.ts`: saved queries get the same checks … (AC2, AC13)                                                                                                                                   |
| No other API route: a read-only connection refuses writes over HTTP                                    | `packages/api/test/contract.test.ts`: executions: submit, idempotency, policy rejection …; `test/integration/executions.test.ts`: a read-only connection rejects writes before running                            |

## AC3: 1,000 of 1,200 rows in preview; a full run exports exactly 1,200 in CSV and JSON

| Clause                                                    | Test                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Preview shows at most 1,000                               | `test/integration/executions.test.ts`: previews 1,000 of 1,200 rows with "more available"                                    |
| Full export has exactly 1,200 rows in both formats        | `test/integration/executions.test.ts`: exports the full 1,200 rows as CSV and JSON without running SQL again                 |
| The same through the GUI, counted in the downloaded files | `test/e2e/workbench.test.ts`: previews 1,000 rows, runs the full result and exports it with every row (AC3), with 5,000 rows |

## AC4: downloads never run SQL again; a preview never passes as full

| Clause                                                         | Test                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Downloading or regenerating does not run SQL                   | `packages/core/test/exports.test.ts`: never runs SQL: repeat exports and regeneration leave the execution count unchanged; `test/integration/executions.test.ts`: exports the full 1,200 rows … without running SQL again |
| Previews are labelled, and full export needs a complete result | `packages/core/test/exports.test.ts`: exports only complete results in full; previews are labelled                                                                                                                        |
| A modifying statement is never replayed for export             | Exports read only captured data (the two tests above). **Run full result** offers reads only (`packages/web/src/components/ResultsPanel.svelte`; `test/e2e/workbench.test.ts` AC3)                                        |

## AC5: separate human approval for large results, across calls, pages, resources and downloads

| Clause                                                                      | Test                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The allowance holds across pages, calls and result sets, for rows and bytes | `test/integration/mcp.test.ts`: enforces the allowance across pages and calls … (AC5); counts bytes as well as rows, across result sets                                 |
| Only a person approves, in the GUI; client flags are ignored                | `test/integration/mcp.test.ts` (AC5); `packages/core/test/disclosure.test.ts`: only the owner approves, in the GUI                                                      |
| Approve, use and revoke across MCP calls in the GUI                         | `test/e2e/admin.test.ts`: MCP access: add a profile, then approve, use and revoke a disclosure request (AC5)                                                            |
| No resources, and downloads are closed to MCP tokens                        | `test/integration/mcp.test.ts`: lists exactly the stable tools and offers no resources; exports without sending contents, and export downloads are closed to MCP tokens |

## AC6: a script failing halfway, per statement versus single transaction, both engines, MySQL implicit commits

| Clause                                                                                                                   | Test                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per statement: partial commit, the rest not run (or run, with continue after error)                                      | `test/integration/executions.test.ts`: per statement: statement 2 failing leaves a partial commit …; per statement with continue after error runs statement 3                                                                              |
| Single transaction: everything rolled back                                                                               | `test/integration/executions.test.ts`: single transaction: statement 2 failing rolls everything back                                                                                                                                       |
| MySQL implicit commits and PostgreSQL statements that cannot run in a transaction are refused in single-transaction mode | `test/integration/executions.test.ts`: rejects before running what single-transaction mode cannot honour; `packages/core/test/sql-analyze.test.ts`: rejects implicit commits and non-transactional engines only in single-transaction mode |
| The same in the GUI                                                                                                      | `test/e2e/workbench.test.ts`: shows a partial commit per statement and a rollback in a single transaction (AC6)                                                                                                                            |

## AC7: an accepted execution stays reachable by ID after the browser closes

| Clause                              | Test                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| After a reload and in a new browser | `test/e2e/workbench.test.ts`: recovers a running execution after a reload and in a new browser (AC7)          |
| Over the API, with live status      | `test/integration/api.test.ts`: runs a query submitted over HTTP and reports progress over server-sent events |

## AC8: cancel, timeout and lost connections leave an accurate status and a clean or discarded session

Idle-transaction expiry belongs to manual transactions, which come after v1 ([implementation plan](implementation-plan.md#after-v1)).

| Clause                                                                                                                                            | Test                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cancel, confirmed by the database; the next execution works                                                                                       | `test/integration/executions.test.ts`: cancels a running statement once the database confirms, and the next execution still works; cancels a queued execution before it starts |
| Timeout                                                                                                                                           | `test/integration/executions.test.ts`: times out with the configured limit; `test/integration/databases.test.ts`: enforces the time limit and keeps the session usable         |
| A lost connection: `failed` with the honest outcome (`partial_commit` per statement, `rolled_back` in a single transaction); a fresh session next | `test/integration/executions.test.ts`: a lost connection fails the execution with an honest outcome … (AC8)                                                                    |
| Dirty sessions are discarded, not reused                                                                                                          | `test/integration/databases.test.ts`: discards a session marked dirty instead of reusing it                                                                                    |
| Shutdown: running work finishes or is interrupted                                                                                                 | `test/integration/executions.test.ts`: on shutdown, running work may finish within the grace period …                                                                          |

## AC9: no automatic replay after a restart; one request key, one job

| Clause                                      | Test                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running work is interrupted, never replayed | `test/integration/executions.test.ts`: after a restart, running work is interrupted and not replayed; `packages/core/test/executions.test.ts`: marks in-flight work interrupted with honest outcomes                                                          |
| Request keys                                | `test/integration/executions.test.ts`: returns the existing execution for a repeated request key …; `test/integration/mcp.test.ts`: repeated request keys return the same execution …; `packages/core/test/executions.test.ts`: is idempotent per request key |

## AC10: retention and quotas clean up results and files, keep metadata; partial results look incomplete

| Clause                                                                      | Test                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-execution quota: `quota_limited`, never `complete`                      | `test/integration/executions.test.ts`: reports quota_limited, never complete, when the per-execution limit is reached                                                                                                     |
| Total quota across retained results; cleanup frees it and keeps the history | `test/integration/executions.test.ts`: shares a total quota across retained results … (AC10)                                                                                                                              |
| Export files and chunks removed after retention; metadata kept              | `packages/core/test/exports.test.ts`: cleanup removes export files and chunks after retention and keeps metadata; `packages/core/test/executions.test.ts`: expires results after their retention and deletes old metadata |
| Deleting a result keeps the execution                                       | `packages/core/test/exports.test.ts`: deleting a result removes rows, export files and disclosure, and keeps the execution                                                                                                |

## AC11: export fidelity

| Clause                                                                                                | Test                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NULL, Unicode, decimals, large integers, timestamps and binary, exactly as the database returned them | `test/integration/executions.test.ts`: exports values exactly as the database returned them; `test/integration/databases.test.ts`: returns values as lossless text, binary as hex, and NULL as null |
| Byte-for-byte CSV and JSON                                                                            | `packages/core/test/exports.test.ts`: writes the fidelity fixture byte for byte as CSV; writes JSON with duplicate columns, nulls, exact numbers and base64 binary                                  |
| Duplicate column names and multiple result sets                                                       | `test/integration/executions.test.ts`: keeps duplicate column names and separate result sets per statement; keeps every result set of a procedure                                                   |

## AC12: outside activity is visible; missing capabilities are explicitly unavailable

| Clause                                                                   | Test                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A lock wait between two outside sessions                                 | `test/integration/monitoring.test.ts`: shows a lock wait between two outside sessions, with both queries; `test/e2e/admin.test.ts`: monitoring … (AC12)                                                           |
| Unavailable statistics and limited visibility are explained, never zeros | `test/integration/monitoring.test.ts`: reports statement statistics, or why they are unavailable; shows limited visibility for an account without monitoring rights, never zeros; `test/e2e/admin.test.ts` (AC12) |

## AC13: Keycloak sign-in; expired tokens, wrong audiences, disabled profiles and other connections are rejected

| Clause                                        | Test                                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GUI and MCP sign-in with the realm            | `test/integration/keycloak.test.ts`: signs in to the GUI with the authorization code flow and PKCE; lets an MCP client discover Keycloak, sign in with PKCE and call a tool; `test/e2e/gui.test.ts`                          |
| Expired tokens and wrong audiences or clients | `test/integration/keycloak.test.ts`: accepts a refreshed token and rejects an expired one; keeps GUI and MCP tokens apart; `packages/api/test/auth.test.ts`: distinguishes expired tokens, wrong audiences and wrong clients |
| Disabled profiles and bad tokens              | `test/integration/mcp.test.ts`: rejects bad tokens and disabled profiles (AC13); `packages/api/test/auth.test.ts`: rejects GUI tokens, unknown clients and disabled profiles                                                 |
| Connections outside the profile               | `test/integration/mcp.test.ts`: saved queries get the same checks … (AC2, AC13); `packages/core/test/executions.test.ts`: limits MCP to its profile                                                                          |

## AC14: compose deployment, migration, backup and restore, with no credentials in logs or responses

| Clause                                                 | Test                                                                                                                                                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose deployment, read-only and non-root, migrations | `test/deploy/compose.test.ts`: runs as a non-root user on a read-only root file system, with migrations applied                                                                                                     |
| Backup and restore                                     | `test/deploy/compose.test.ts`: backs up online, stops gracefully, restores with the CLI and starts again; `packages/core/test/backup.test.ts`                                                                       |
| No credentials in logs                                 | `test/deploy/compose.test.ts`: keeps credentials and tokens out of the logs; `packages/core/test/logger.test.ts`                                                                                                    |
| No credentials in responses                            | Connections return `hasPassword` only (`packages/api/test/contract.test.ts`: connections …); `test/integration/databases.test.ts`: tests a stored connection, records the result and audits it without the password |
