# Monitoring

Database-wide activity of a target database, separate from this tool's execution history. Code: `packages/core/src/monitoring/service.ts`.

- Only fixed, read-only queries are used.
- Nothing here terminates sessions, installs extensions or changes server settings.
- Missing visibility is shown as **limited** or **unavailable** with a reason, never as zero.

## Access

- Role `monitor:read` (permission `monitor.view`). It also lets people see connection settings, never secrets, so they can choose what to watch.
- MCP clients additionally need the connection in their profile.
- Endpoints:
  - `GET /api/v1/connections/{id}/monitoring/activity`
  - `GET /api/v1/connections/{id}/monitoring/statements?limit=`
- MCP tools: `get_activity` and `get_slow_statements`.
- **Monitoring account (optional).** A connection can store a separate account (`monitorUsername` / `monitorPassword`, sealed like the main password). It is used only for the monitoring queries, on a reserved connection, so monitoring works when every work slot is busy. The snapshot names the account it used.

## What is shown

| Part       | PostgreSQL                                                                                               | MySQL                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Sessions   | `pg_stat_activity` client backends: user, application, state, wait event, duration, query, blocking PIDs | `performance_schema.threads` with the program name. Without performance_schema access: the process list             |
| Lock waits | `pg_blocking_pids` chains with the waiting lock from `pg_locks`                                          | `data_lock_waits` (row locks) and pending `metadata_locks`, each with the blocking thread                           |
| Counters   | `pg_stat_database`: commits, rollbacks, block reads and hits, tuples, deadlocks, temp bytes, conflicts   | `SHOW GLOBAL STATUS`: questions, commands, InnoDB rows, slow queries, row-lock waits, temporary disk tables, uptime |
| Statements | `pg_stat_statements` by total time, with `stats_reset`                                                   | `events_statements_summary_by_digest` for the current database, by total wait time                                  |

- Counters become per-second rates between two samples.
  - A reset makes the rates `null` and sets `reset: true`, rather than showing wrong numbers. PostgreSQL reports a reset through `stats_reset`; MySQL through a falling counter, for example Uptime after a restart.
  - The first sample has no rates.
- Polling is bounded: a snapshot is reused for 2 seconds per connection.
- **This tool's sessions** carry their execution ID:
  - PostgreSQL: `application_name = 'database-workbench ex_…'` while an execution runs, reset afterwards;
  - MySQL: a leading comment `/* database-workbench ex_… */`, which statement digests ignore.

## Visibility

| Account                                                                                               | PostgreSQL                                                                                                              | MySQL                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Superuser, or `pg_read_all_stats` / `pg_monitor`; MySQL `PROCESS` plus SELECT on `performance_schema` | Available                                                                                                               | Available                                                                                                         |
| Ordinary account                                                                                      | Sessions **limited**: other users' sessions are listed with their queries hidden (`query: null`, `queryVisible: false`) | Sessions **limited** to its own threads; lock waits and statements **unavailable** (no performance_schema access) |
| `pg_stat_statements` not installed                                                                    | Statements **unavailable**, with how to add it                                                                          | —                                                                                                                 |
| `performance_schema` off                                                                              | —                                                                                                                       | Statements **unavailable**                                                                                        |

## Verification

`test/integration/monitoring.test.ts` runs on both engines (AC12):

- a second client holds a row lock while another waits, and the chain shows both sessions and queries;
- a running execution appears with its execution ID;
- rates between samples, bounded polling, and a PostgreSQL statistics reset;
- statement statistics: available on MySQL, and unavailable with a reason on PostgreSQL without the extension;
- a read-only account sees limited views;
- a configured monitoring account restores full visibility;
- `monitor:read` is required.
