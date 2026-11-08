# Operations: deployment, backups and upgrades

Database Workbench runs as one container. The same Node process serves:

- the GUI;
- the API at `/api/v1`;
- MCP at `/mcp`, with its discovery document at `/.well-known/oauth-protected-resource/mcp`.

State lives in two folders:

| Folder     | Holds                                                                                                       | Back up                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `/data`    | `workbench.sqlite`: connections with sealed credentials, saved queries, executions, captured results, audit | Yes, with the CLI (below); never by copying the open file                 |
| `/exports` | CSV and JSON export files                                                                                   | Optional: exports can be generated again while their results are retained |

`ENCRYPTION_KEY` seals the stored database passwords. It lives in the stack's `.env`, never in `/data`. Keep a copy somewhere else, such as a password manager. A backup cannot be used without the key, and the key must not travel with the backup.

## What still depends on your environment

For the production deployment (Hetzner, nginx, `registry.sensay-learning.com`, Keycloak realm `db-tool`), the concrete files and steps are in [deploy/sensay-learning/README.md](../deploy/sensay-learning/README.md).

Some parts wait for details of the target host (see the [implementation plan](implementation-plan.md#inputs-needed-from-the-owner)):

- the reverse proxy in use, which decides the concrete proxy configuration below;
- the external URLs of the workbench and Keycloak;
- the Dockge host, and where backups are copied to.

Everything else in this guide is independent of them.

## Build the image

From a checkout, on the Docker host or in CI:

```bash
docker build -t database-workbench:0.1.0 .
```

Behind a TLS-inspecting proxy, give the build that proxy's CA certificate. It is used only while dependencies are installed:

```bash
docker build --secret id=extra_ca,src=proxy-ca.pem -t database-workbench:0.1.0 .
```

The image:

- is based on `node:24.22.2-bookworm-slim`;
- runs as `node` (uid 1000);
- keeps application files owned by root and read-only;
- writes only to `/data`, `/exports` and `/tmp`;
- has a health check on `/healthz`.

## Keycloak

Generate the realm import (roles and the two public PKCE clients; no users, no secrets) with the image itself:

```bash
docker run --rm database-workbench:0.1.0 node packages/api/dist/cli.js realm --public-url https://db.example.com > workbench-realm.json
```

Import it in the Keycloak admin console (**Create realm → Resource file**), then assign the roles `query:read`, `query:write`, `monitor:read` and `admin` to users. Details are in [identity.md](identity.md).

## Install with Dockge

1. Create a stack, for example `database-workbench`. Use [`deploy/compose.yaml`](../deploy/compose.yaml) as its compose file.
2. Fill in its `.env` from [`deploy/.env.example`](../deploy/.env.example):
   - `PUBLIC_URL`: the HTTPS origin users reach, with no path;
   - `KEYCLOAK_ISSUER`: the realm's issuer URL;
   - `ENCRYPTION_KEY`: 32 random bytes in base64, generated once;
   - `WORKBENCH_IMAGE`: the image tag.
3. In the stack folder, give the data folders to the image's user:

   ```bash
   mkdir -p data exports && sudo chown 1000:1000 data exports && chmod 700 data exports
   ```

   Without this, the container stops at once and says which folder is not writable.

4. Start the stack. The first start creates the database and applies migrations.
5. Check the health endpoints:
   - `/healthz` answers while the process runs;
   - `/readyz` also checks the database and the export folder.

The compose file:

- publishes port 3000 on `127.0.0.1` only, for a reverse proxy on the same host (`WORKBENCH_BIND` and `WORKBENCH_PORT` change it);
- sets a read-only root file system, drops all capabilities, and sets `no-new-privileges`;
- caps the log files at 5 × 10 MB.

## Reverse proxy

Whatever proxy you use, it must:

- serve the workbench at the root of its own origin. `PUBLIC_URL` has no path, and OAuth callbacks (`/auth/callback`), MCP (`/mcp`) and discovery (`/.well-known/…`) are absolute paths;
- terminate HTTPS and forward `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`. Set `TRUST_PROXY=true`, which the template does;
- not buffer streamed responses:
  - `/api/v1/events` (server-sent events, a keep-alive comment every 15 seconds);
  - `/mcp` (Streamable HTTP);
- allow long reads: an event stream stays open until the access token expires, so set the read timeout to at least 10 minutes;
- accept request bodies of at least 2 MiB, for long SQL scripts;
- pass `Authorization` to the app, and `WWW-Authenticate` back to the client, unchanged. MCP clients find Keycloak from the 401 challenge;
- keep the app's security headers, including its `Content-Security-Policy` ([security.md](security.md#security-headers));
- forward the client address (`X-Forwarded-For`), because rejected tokens are rate-limited per address.

Two examples, to adapt once the proxy is known.

Caddy:

```caddyfile
db.example.com {
	reverse_proxy 127.0.0.1:3000 {
		flush_interval -1
	}
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    server_name db.example.com;
    client_max_body_size 4m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 15m;
    }
}
```

After the proxy is in place, check that:

- `https://db.example.com/.well-known/oauth-protected-resource/mcp` names the Keycloak realm;
- `claude mcp add --transport http …` from the GUI's **MCP access** screen reaches the sign-in page.

## Stopping and restarting

On `SIGTERM` (`docker compose stop`, or Dockge's Stop), the server shuts down in this order:

1. It stops starting new work. Executions submitted from now on stay queued.
2. Running executions get `SHUTDOWN_GRACE_MS` (20 seconds by default) to finish. The API still answers status requests during that time.
3. What is still running is cancelled in the database and recorded as `interrupted`, with the note "The server shut down while this was running." It is never run again. Transaction outcomes follow the usual rules: for example, a single-transaction run is rolled back.
4. Event streams end, the HTTP server closes, pools close, and the process exits with code 0.

The compose file allows 30 seconds before Docker kills the container. Keep `stop_grace_period` longer than `SHUTDOWN_GRACE_MS`.

After a crash or a kill, the next start marks unfinished executions as `interrupted` with honest outcomes. Executions that were still queued start then, after they are authorized again.

## Backups

Back up with the CLI. It uses SQLite's online backup API, so the copy is consistent while the server runs:

```bash
docker compose exec -T workbench node packages/api/dist/cli.js backup
```

This writes `data/backups/workbench-<UTC time>.sqlite` with mode 600, after an integrity check. Pass a path inside `/data` to choose the name.

Copy backups off the host with your usual tooling, for example a nightly cron job on the host that runs the command above, then copies and prunes `data/backups/`:

```bash
find data/backups -name 'workbench-*.sqlite' -mtime +14 -delete
```

Check a backup at any time, including against the current key:

```bash
docker compose exec -T workbench node packages/api/dist/cli.js verify /data/backups/<file>
```

`verify` reports:

- the integrity check;
- the schema version against this release;
- whether `ENCRYPTION_KEY` opens the credentials in the file.

It exits non-zero when the backup cannot be restored.

## Restore

```bash
docker compose stop workbench
docker compose run --rm -T --no-deps workbench node packages/api/dist/cli.js restore /data/backups/<file>
docker compose start workbench
```

`restore`:

- refuses while a server uses the database. It sees the server's heartbeat, which a clean stop removes; after a crash, wait 45 seconds;
- refuses a backup that fails `verify`: a damaged file, a schema newer than this release, or a key that does not open its credentials;
- keeps the replaced database as `workbench.sqlite.before-restore-<time>`;
- applies the migrations an older backup needs.

Export files are not part of the database backup. If an export file is missing after a restore, its download reports `export_missing`. Generate it again while the result is retained.

## Upgrades

1. Back up (above), and keep the previous image tag.
2. Build or pull the new image. Set `WORKBENCH_IMAGE` in `.env`.
3. Run `docker compose up -d`. On start, pending migrations are applied in order, each in its own transaction. `docker compose exec -T workbench node packages/api/dist/cli.js migrate` prints the schema version.
4. Check `/readyz` and the logs.

To roll back:

1. Stop the stack.
2. Restore the backup taken in step 1 with the **previous** image, through `docker compose run` with that tag.
3. Start the previous image.

A release refuses to restore or open a database whose schema is newer than its own.

Rotating `ENCRYPTION_KEY` is not supported in v1. Changing it makes stored credentials unreadable, and the server refuses to start with `encryption_key_mismatch`.

## Logs

The server writes JSON lines to standard output:

- the access token, `Authorization` headers, passwords, SQL text and parameters, result rows and connection secrets are redacted before they are written;
- SQL and its outcomes are kept in the application database (executions and the audit trail), not in the logs;
- when a call to a target database fails with `database_error`, the database's own error message is logged. It can name tables or columns.

`npm run test:deploy` checks this against a running container.

## Verifying a deployment

`npm run test:deploy` starts the image with `deploy/compose.yaml` and checks:

- the non-root user, the read-only root and the dropped capabilities;
- migrations on the first start;
- an online backup, and a restore refused while the server runs;
- a backup refused under a different key;
- a graceful stop with exit code 0;
- a restore with the CLI, after which a change made after the backup is gone and the stored credentials still connect;
- logs without the encryption key, the database and user passwords, or the access token.

It needs:

- an image (`DEPLOY_TEST_IMAGE`);
- the Keycloak and PostgreSQL test containers (`scripts/integration/start.sh keycloak postgres`).

The test joins the host network, and it runs with `NODE_ENV=test` because the Keycloak test container has no TLS. CI runs it on every push.
