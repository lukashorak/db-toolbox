# Database Workbench Requirements

A small, self-hosted database workbench for MySQL and PostgreSQL, initially used by Lukas and designed to accommodate additional users later. The GUI, API and MCP interface share execution, authorization, history and result storage. Deployment uses Docker Compose managed through Dockge, with an existing Keycloak instance and a new realm.

Status: requirements baseline, 7 November 2026. Functional scope is agreed, including separate human authorization for large MCP disclosures and live monitoring with aggregated slow-query statistics. Implementation choices and configurable defaults remain proposals where marked.

# First release scope

| Area         | Included                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Connections  | MySQL and PostgreSQL over direct TCP or verified TLS; connection testing and read-only policy                                        |
| Workbench    | Multiple editor tabs; current statement, selection or entire script within the active tab; SQL writes when authorized                |
| Transactions | Sequential execution with a transaction per statement or one transaction for a supported script; manual transaction control proposed |
| Explorer     | Databases, schemas, tables, columns, keys, indexes, views and available routine definitions; viewing only                            |
| Results      | Preview of at most 1,000 rows; explicit full execution; CSV and JSON export of all captured rows                                     |
| Organization | Named saved queries in nested folders; execution history and optional retained results                                               |
| MCP          | Authenticated HTTP endpoint, configurable profiles, schema discovery, query execution, results, exports and monitoring               |
| Monitoring   | Tool activity and target database activity, including queries started by other applications                                          |
| Operations   | Background execution, timeout and cancellation, retention limits, mounted export folder                                              |

A visual data or schema editor, scheduled executions, team-sharing UI and cloud export destinations are deferred. SSH tunnels are the next connectivity priority. VPN routing remains a future deployment option. “Run all” means all statements in the active tab, not all open tabs.

# Component boundaries

Proposed implementation: one repository with three logical components, initially packaged as one application image.

| Component       | Responsibility                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| API and core    | Authentication context, authorization, database adapters, jobs, transactions, monitoring, SQLite persistence and exports |
| MCP integration | Protocol handling and bounded tool responses; delegates operations to the same core used by the API                      |
| GUI             | Connection management, editor, explorer, results, history, monitoring and MCP configuration                              |

The core owns database sessions and persistence. The browser does not own query lifetimes. The MCP adapter must not implement an independent permission system or connect to databases directly.

Proposed stack: TypeScript on a supported Node.js LTS release, Svelte for the GUI and the official MCP SDK. Use a server-side job runner backed by SQLite; no Redis, external queue or additional application database in the first release. A single running backend instance is the initial deployment model. Exact library versions are selected and pinned during implementation.

# Authentication and read only policies

Use a new realm in the existing Keycloak instance. Keycloak provides identity and application roles; the core enforces those roles alongside connection and MCP-profile restrictions stored in SQLite. Every execution and sensitive action records the stable Keycloak subject, source interface and applicable profile.

The visual explorer is read-only because editing controls are deferred. This does not prevent authorized SQL INSERT, UPDATE, DELETE or DDL in the workbench.

Three independent restrictions apply to target database operations:

| Restriction                    | Effect                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------- |
| Stored connection is read-only | Every caller using that connection is restricted                                 |
| MCP profile is read-only       | Calls through that profile are restricted even when the connection allows writes |
| User is read-only              | That user cannot write through any interface                                     |

The most restrictive setting wins. A write requires permission from the user, the connection and, for MCP, the selected profile, as well as the target database account. An administrator role does not silently bypass a connection restriction. Policy changes are explicit and audited.

Permission to modify application configuration is separate from permission to modify target database data. A user may therefore save queries and retain results while having read-only database access.

Enforcement must exist in the core, not only in disabled GUI controls or MCP tool descriptions. Do not classify SQL by checking whether it starts with SELECT. Use dialect-aware validation, database read-only transactions where applicable, and appropriately restricted database accounts. Reject unsupported or ambiguous operations under a read-only policy. Session commands must not allow a caller to disable the restriction. Stored functions, writable CTEs, procedures, file-output operations and indirect side effects require explicit handling; a restricted database identity is the strongest boundary.

Store ownership and actor identifiers from the start, but defer organization tenancy, invitations and a sharing-permission editor.

# Connections and database explorer

A connection has a name, engine, host, port, default database, optional schema, credentials, TLS configuration, enabled state and read-only setting. Show the engine version and tested capabilities. Distinguish a saved connection from an open physical session.

Verify certificates and hostnames by default for TLS. Support a custom CA. Encrypt stored credentials using a deployment secret kept outside SQLite; never return credentials through ordinary API, MCP or log responses. Database accounts should carry only the privileges needed for their intended use.

Use bounded, lazily opened pools. Keep monitoring and cancellation capacity available when query sessions are busy. A connection test reports connectivity, authentication and capability failures separately where possible.

The explorer lists objects the account can see, with explicit loading and refresh. Show columns, types, nullability, defaults, keys, indexes, view definitions and other supported metadata. PostgreSQL databases and schemas remain distinct; changing to another PostgreSQL database opens an appropriate session. Viewing table data uses the normal query and preview rules.

Define connection transport behind an interface so SSH can be added without changing execution or authorization. Later SSH routing must cover queries, metadata, monitoring and cancellation. A future VPN can provide container network access; an embedded VPN-management interface is outside this release.

# Workbench and transaction behavior

Each tab has its own SQL text, selected connection and database context, execution settings and result sets. Support running the current statement, selected SQL or the script in that tab. Parse SQL with dialect awareness, including comments, quoted semicolons and PostgreSQL dollar-quoted text.

| Mode                           | Success and failure behavior                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Transaction per statement      | Execute sequentially; each successful statement commits independently; stop on the first error by default       |
| One transaction for the script | Execute sequentially on one pinned session; commit after all supported statements succeed; roll back on failure |
| Manual transaction, proposed   | Keep a transaction on a pinned session; expose begin, commit, rollback and transaction status                   |

Earlier commits remain committed when a later statement fails in per-statement mode. The UI must make that visible. Continue-on-error may be an explicit option for that mode. It is not the default for a single-transaction script.

Reject contradictory combinations of automatic transaction management and embedded transaction-control commands. Only one statement executes at a time on a given transaction session. The browser can disconnect without destroying the server-side session, but idle manual transactions expire and roll back after a configurable timeout.

Atomic script execution cannot be promised for every SQL statement. In particular, MySQL has statements that implicitly commit and operations that cannot be rolled back. Detect known incompatible statements before starting the script and explain the required alternative mode. Nontransactional storage engines must not be presented as transactional. See the [MySQL transaction limitations](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html).

Set timeouts per execution with server-side maximums. Report statement results separately, including duration, result columns, affected-row count, errors and commit state. Transaction outcome and result-capture completeness are separate facts.

# Preview full execution and export

The ordinary result preview contains at most 1,000 rows. This is a total preview boundary, not a page size that can be bypassed by requesting subsequent pages. Pagination or virtualization operates within the available preview.

For supported read queries, capture enough information to report that additional rows exist without automatically fetching the entire result or issuing a separate expensive COUNT. A row limit restricts returned data; it does not guarantee that the database scans only that many rows.

Fetching the complete result requires an explicit full-execution action. The GUI can continue to show only the first 1,000 rows while the core captures all rows for export. Full execution remains bounded by configured time and storage quotas; “all” means complete within an execution that actually completed, not silently truncated at a hidden limit.

If a query was previously run only as a preview, a full run is a new execution. Make that clear because the database contents may have changed. Once a full result is retained, repeated CSV or JSON exports use that captured result and do not execute SQL again.

Never rerun a modifying statement to obtain missing output. For statements that both modify data and return rows, choose the capture mode before execution. Reaching a preview boundary must not be treated as successful cancellation or as proof of a rollback. The 1,000-row limit is not a limit on how many rows an UPDATE or DELETE can affect.

Each result records completeness, captured rows, bytes and expiry. Distinguish complete, preview-limited, interrupted, quota-limited and expired results. A preview-only export must be labeled as such; it must not be offered as a full export.

CSV includes every captured row in the chosen result set. JSON preserves column metadata and rows without losing duplicate column names. Define representations for NULL, decimal precision, large integers, timestamps and binary values; do not silently convert large integers to imprecise JavaScript numbers. Multiple SQL result sets remain individually identifiable.

Export files are written to a configured mounted folder using server-controlled paths. Publish the final filename only after the export finishes. Downloads require authorization. Retention applies to export files as well as stored result chunks.

Sending a large result to an AI client requires a separate authenticated human action. Running a full query or generating a full CSV does not grant permission to disclose that result through MCP.

# Background jobs cancellation and recovery

Persist an execution record before acknowledging submission. Return an execution ID immediately, then expose status and results separately. The GUI can reconnect, refresh or close completely while accepted work continues on the server.

Track queued, running, cancellation requested and terminal states. Terminal outcomes distinguish success, failure, cancellation, timeout, interruption and uncertain database outcome when the connection is lost at a critical point. Keep statement-level and transaction-level outcomes.

Cancellation and timeout handling use the database adapter and verify the result when possible. A cancellation request is not evidence that a statement stopped. Do not reuse a pooled session until it is known to be clean; roll back or discard it as required.

After an application restart, reconcile queued jobs and mark lost in-flight work appropriately. Do not automatically replay an execution that may already have modified the database. A restart does not promise resumption of an open database transaction.

Submission deduplication prevents an HTTP retry or repeated MCP request with the same request key from starting the same execution twice. Reusing a key with different SQL or settings must be rejected. Authorization is checked at submission and again before queued work starts.

Control the tool's own running executions in the first release. Monitoring other applications' sessions does not automatically grant permission to terminate them; external-session termination is deferred unless explicitly added.

# Saved queries history and persistence

Saved queries have a name, folder, SQL text, optional default connection, owner and created/updated timestamps. Folders can be nested and moved. Editing a saved query must not rewrite the historical SQL associated with a previous execution.

Execution history stores the SQL snapshot, relevant parameters, connection, actor, source, transaction mode, timings, status, result metadata and retention policy. Store actions and application audit events separately from database monitoring samples.

SQLite persists configuration, queries, job records, execution metadata, logs, samples and optionally ordered result chunks. Avoid one giant result JSON value. Batch short writes so streaming a large result does not hold a long SQLite write transaction.

Use WAL on a local persistent volume, with an intentional busy-timeout, checkpoint and backup strategy. SQLite WAL relies on coordination between processes on the same host and is unsuitable for a shared database file on a network filesystem. See [SQLite WAL documentation](https://www.sqlite.org/wal.html).

Result retention is optional beyond the working preview. Allow the user to retain an execution for a bounded period and see its expiry. Time and byte quotas are both required. Cleanup removes results and generated exports while preserving history for its independently configured period. Reserve space for metadata so result growth cannot consume all storage.

Protect SQL, parameters and captured data as application data. Application diagnostics must not dump tokens, connection passwords or entire result sets.

# MCP behavior and configuration

Expose an authenticated HTTP MCP endpoint. Its configuration screen shows the endpoint, available profiles, effective restrictions and a usable Claude Code setup example. Profiles identify an allowed set of stored database connections, read/write policy, timeouts and result limits. The core validates profile access; accepting an arbitrary profile ID from a request is not authorization.

| Tool family | Expected behavior                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------- |
| Discovery   | List authorized connections and inspect database structure without exposing secrets                |
| Execution   | Submit SQL or a saved query with explicit transaction and capture modes; return an execution ID    |
| Control     | Inspect status, request cancellation and manage an authorized manual transaction                   |
| Results     | Retrieve bounded structured previews and result metadata; preserve completeness information        |
| Export      | Produce CSV or JSON from a captured result; distinguish file creation from disclosing its contents |
| Monitoring  | Read authorized live activity and available aggregate statistics                                   |

Reuse the same core permission checks, job lifecycle and result store as the GUI. Keep tool names, input schemas, error codes and structured outputs stable. Responses include identifiers and enough metadata for the client to choose its next action without dumping large datasets into context.

Use bounded polling for long-running queries so execution is independent of the lifetime of an MCP request or connection. Support cancellation without requiring the original request to remain open. Resource and export endpoints must enforce the same restrictions as tools.

Use Keycloak OAuth for the MCP client, including authorization discovery, appropriate token audience validation and tested refresh/reconnection behavior. The GUI login client and the MCP client have distinct configurations. Check the existing Keycloak version before choosing client registration and audience-binding configuration. Keycloak documents both newer experimental capabilities and configuration alternatives, so do not require a server-wide experimental feature merely to make the first release work. See [Keycloak MCP integration](https://www.keycloak.org/securing-apps/mcp-authz-server).

A larger-result approval must be attributable to the authenticated human and scoped to the result, profile, permitted amount and expiry. An AI-supplied boolean is not human approval. Paging, resources, export links and subsequent calls against the same result must not bypass that rule. Treat database text as data, including text that resembles instructions to an AI.

# Database wide monitoring

Monitoring of activity outside this tool is a first-release requirement. Keep the application execution history and the target database monitoring views visibly distinct.

| View            | Content                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Activity        | Connected sessions, running SQL, elapsed time and available user/database/client details              |
| Blocking        | Lock waits and blockers where supported and authorized                                                |
| Overview        | Connection counts and relevant database counters, with timestamps and clear units                     |
| Slow statements | Ranked aggregated statements by total time, average time, maximum time and call count where available |
| Tool history    | Exact executions submitted through this application, including per-statement errors and durations     |

PostgreSQL adapters use available activity and statistics views; aggregated statement analysis uses pg_stat_statements when installed and accessible. It aggregates executions and may require server configuration and a restart when first enabled. See [PostgreSQL monitoring](https://www.postgresql.org/docs/current/monitoring-stats.html) and [pg_stat_statements](https://www.postgresql.org/docs/current/pgstatstatements.html).

MySQL adapters use available process/session views, status counters, lock information and Performance Schema. Statement digest summaries group executions; they are not a complete chronological slow-query log. See [MySQL statement summaries](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-statement-summary-tables.html).

Native slow-log ingestion is deferred. The first release provides live database-wide activity, blocking and aggregated slow-statement statistics, alongside the tool's exact execution history. SQL-readable native logs, filesystem logs and cloud-provider logs can be integrated later.

Probe capabilities and privileges. Show “unavailable” or “insufficient permission” rather than a misleading zero. Do not automatically install extensions, change logging settings, reset server counters or restart a database.

An optional monitoring credential may have different visibility from the query credential. It can execute only the adapter's fixed monitoring operations, not arbitrary workbench or MCP SQL. Monitoring output remains subject to caller authorization and result-size policy.

Record sample timestamps and handle counter resets when calculating rates. Polling is bounded and configurable. Dashboard refreshes cannot provide a complete record of every short-lived query; present sampled and aggregated data with their actual coverage.

# Deployment and operational defaults

Provide a Docker Compose file suitable for Dockge, a documented environment template, health checks and a non-root application image. Connect to the existing Keycloak instance; do not deploy an additional Keycloak database inside the application stack.

Persist SQLite and exports in mounted local directories. Deploy behind HTTPS with the correct external URL and trusted proxy configuration so GUI login, OAuth callbacks and MCP discovery agree. Provide documented upgrade, migration, backup and restore procedures, including separate handling of the credential-encryption key.

The following defaults are proposals and remain configurable.

| Setting                         | Proposed default                                                 |
| ------------------------------- | ---------------------------------------------------------------- |
| Preview maximum                 | 1,000 rows, with an additional response-byte limit               |
| Ordinary execution timeout      | 30 seconds                                                       |
| Explicit full execution timeout | 5 minutes, within an administrator-defined maximum               |
| Manual transaction idle timeout | 5 minutes                                                        |
| Working result retention        | 24 hours                                                         |
| Explicitly retained results     | 7 days                                                           |
| Execution and audit metadata    | 90 days                                                          |
| Result storage budget           | Per-execution and total byte quotas, sized during implementation |
| Monitoring refresh              | 15 seconds while viewing; persistent sampling configurable       |

These defaults are not database performance guarantees. Actual behavior depends on the connected engine, privileges and workload.

# Confirmed decisions

1. **Large result disclosure to MCP.** Sending more than the normal preview allowance requires a separate authenticated human action. Full execution and full export do not grant that permission. Start with a configurable 1,000-row boundary plus a byte budget; scope each approval to an execution, MCP profile and expiry.

2. **Monitoring scope.** Live database-wide activity, blocking and aggregated slow-statement statistics are sufficient for the first release. The tool retains its own exact execution history. Native external slow-log ingestion is deferred.

Before integration testing, collect the existing Keycloak version, externally reachable URLs and representative MySQL/PostgreSQL versions. Credentials can be supplied through deployment secrets when needed. These installation details do not prevent core implementation planning.

# Acceptance criteria

1. A writable connection works through the GUI for a permitted user, while a read-only MCP profile rejects the same modifying operation. Every combination of the three restrictions is tested.

2. Restrictions cannot be disabled through session commands or bypassed through another API or MCP route. Read-only cases cover indirect writes and unsupported SQL.

3. A query returning 1,200 rows shows no more than 1,000 in preview. An explicit full run exports exactly 1,200 rows in both CSV and JSON.

4. Downloading a retained full result does not run SQL again. Exporting a preview cannot silently pretend to be a full export. A modifying statement is never replayed for export.

5. Large-result disclosure requires a separate human approval and is enforced across tool calls, pages, resources and downloads, not only within a single response.

6. A script that fails halfway has different, correctly reported outcomes in per-statement and single-transaction modes. Test both engines and MySQL implicit-commit limitations.

7. Closing and reopening the browser leaves an accepted background execution accessible by its execution ID.

8. Cancellation, timeout, idle-transaction expiry and lost connections leave an accurate status and a clean or discarded database session.

9. Restarting the application never automatically repeats potentially completed modifying SQL. Repeated submissions with one request key do not duplicate a job.

10. Retention and byte quotas clean up stored results and export files while preserving metadata according to its own policy. Partial results are visibly incomplete.

11. Exports preserve NULL, Unicode, decimal precision, large integers, timestamps, duplicate column names and multiple result-set identities.

12. Queries started from another database client appear in monitoring when the database account has the required visibility. Missing extensions or privileges produce an explicit unavailable state.

13. GUI and MCP authentication succeed with the configured Keycloak realm; expired tokens, wrong audiences, disabled profiles and unauthorized connection access are rejected.

14. Compose deployment, SQLite migration and backup/restore are exercised without exposing credentials in ordinary logs or responses.

# Implementation sequence

1. Establish the repository, core domain model, SQLite migrations, permission evaluation and database-adapter contracts. Build the execution and result-state model before UI work.

2. Prove authenticated MCP access with the intended Keycloak configuration and Claude Code version. Test token audience, refresh and profile enforcement early.

3. Implement MySQL/PostgreSQL execution, transactions, cancellation and result capture against disposable test databases. Add full exports and retention.

4. Build the connection manager, explorer, tabbed workbench, saved queries and execution history on the same core API.

5. Add database-wide monitoring with capability discovery, live activity, blocking and aggregated slow-statement statistics.

6. Complete Compose packaging, configuration examples, integration tests and operating documentation.

The first usable milestone should connect to both engines, run a background query, reconnect to its status and export its complete captured result. SSH support follows the first release. Scheduling later reuses the same job submission, authorization, capture and export services.
