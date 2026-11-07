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

Screens still to come: the Workbench editor, results and executions (step 11); monitoring, MCP access and settings (step 12).

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
