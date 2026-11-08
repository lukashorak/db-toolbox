# Database accounts and server settings

The workbench connects with the accounts you store on each connection. Three kinds are worth having per database:

| Account    | Used for                                                                           | Needs                                                 |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Read-only  | Read-only connections: GUI users and Claude Code browsing data                     | `SELECT` only, so read-only holds in the database too |
| Writer     | Writable connections, for people with `query:write`                                | What the work needs, and no more                      |
| Monitoring | The optional monitoring account of a connection: other sessions, locks, statistics | Read access to activity and statistics views          |

The read-only policy of the workbench refuses writes before they run, and runs reads in read-only transactions. A read-only database account is still the stronger guarantee ([security.md](security.md#accepted-risks)). The connection test shows what an account can do: whether it can write, and which monitoring views it can read.

Use a strong password for each account, generated per account. The workbench stores it sealed; it never shows or logs it.

## PostgreSQL (version 16 or later; tested with 16 and 18)

### Read-only account

Run as the database owner or a superuser. `pg_read_all_data` (PostgreSQL 14 and later) covers every schema, including tables created later:

```sql
CREATE ROLE workbench_ro LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE app TO workbench_ro;
GRANT pg_read_all_data TO workbench_ro;
ALTER ROLE workbench_ro SET default_transaction_read_only = on;
```

To limit it to one schema instead:

```sql
GRANT USAGE ON SCHEMA public TO workbench_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO workbench_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE app_owner IN SCHEMA public GRANT SELECT ON TABLES TO workbench_ro;
```

### Monitoring account

`pg_monitor` lets an account see every session's query, lock waits and all statement statistics:

```sql
CREATE ROLE workbench_monitor LOGIN PASSWORD '<generated>';
GRANT CONNECT ON DATABASE app TO workbench_monitor;
GRANT pg_monitor TO workbench_monitor;
```

Without it, the Monitoring screen still works but shows limited visibility (other sessions without their queries), never made-up zeros.

### Statement statistics (`pg_stat_statements`)

The official `postgres` Docker image does not load it. Add the library to the server's command, restart, then create the extension in each database you monitor:

```yaml
# in the PostgreSQL service of its compose file
command: postgres -c shared_preload_libraries=pg_stat_statements
```

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Until then, **Slow statements** says "pg_stat_statements is not installed" with these steps.

### TLS and networking for a PostgreSQL container on the same server

The official image runs without TLS. On the same Docker host, the simplest safe setup is a private Docker network:

- the workbench joins it ([`deploy/sensay-learning/compose.override.yaml`](../deploy/sensay-learning/compose.override.yaml));
- the connection's host is the PostgreSQL container's name, with TLS `disable` (the connection shows "clear text");
- PostgreSQL publishes no port to the internet.

If the workbench reaches PostgreSQL over a network you do not control, enable TLS in PostgreSQL (`ssl=on` with a certificate) and use `verify-full` with its CA.

## MySQL (8.4)

### Read-only account

```sql
CREATE USER 'workbench_ro'@'%' IDENTIFIED BY '<generated>';
GRANT SELECT, SHOW VIEW ON app.* TO 'workbench_ro'@'%';
-- Optional: lets the Explorer show the bodies of procedures and functions it did not define.
GRANT SHOW_ROUTINE ON *.* TO 'workbench_ro'@'%';
```

### Writable account

For connections that may change data. To run a script as **one transaction**, the workbench checks that every table it writes can roll back. That includes the tables that triggers write, and MySQL shows a table's triggers only to accounts that hold `TRIGGER` on it, granted directly or through an active (for example default) role. With `partial_revokes` on, a schema-level `REVOKE TRIGGER` hides that schema's triggers again, unless `TRIGGER` is granted on the table itself. Without that privilege, single-transaction writes to the table are refused: use per-statement mode, or grant it. The same goes for stored functions that a script or trigger calls: MySQL shows a function's body only to its definer and to accounts with `SHOW_ROUTINE`, and a view's definition only with `SHOW VIEW`; a body or definition that is hidden cannot be checked, nor can a view over relations the account cannot see (a definer view over tables it has no privileges on).

```sql
CREATE USER 'workbench_rw'@'%' IDENTIFIED BY '<generated>';
GRANT SELECT, INSERT, UPDATE, DELETE, SHOW VIEW ON app.* TO 'workbench_rw'@'%';
-- Lets the single-transaction check see triggers. TRIGGER also allows creating and dropping
-- triggers, so grant it only where that is acceptable.
GRANT TRIGGER ON app.* TO 'workbench_rw'@'%';
-- Only if scripts call stored functions in single-transaction mode: lets the check read their bodies.
GRANT SHOW_ROUTINE ON *.* TO 'workbench_rw'@'%';
```

### Monitoring account

`PROCESS` shows every session's query; `performance_schema` gives lock waits and statement digests:

```sql
CREATE USER 'workbench_monitor'@'%' IDENTIFIED BY '<generated>';
GRANT PROCESS ON *.* TO 'workbench_monitor'@'%';
GRANT SELECT ON performance_schema.* TO 'workbench_monitor'@'%';
```

Without them, the Monitoring screen shows only the account's own sessions and says why.

### DigitalOcean Managed MySQL

- **Trusted sources**: add the Hetzner server's public IP address in the DigitalOcean control panel (Databases → your cluster → Settings → Trusted sources). Otherwise the connection test reports a connectivity failure.
- **Host, port and TLS**:
  - use the cluster's host name (for example `db-mysql-…-do-user-….db.ondigitalocean.com`), not an IP address;
  - the port is usually `25060`;
  - DigitalOcean requires TLS. Download the cluster's CA certificate (Connection details → Download CA certificate), paste it into the connection's **Custom CA**, and choose `verify-full`. The workbench refuses `verify-full` with an IP address, because the MySQL driver only checks names.
- **Accounts**: create the users above as `doadmin` with SQL, or add them in the control panel and grant with SQL. If DigitalOcean refuses a grant such as `PROCESS`, monitoring falls back to limited visibility; the connection test shows what is missing.
- **`sql_require_primary_key`** is on by default on DigitalOcean. `CREATE TABLE` without a primary key fails there, whichever client runs it.
- **Connection limits** depend on the plan. Each stored connection uses at most:
  - 2 sessions for running SQL (`CONCURRENCY_PER_CONNECTION`);
  - 1 for metadata;
  - 1 for cancellation;
  - 1 for monitoring.
- Cancelling uses `KILL QUERY` on the account's own sessions, which needs no extra privilege.
