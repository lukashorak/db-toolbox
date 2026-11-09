# Identity: Keycloak, GUI and MCP sign-in

Database Workbench uses a dedicated realm in the existing Keycloak. Keycloak holds users and roles. The workbench never sees a password and has no client secret.

## Realm

Generate the realm import and import it into Keycloak:

```sh
npm run -s keycloak:realm -- --public-url https://db.example.com > workbench-realm.json
```

Import it in the admin console (**Create realm → Resource file**) or with `kc.sh import --file workbench-realm.json`. The file contains no users and no secrets. Options:

- `--realm` (default `workbench`);
- `--callback-port` (default `8765`), the local port Claude Code listens on during sign-in.

| Item            | Value                                                                                                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realm roles     | `query:read`, `query:write`, `monitor:read`, `admin`. Assign them to users or groups. A user without any of them is refused (`no_role`).                                                |
| `workbench-gui` | Public client, authorization code flow with PKCE S256. Redirect URI `<PUBLIC_URL>/auth/callback`, web origin `<PUBLIC_URL>`. An audience mapper adds `workbench-api`.                   |
| `workbench-mcp` | Public client, authorization code flow with PKCE S256. Redirect URIs `http://localhost:8765/callback` and `http://127.0.0.1:8765/callback`. An audience mapper adds `<PUBLIC_URL>/mcp`. |
| Token lifetime  | Access tokens live 5 minutes. Clients refresh them; the refresh lifetime follows the realm's SSO session settings.                                                                      |

Both clients keep Keycloak's built-in default scopes. The audience mappers sit on the clients so that no custom client scope has to be assigned.

To give a group of users a different MCP profile, add another public client with the same settings, for example `workbench-mcp-ops`, and bind a profile to it in the workbench ([decision 0021](decisions/0021-shared-mcp-profiles.md)).

## What the workbench checks

Every request carries an access token in the `Authorization: Bearer` header.

| Check                                                                                | Error code         | HTTP |
| ------------------------------------------------------------------------------------ | ------------------ | ---- |
| No bearer token                                                                      | `unauthenticated`  | 401  |
| Signature (realm JWKS, cached and refreshed on key rotation), RS256/PS256/ES256 only | `invalid_token`    | 401  |
| Issuer is `KEYCLOAK_ISSUER`                                                          | `invalid_token`    | 401  |
| Expiry, 30 seconds clock tolerance                                                   | `token_expired`    | 401  |
| Audience: `workbench-api` for the API, `<PUBLIC_URL>/mcp` for MCP                    | `wrong_audience`   | 401  |
| API tokens come from `workbench-gui`                                                 | `wrong_client`     | 401  |
| Access token (`typ` `Bearer`), not an ID or refresh token                            | `invalid_token`    | 401  |
| At least one workbench role                                                          | `no_role`          | 403  |
| MCP: the token's client (`azp`) is bound to a profile                                | `profile_unknown`  | 403  |
| MCP: that profile is enabled                                                         | `profile_disabled` | 403  |

401 responses carry a `WWW-Authenticate: Bearer` challenge. For `/mcp` the challenge includes `resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp"`. That document (RFC 9728) names Keycloak as the authorization server, which is how Claude Code finds where to sign in.

The profile is always taken from the token's client. A profile ID sent by a client is ignored.

## Endpoints

| Endpoint                                        | Auth      | Purpose                                                                 |
| ----------------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `GET /api/v1/client-config`                     | none      | Issuer, GUI client ID, redirect URIs and the MCP endpoint for the GUI   |
| `GET /api/v1/session`                           | GUI token | Signed-in user, roles, permissions and token expiry                     |
| `GET /.well-known/oauth-protected-resource/mcp` | none      | MCP protected resource metadata (also served without the `/mcp` suffix) |
| `POST /mcp`                                     | MCP token | Streamable HTTP MCP endpoint, stateless; `GET` and `DELETE` answer 405  |

## Connecting Claude Code

```sh
claude mcp add --transport http --client-id workbench-mcp --callback-port 8765 workbench https://db.example.com/mcp
```

Then run `/mcp` in Claude Code, choose **workbench** and sign in in the browser. The tools are described in [mcp.md](mcp.md).

What Claude Code does, according to its documentation:

- `--client-id` makes it use the pre-registered public client instead of dynamic client registration;
- `--callback-port` fixes its redirect URI to `http://localhost:8765/callback`, which the realm registers;
- it finds Keycloak through the protected resource metadata;
- it requests `offline_access` when Keycloak offers it, so it stays signed in beyond the browser session. Remove that scope from the `workbench-mcp` client to prevent this.

## Automated verification

- Unit tests sign tokens with a local key set and cover each row of the table above (`packages/core/test/identity.test.ts`, `packages/api/test/auth.test.ts`).
- Integration tests run against a Keycloak 26.4 container with a realm generated by `buildRealm` (`test/integration/keycloak.test.ts`):
  - GUI sign-in through the real login page with the authorization code flow and PKCE;
  - Keycloak refuses a missing code challenge and a wrong code verifier;
  - refresh, and expiry of a real token;
  - GUI and MCP tokens are not interchangeable; a user without a role is refused;
  - the official MCP SDK client discovers Keycloak through the protected resource metadata, signs in with PKCE and the `resource` parameter, then lists and calls tools.

```sh
scripts/integration/start.sh keycloak    # prints KEYCLOAK_TEST_URL=…
KEYCLOAK_TEST_URL=http://127.0.0.1:18080 npm run test:integration
scripts/integration/stop.sh
```

## Manual check with the real Keycloak and Claude Code

For production: Keycloak `https://kc.sensay-learning.com`, realm `db-tool`, public URL `https://db-tool.sensay-learning.com`, a current Claude Code. The setup steps are in [deploy/sensay-learning/README.md](../deploy/sensay-learning/README.md). Record the results in [implementation-status.md](implementation-status.md).

1. Import `deploy/sensay-learning/keycloak-db-tool.json` into realm `db-tool` (partial import), and assign `query:read` to a test user.
2. Start the workbench; `GET https://db-tool.sensay-learning.com/api/v1/client-config` shows the issuer `https://kc.sensay-learning.com/realms/db-tool`.
3. Under **MCP access**, create a read-only profile bound to `workbench-mcp`.
4. Add the server in Claude Code (`claude mcp add --transport http --client-id workbench-mcp --callback-port 8765 db-tool https://db-tool.sensay-learning.com/mcp`), then run `/mcp` and sign in.
5. Ask Claude Code to call `whoami` and `list_connections`. Expect the user, the profile and read-only access.
6. Wait more than 5 minutes and call `whoami` again: Claude Code refreshes the token without a new sign-in.
7. Disable the profile and call `whoami`: expect `profile_disabled`.
8. Remove the user's roles in Keycloak, sign in again: expect `no_role`.
