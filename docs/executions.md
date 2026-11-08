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

| Transaction outcome | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `not_started`       | Nothing ran                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `none`              | Nothing to commit: read-only, or no write succeeded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `committed`         | Every write is committed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `partial_commit`    | Per statement: some writes are committed, then the run stopped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `rolled_back`       | Single transaction: nothing is committed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `unknown`           | The connection was lost during a write or during COMMIT; capturing or storing a write's result failed (the write may have committed first); a procedure call or a PostgreSQL `DO` block failed (it may have committed part of its work); or, per statement, a MySQL write failed on a table that cannot roll back (MyISAM keeps the rows written before the error, also when a trigger or stored function wrote it) or whose engine cannot be established (a temporary table). A syntax error still reports `rolled_back`, and so does a missing table or privilege when nothing the statement reaches (its tables, their triggers, the functions and views it uses) writes a table that cannot roll back: such an error can come from inside a trigger after it wrote. Check the database |

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

- **Per statement** (default). Each write commits on its own (autocommit). Under a read-only policy, each statement runs inside its own read-only transaction, and in either mode a PostgreSQL view the script reads gets the same verdict as its definition: one that calls what the policy refuses directly (`dblink`, which writes over its own connection outside the read-only transaction, or file and large-object functions) is refused before running, also through views beneath it, at submission and again when the run starts. The run stops at the first error unless `continueOnError` is set. A cancel or timeout always stops it. A read that calls a function that may write counts as a write when the policy allows writing: a MySQL stored function that writes or cannot be checked, called directly or by a view the statement uses, or a PostgreSQL `VOLATILE` function outside `pg_catalog` that the session's search path reaches or a view it uses depends on (any overload of that name counts, and a path that puts a user schema before `pg_catalog` is followed). So does a PostgreSQL built-in that changes data (large objects such as `lo_create`); sequences are not counted, since PostgreSQL never rolls them back. It is recorded as a write before it starts, its outcome is reported like a write's (in one transaction too, and after a restart), and reaching the preview limit does not stop it, so the function runs for every row. The check gives way to a cancel and to the time limit; the statement then does not start.
- **Single transaction**. One transaction around the script, read-only when the policy is. Any failure rolls everything back. The outcome is set to `unknown` just before COMMIT and only then to `committed`, so a crash during COMMIT is never reported as committed. Statements that would break the promise are refused before running: transaction control, MySQL statements that commit implicitly, PostgreSQL statements that cannot run in a transaction block, MySQL tables that are not transactional (including `LOAD DATA` targets, the base tables of views, and unqualified names after a `USE` in the script, which are looked up in that database), MySQL writes whose tables cannot be determined (including views whose base tables cannot be read), MySQL `CALL`, because a procedure can commit on its own, MySQL `EXECUTE`, because the prepared statement may be DDL, and statements whose effects a rollback does not undo (`SELECT … INTO OUTFILE` or `DUMPFILE`, MySQL `TABLE` and `VALUES … INTO OUTFILE` or `DUMPFILE`, PostgreSQL `COPY … TO` a file or program and `COPY … FROM PROGRAM`, whose program runs on the server; PostgreSQL server actions that take effect at once, such as `pg_terminate_backend`, `pg_cancel_backend`, `pg_reload_conf`, `pg_stat_reset…`, replication slots (creating, copying, dropping, advancing them, or consuming their changes), replication origins, backups and recovery control; reading a PostgreSQL view that calls `dblink` or writes files, also through views beneath it, where an unqualified view name is checked in every schema; MySQL `SET GLOBAL` (including `SET GLOBAL TRANSACTION`), `SET PERSIST` and `SET PERSIST_ONLY`, because server configuration is not transactional). The MySQL storage-engine check covers the tables that triggers write, too, and what stored functions write, whether a statement calls them, a trigger does (`SET NEW.v = f()`) or a view the statement uses does (through views beneath it too). A trigger or function body it cannot analyze (control flow, cursors, handlers) or cannot see makes the statement unchecked; this check is skipped in read-only mode, where the read-only transaction stops those writes. For MySQL the storage engines are checked again when the run starts, against the connection as it is then (it may point at another database by now).

Statements that change session state mark the session dirty, and the session is discarded after the run. That includes temporary tables (and, in PostgreSQL, anything in `pg_temp`), which live as long as the connection and could shadow a permanent table for the next run, and session-level locks (PostgreSQL advisory locks, MySQL `GET_LOCK`), which closing the connection releases. MySQL `LAST_INSERT_ID(expr)` counts too: it sets what `LAST_INSERT_ID()` returns later on that connection, and a rollback does not undo it. Every session that is kept is also reset before it goes back to the pool (MySQL `COM_RESET_CONNECTION`, then the connection's character set again; PostgreSQL `DISCARD ALL`), so state that stored functions, triggers or procedures leave behind, which the statement analysis cannot see, does not reach the next run either. A session whose reset fails is closed.

## Cancellation and time limits

- Queued: cancelled at once.
- Running: the status becomes `cancel_requested` and the database is asked to cancel over the reserved control connection. The final status depends on what happened:
  - `cancelled` when the database confirms;
  - `succeeded`, with the note "Completed before the cancellation took effect", when the statement finished first (also a single MySQL `INSERT`, `UPDATE`, `DELETE`, `REPLACE` or `LOAD DATA`/`LOAD XML` import whose OK answer, with the rows it changed, arrives after the cancel: outside a transaction it has committed; a `CALL` stays cancelled, with an unknown outcome, since its answer counts only its last inner statement; so does any other MySQL statement that writes, such as a `SELECT` whose stored function wrote, when the server ends it without an error after the cancel: it may have finished and committed first, as an interrupted `SLEEP()` cannot be told apart from one that finished);
  - `unknown` when the connection was lost, including a connection that stopped answering: 5 s after the cancel or the time limit it is closed, whatever it was waiting for (a statement, `BEGIN`, `COMMIT`), so an execution cannot hold its slot or delay shutdown forever.
- The check after a failed MySQL write (whether everything it reached rolls back) gets the same bounds: after a cancel or the time limit it has the grace period, and if it cannot finish, the outcome is `unknown`.
- The time limit applies to the whole execution. Each statement runs with the time that is left, and the result is `timed_out`.
- A long read that streams many batches is stopped between batches as well. There the database has no running statement to cancel, and PostgreSQL's `statement_timeout` counts each fetch separately. A cancel or time limit therefore takes effect within one batch.
- In a single transaction, a cancel before COMMIT always rolls back, so the execution is `cancelled` even if the last statement finished. A COMMIT already under way is not interrupted: if it completes within the grace period, the execution is `succeeded` and `committed`, with the note "Completed before the cancellation took effect"; if the connection stops answering, the outcome is `unknown`.

## Capture

| Mode    | Rows kept                                                                         | Completeness                                   |
| ------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| preview | 1,000 per result set; a 1,001st row is read to detect "more available" (no COUNT) | `complete` or `preview_limited`                |
| full    | Everything within 100 MiB per execution and 1 GiB in total                        | `complete` or `quota_limited` (never complete) |

- When a read has enough rows, the database stops it. A statement that changes data (a procedure that returns rows and then writes, `INSERT … RETURNING`) always runs to its end; only its further rows are discarded.
- A result set cut short by an error, a cancel or a restart is `interrupted`. Results are removed after their retention and become `expired`. If even closing a result fails (the application database refusing writes), the periodic cleanup closes it later as `interrupted`, with the rows stored so far, and its retention counts from when the execution ended.
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
  - execution metadata is deleted after 90 days, but never before its results: an execution whose result is retained for longer is kept, with its export files, until that result expires.
- Retain chosen while a run is going applies to its results when it finishes.

## Visibility

Owners see their own executions, and administrators see all of them. MCP clients see only their own user's executions; disclosure of rows to MCP is decided in step 7.
