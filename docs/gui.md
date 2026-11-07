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

Screens arrive in steps 10–12: connections, explorer and saved queries; the workbench editor, results and executions; monitoring, MCP access and settings.

## Tests

```sh
npm run test:web      # component tests (vitest + Testing Library, jsdom)
npm run build && scripts/integration/start.sh keycloak
KEYCLOAK_TEST_URL=http://127.0.0.1:18080 npm run test:e2e   # Playwright smoke
```

The Playwright smoke test signs in through the real Keycloak login page, navigates, checks that a draft survives a reload, watches an execution change status live, and checks the access-denied page.
