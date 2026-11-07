# GUI

A Svelte 5 single-page app (`packages/web`) served by the API process. It talks to the server only through `/api/v1` and `/api/v1/events` with the signed-in user's token.

## Foundation (step 9)

- **Design tokens.** `src/app.css` holds the visual system of the prototype as CSS variables:
  - colors for surfaces, text, accent, status, policy, environment, connectivity and SQL;
  - type scale, spacing, radii and the overlay shadow.
- **Components** (`src/components`):
  - `StatusPill` — execution, transaction, capture and monitoring states, always with a label and an icon;
  - `PolicyChip` — square, with a lock, naming the read-only layers;
  - `EnvLabel`, `ConnectivityDot`, `KeyValueList`;
  - `TreeRow` (`treeitem` roles and arrow keys);
  - `DataGrid` — virtualized for at most 1,000 rows, NULL shown as _NULL_, binary labelled, duplicate column names kept, keyboard row selection;
  - `SidePanel` — focus moves in and is trapped, Escape closes, and focus returns to the opener;
  - `ConfirmPanel` (lists the consequences), `Banner`, `Toasts` (polite live region), `Menu`, `Listbox`.
- **Shell.**
  - Sidebar navigation filtered by permissions, with badges for running executions and pending MCP approvals.
  - A header with a **Jobs** popover kept live by server-sent events, and the account menu.
  - A skip link.
  - A "Demo data" flag appears only when built with `VITE_DEMO=1`.
- **Sign-in** (`src/lib/auth.ts`):
  - Keycloak with the authorization code flow and PKCE through `oidc-client-ts`, from `GET /api/v1/client-config`. The app never shows a password form.
  - Tokens are kept in session storage, so a reload keeps the session, and are renewed silently with the refresh token.
  - A lost session shows a "Sign in again" dialog. Drafts stay in the browser and executions keep running on the server.
  - A user without a role sees an access-denied page; a sign-in failure has its own page.
- **Live status** (`src/lib/live.ts`):
  - `fetch()`-based server-sent events, with reconnects;
  - after every (re)connect, the recent executions are fetched again by ID, so nothing is lost while the stream was down (AC7).
- **Drafts.** Tabs and SQL drafts are saved per user in local storage. They are restored after a reload, and the app still works when storage is blocked.

## Connections, Explorer and Saved queries (step 10)

- **Connections.**
  - The list shows engine, environment label, policy chip and connectivity from the last test.
  - The detail panel shows settings, the last test (steps, capabilities, warnings) and what uses the connection.
  - Add and edit happen in one form. A blank password keeps the stored one, the custom CA is replaced only when pasted, the monitoring account is optional, and SSH is shown as planned.
  - **Test connection** runs on the unsaved settings, separately from saving. Validation and name conflicts show at the field.
  - Disable, enable and delete each confirm with their consequences, including the saved queries and MCP profiles that refer to the connection.
- **Explorer.**
  - A schema tree per connection, with a filter and refresh, and object details: columns, keys, indexes and definitions, plus routine definitions.
  - **Open SELECT** opens a Workbench tab. **Preview data** runs a 100-row preview as a normal execution.
  - Its states are explicit:
    - loading;
    - stale (the last data, with the time, when a refresh fails);
    - missing or renamed objects;
    - unavailable, and insufficient permission, with the database's reason;
    - empty only when it really is empty.
- **Saved queries.**
  - Nested folders and search.
  - Queries can be opened (in a new Workbench tab), created, renamed, moved, duplicated and deleted.
  - Name conflicts are reported in the form.
  - Folder deletion lists its consequences, whether contents move up or are deleted.

## Workbench, results and Executions (step 11)

- **Workbench.**
  - Each tab has its own connection, SQL and run settings: capture (preview or full), transaction mode (per statement, optionally continuing after errors, or single transaction), timeout and how long to keep results. The settings are locked while the tab has a run going.
  - The CodeMirror 6 editor has the PostgreSQL or MySQL dialect, completion from the default schema's tables, formatting (`sql-formatter`), search and a shortcuts panel.
  - The Run button names its target precisely: "Run statement 2 · line 5", or "Run selection". The target is highlighted in the editor. Statement ranges come from the server's own splitter through `POST /api/v1/sql/check`, so the editor and the executor never disagree.
  - Preflight problems, such as read-only violations, show before running. After a run, error positions are marked in the editor.
- **Results.**
  - Separate badges for status, transaction outcome and capture, plus the policy.
  - Statement tabs with command, line, affected rows, duration, errors and notices.
  - A grid with sorting and filtering, labelled as applying only to the rows shown, and a row inspector.
  - Actions that say why they are unavailable when they are:
    - **Run full result** — a new execution, for reads only;
    - **Export full result** — complete results only;
    - **Export preview only** — labelled partial;
    - **Share full result with MCP** — a scoped approval for one profile with an expiry, through `POST /executions/{id}/results/{index}/share`.
  - Unknown outcomes come with guidance.
- **Executions.**
  - Filters for source, status, connection and time.
  - The detail view shows:
    - the SQL snapshot, statements and timeline;
    - transaction outcome and capture;
    - exports with download, disclosure, and the request key;
    - retain (`POST /executions/{id}/retain`), delete stored results, cancel, and open in the Workbench.
- Runs of a tab are kept by ID with the tab. After a reload they are fetched again, and the Executions screen finds them from any browser (AC7).

## Monitoring, MCP access, Settings and audit (step 12)

- **Monitoring** (`/monitoring`, needs `monitor:read`).
  - A connection picker; tabs for Overview, Activity, Blocking and Slow statements.
  - Each sample shows when it was taken and with which account. Pause, resume and Refresh; the refresh interval comes from the execution defaults (15 seconds unless an administrator changes it).
  - When a refresh fails, the last sample stays with a warning. Each part (sessions, lock waits, counters, statements) shows `available`, `limited` or `unavailable` with the server's reason, for example "pg_stat_statements is not installed".
  - Sessions started by this tool link to their execution. Counter rates handle a statistics reset.
- **MCP access** (`/mcp-access`; `/mcp` is the MCP endpoint itself).
  - The endpoint, the OAuth client and a Claude Code setup command: `claude mcp add --transport http --client-id workbench-mcp --callback-port 8765 workbench <url>`.
  - Profiles with their effective access per connection (`GET /profiles/{id}/access`). Administrators add and edit them: name, OAuth client, connections, read-only, enabled and limits.
  - The approval inbox: pending requests with Review (rows and expiry), Approve and Deny; active approvals with the rows used and Revoke. New requests and usage arrive live, and the sidebar shows the number pending.
  - The latest MCP executions.
- **Settings** (`/settings`).
  - Identity, roles and permissions, and sign out.
  - Execution defaults, editable by administrators and read-only for everyone else.
  - Captured-result storage against the quota (`GET /settings/storage`), with a warning above 80 %, and the list of retained results.
  - For administrators, audit events filtered by action prefix and source. Sensitive details are redacted before they are stored.

## Tests

```sh
npm run test:web      # component tests (vitest + Testing Library, jsdom)
npm run build && scripts/integration/start.sh keycloak
KEYCLOAK_TEST_URL=http://127.0.0.1:18080 npm run test:e2e   # Playwright smoke
```

- The Playwright smoke test signs in through the real Keycloak login page, navigates, checks that a draft survives a reload, watches an execution change status live, and checks the access-denied page.
- The screen flows (`test/e2e/screens.test.ts`, which also need `POSTGRES_TEST_URL`) cover:
  - the connection lifecycle: test before saving with the test CA, save, edit with the password kept, test, disable, enable, delete with references;
  - the Explorer: details, keys, preview data, Open SELECT into the Workbench, and the insufficient-permission state of a read-only account;
  - saved-query management: folders, a name conflict, rename, duplicate, move, folder deletion with its contents, and opening a query in the Workbench.
- The Workbench flows (`test/e2e/workbench.test.ts`) cover:
  - preview, then full result, then CSV and JSON exports, with the 5,000 rows counted in the downloaded files (AC3);
  - partial commit per statement versus rollback in a single transaction (AC6);
  - a running execution recovered after a reload and in a new browser (AC7).
- The administration flows (`test/e2e/admin.test.ts`) cover:
  - adding a profile in the GUI, then an MCP SDK client (Keycloak token for `workbench-mcp`) that reads its 1,000-row allowance and gets `approval_required`; the request appears live, is approved in the inbox, used for the remaining 200 rows, revoked, and the next read is refused again (AC5);
  - execution defaults saved by an administrator, storage use, and the audit trail filtered to disclosure events;
  - a lock wait between two outside PostgreSQL sessions shown in Blocking with both queries, and Slow statements explained as unavailable because `pg_stat_statements` is not installed (AC12).
