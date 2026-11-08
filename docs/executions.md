# Executions: submission, queue, transaction modes and capture

Core code in `packages/core/src/execution/`. Executions belong to the server: they keep running when the browser tab, the API request or the MCP call that started them goes away.

## Lifecycle

```
submit ─┬─► preflight_rejected                     (nothing ran)
        └─► queued ─┬─► rejected                    (no longer authorized when it was due to start)
                    ├─► cancelled                   (cancelled while queued)
                    └─► running ─┬─► succeeded
                                 ├─► failed
                                 ├─► timed_out
                                 ├─► cancel_requested ─► cancelled | succeeded (finished first) | unknown
                                 ├─► unknown         (connection lost during a write or during COMMIT)
                                 └─► interrupted     (server restart; never run again)
```

Status, transaction outcome and result completeness are reported separately.

| Transaction outcome | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `not_started`       | Nothing ran                                                                 |
| `none`              | Nothing to commit: read-only, or no write succeeded                         |
| `committed`         | Every write is committed                                                    |
| `partial_commit`    | Per statement: some writes are committed, then the run stopped              |
| `rolled_back`       | Single transaction: nothing is committed                                    |
| `unknown`           | The connection was lost during a write or during COMMIT. Check the database |

## Submission

1. The caller must hold `sql.read`, and the connection must be usable (enabled; for MCP, in the profile).
2. Policy: user, connection and profile layers ([decision 0022](decisions/0022-read-only-layers.md)). The result is stored with its sources.
3. Timeout:
   - preview runs: up to the ordinary limit (30 s by default);
   - full capture: up to the administrator maximum (5 min by default);
   - MCP: also capped by the profile.
4. Idempotency: `(owner, requestKey)` is unique. The same key with the same payload returns the existing execution. The same key with a different SQL text or different settings is `idempotency_conflict`.
5. Analysis and [preflight](databases.md#preflight). MySQL single-transaction runs look up storage engines first.
6. The execution, its SQL snapshot and one row per statement are stored in one transaction, then the call returns. A rejected script is stored as `preflight_rejected`, with its problems in `error.detail`.

## Scheduling

- At most `concurrencyPerConnection` (2) executions run per connection. GUI and MCP share these slots. A global cap (16) protects the server.
- The queue is first in, first out, per connection. A queued execution reports its position and why it waits.
- Authorization is checked again when an execution starts:
  - the connection still exists and is enabled;
  - an MCP profile is still enabled and still allows the connection;
  - the policy is evaluated again with the submitter's roles. If it became read-only and the script writes, the execution is `rejected`.

## Transaction modes

All statements of an execution run one after another on one pinned session.

- **Per statement** (default). Each write commits on its own (autocommit). Under a read-only policy, each statement runs inside its own read-only transaction. The run stops at the first error unless `continueOnError` is set. A cancel or timeout always stops it.
- **Single transaction**. One transaction around the script, read-only when the policy is. Any failure rolls everything back. The outcome is set to `unknown` just before COMMIT and only then to `committed`, so a crash during COMMIT is never reported as committed. Statements that would break the promise are refused before running: transaction control, MySQL statements that commit implicitly, PostgreSQL statements that cannot run in a transaction block, MySQL tables that are not transactional (including `LOAD DATA` targets, and unqualified names after a `USE` in the script, which are looked up in that database), MySQL writes whose tables cannot be determined, and MySQL `CALL`, because a procedure can commit on its own.

Statements that change session state mark the session dirty, and the session is discarded after the run. That includes temporary tables (and, in PostgreSQL, anything in `pg_temp`): they live as long as the connection and could shadow a permanent table for the next run.

## Cancellation and time limits

- Queued: cancelled at once.
- Running: the status becomes `cancel_requested` and the database is asked to cancel over the reserved control connection. The final status depends on what happened:
  - `cancelled` when the database confirms;
  - `succeeded`, with the note "Completed before the cancellation took effect", when the statement finished first;
  - `unknown` when the connection was lost.
- The time limit applies to the whole execution. Each statement runs with the time that is left, and the result is `timed_out`.
- A long read that streams many batches is stopped between batches as well. There the database has no running statement to cancel, and PostgreSQL's `statement_timeout` counts each fetch separately. A cancel or time limit therefore takes effect within one batch.
- In a single transaction, a cancel always rolls back, so the execution is `cancelled` even if the last statement finished.

## Capture

| Mode    | Rows kept                                                                         | Completeness                                   |
| ------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| preview | 1,000 per result set; a 1,001st row is read to detect "more available" (no COUNT) | `complete` or `preview_limited`                |
| full    | Everything within 100 MiB per execution and 1 GiB in total                        | `complete` or `quota_limited` (never complete) |

- A result set cut short by an error, a cancel or a restart is `interrupted`. Results are removed after their retention and become `expired`.
- Values are lossless text, and binary values are `\x` hex ([decision 0023](decisions/0023-values-as-text.md)). Duplicate column names are kept, and each result set (several per MySQL procedure) is stored separately.
- Rows are stored as JSON chunks of up to 1,000 rows or 1 MiB. Pages of up to 1,000 rows are read back by offset.
- The 1 GiB total is shared by all executions. Five per cent of it (at most 64 MiB) stays free for metadata.
- The MCP preview budget (256 KiB per execution) applies to what MCP may receive. It is enforced when results are disclosed to MCP (step 7).

## Restart and retention

- At startup, `reconcile()` marks executions that were `running` or `cancel_requested` as `interrupted`, with the note "not run again". Their outcome is:
  - read-only: `none`;
  - single transaction: `rolled_back` (the server rolls back a dropped connection's open transaction), or `unknown` if COMMIT had begun;
  - per statement: `unknown` if a write was running, otherwise `partial_commit` or `none`.
- Queued executions stay queued and are authorized again when they start. Nothing is replayed.
- `cleanup()` runs every 10 minutes:
  - working results expire after 24 hours;
  - retained results expire after their days (at most 7);
  - execution metadata is deleted after 90 days.

## Visibility

Owners see their own executions, and administrators see all of them. MCP clients see only their own user's executions; disclosure of rows to MCP is decided in step 7.
