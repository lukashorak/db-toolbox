# HTTP API

The API serves the GUI and automation. It is generated from the same route definitions and zod schemas the services validate with.

- **OpenAPI 3.0:** `GET /api/v1/openapi.json` (public). Every operation lists its access rule. Contract tests check that each route appears in the document.
- **Authentication:** `Authorization: Bearer <access token>` from Keycloak client `workbench-gui` (audience `workbench-api`). `GET /api/v1/client-config` (public) tells the GUI where to sign in. See [identity.md](identity.md).
- **Code:** `packages/api/src/routes/v1.ts`. Each handler calls one core service with the caller's actor; permission checks live in core, not in the API.

## Resources

| Area         | Endpoints                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session      | `GET /session`                                                                                                                                                                              |
| Connections  | `GET/POST /connections`, `GET/PATCH/DELETE /connections/{id}`, `POST /connections/{id}/enable`, `…/disable`, `GET …/references`, `POST …/test`, `POST /connections/test` (unsaved settings) |
| Metadata     | `GET /connections/{id}/metadata/databases`, `…/schemas`, `…/schemas/{schema}/objects`, `…/schemas/{schema}/tables/{name}`, `…/schemas/{schema}/routines/{name}?signature=`                  |
| Executions   | `POST /executions`, `GET /executions`, `GET /executions/{id}`, `POST …/cancel`, `GET …/results/{index}/rows?offset=&limit=` (at most 1,000), `DELETE …/results`                             |
| Exports      | `GET /executions/{id}/exports`, `POST /executions/{id}/results/{index}/exports`, `GET /exports/{id}`, `POST …/regenerate`, `GET …/download`                                                 |
| Library      | `GET/POST /folders`, `PATCH/DELETE /folders/{id}?mode=`, `GET/POST /queries`, `GET/PATCH/DELETE /queries/{id}`, `POST …/duplicate`                                                          |
| MCP profiles | `GET/POST /profiles`, `GET/PATCH/DELETE /profiles/{id}`, `GET …/access`                                                                                                                     |
| Settings     | `GET/PATCH /settings/execution`                                                                                                                                                             |
| Audit        | `GET /audit?source=&actionPrefix=&actorSubject=&from=&to=&before=&limit=`                                                                                                                   |
| Live status  | `GET /events` (server-sent events)                                                                                                                                                          |

All paths are under `/api/v1`. Disclosure approvals (step 7) and monitoring (steps 9–10) are added with their features.

## Errors

Every error has the same shape:

```json
{ "error": "read_only_policy", "message": "Statement 1 (line 1) (DELETE) is not allowed …", "details": { … }, "requestId": "req-1a" }
```

Clients branch on `error`; `message` is for people and may change. The full list is in the OpenAPI `Error` schema. The codes that matter most:

| Code                                                                  | HTTP | Meaning                                                                                                                                       |
| --------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `validation_failed`                                                   | 400  | `details.fields` lists each problem                                                                                                           |
| `unauthenticated`, `token_expired`, `wrong_audience`, `invalid_token` | 401  | Sign in or refresh. The response has a `WWW-Authenticate` challenge                                                                           |
| `no_role`, `forbidden`                                                | 403  | Missing role or permission                                                                                                                    |
| `not_found`                                                           | 404  | Also returned for other users' executions                                                                                                     |
| `idempotency_conflict`                                                | 409  | The request key was already used with different SQL or settings                                                                               |
| `not_complete`                                                        | 409  | A full export of an incomplete result                                                                                                         |
| `connection_disabled`, `connection_busy`, `name_conflict`             | 409  | Conflicts with stored state                                                                                                                   |
| `result_expired`, `export_missing`                                    | 410  | The stored data or file is gone                                                                                                               |
| `read_only_policy`                                                    | 422  | Rejected before running because of a read-only policy. `details.execution` is the stored execution, `details.problems` the preflight problems |
| `preflight_rejected`                                                  | 422  | Rejected before running for another reason, for example transaction control or an implicit commit                                             |
| `rate_limited`                                                        | 429  | Too many requests from this user, MCP client or address. Retry after `details.retryAfterSeconds`, also sent as `Retry-After`                  |
| `database_error`                                                      | 502  | The target database failed. `details` carries `category`, `code`, `sqlState`, `detail`, `hint` and `position`                                 |

## Paging

`GET /executions` returns the newest first. For the next page, pass `before=<ID of the last execution on this page>`. Executions submitted in the same millisecond are ordered by ID, so none is skipped. A timestamp is still accepted for `before`.

## Rate limits and headers

- Requests are limited per signed-in user (`RATE_LIMIT_PER_MINUTE`, 600), per user and MCP client (`MCP_RATE_LIMIT_PER_MINUTE`, 300), and per address for rejected tokens (`AUTH_FAILURES_PER_MINUTE`, 60). A limit allows bursts of its own size; 0 turns it off.
- Every response carries a content security policy and other security headers ([security.md](security.md#security-headers)).

## Server-sent events

`GET /api/v1/events` streams status changes of executions, exports and MCP approvals the caller may see.

- Event types:
  - `ready`;
  - `execution` — `{ id, status, transactionOutcome }`;
  - `export` — `{ id, executionId, status }`;
  - `approval` — `{ id, executionId, status }`, when an MCP client requests more rows, a person decides, or approved rows are delivered. Not sent to MCP clients.
- The server sends `retry: 3000` and a keep-alive comment every 15 seconds.
- The stream closes when the access token expires. The client reconnects with a fresh token.
- After a reconnect, the client fetches the executions it follows by ID (`GET /executions/{id}`). Their state is stored on the server, so nothing is lost while the stream was down (AC7).
- Browsers send the bearer token with `fetch()` and a streamed body, because `EventSource` cannot set headers.
