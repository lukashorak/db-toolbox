# Deploying to db-tool.sensay-learning.com

The production setup:

| Part          | Where                                                                           |
| ------------- | ------------------------------------------------------------------------------- |
| Workbench     | `https://db-tool.sensay-learning.com`, a Dockge stack on the Hetzner server     |
| Reverse proxy | nginx on the same server, TLS from Let's Encrypt                                |
| Identity      | Keycloak `https://kc.sensay-learning.com`, realm `db-tool`                      |
| Image         | `registry.sensay-learning.com/db-tool`, built by the **Release image** workflow |
| PostgreSQL    | Self-hosted 18 in Docker on the Hetzner server                                  |
| MySQL         | 8.4, managed by DigitalOcean                                                    |

The files in this folder:

| File                    | What it is                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `keycloak-db-tool.json` | Realm import: the four roles and the two public PKCE clients. No users, no secrets |
| `nginx-db-tool.conf`    | The nginx site                                                                     |
| `env.example`           | The stack's `.env`, filled in except `ENCRYPTION_KEY`                              |
| `compose.override.yaml` | Optional: joins the Docker network of the PostgreSQL container                     |

The general guide is [docs/operations.md](../../docs/operations.md); database accounts are in [docs/database-accounts.md](../../docs/database-accounts.md).

## 1. Keycloak

1. In the admin console, open realm **db-tool** → **Realm settings** → **Action** (top right) → **Partial import**.
2. Choose `keycloak-db-tool.json`, set **If a resource exists** to **Skip**, and import. This adds the realm roles `query:read`, `query:write`, `monitor:read` and `admin`, and the clients `workbench-gui` and `workbench-mcp`. Realm settings are not changed; the access token lifespan should stay at its default of 5 minutes.
3. Check the clients:
   - `workbench-gui`: redirect URI `https://db-tool.sensay-learning.com/auth/callback`, web origin `https://db-tool.sensay-learning.com`;
   - `workbench-mcp`: redirect URIs `http://localhost:8765/callback` and `http://127.0.0.1:8765/callback`.
4. Give people roles: **Users** → user → **Role mapping** → **Assign role** → realm roles:
   - `query:read` to read;
   - `query:write` to write on writable connections;
   - `monitor:read` for Monitoring;
   - `admin` to manage connections, MCP profiles and settings.

Claude Code asks for `offline_access` when Keycloak offers it, so it stays signed in after the browser's SSO session ends. To make Claude Code sign in again with every SSO session, remove `offline_access` from **Clients** → `workbench-mcp` → **Client scopes**.

## 2. Image

1. In GitHub: **Settings** → **Secrets and variables** → **Actions**. Add `REGISTRY_USERNAME` and `REGISTRY_PASSWORD` for `registry.sensay-learning.com`.
2. Release a version from `main`:

   ```bash
   git tag v0.1.0
   ```

   ```bash
   git push origin v0.1.0
   ```

   Or run **Actions** → **Release image** → **Run workflow** with version `0.1.0`. The workflow runs the checks, then pushes `registry.sensay-learning.com/db-tool:0.1.0` and `:latest`.

## 3. DNS and nginx

1. Point `db-tool.sensay-learning.com` (A, and AAAA if the server has IPv6) at the Hetzner server.
2. Get the certificate:

   ```bash
   sudo certbot certonly --nginx -d db-tool.sensay-learning.com
   ```

3. Install the site and reload nginx:

   ```bash
   sudo cp nginx-db-tool.conf /etc/nginx/sites-available/db-tool.sensay-learning.com
   ```

   ```bash
   sudo ln -s /etc/nginx/sites-available/db-tool.sensay-learning.com /etc/nginx/sites-enabled/
   ```

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

The site overwrites `X-Forwarded-For` instead of appending to it, because the workbench limits rejected sign-ins per client address.

## 4. The Dockge stack

1. Let Docker on the server pull from the registry (once, as the user Dockge runs Docker as):

   ```bash
   docker login registry.sensay-learning.com
   ```

2. In Dockge, create a stack `db-tool`:
   - its compose file is [`deploy/compose.yaml`](../compose.yaml);
   - its `.env` is `env.example`, with `ENCRYPTION_KEY` filled in. Generate the key once, and keep a copy in the password manager:

     ```bash
     docker run --rm registry.sensay-learning.com/db-tool:0.1.0 node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
     ```

3. For a PostgreSQL container on the same server, copy `compose.override.yaml` into the stack folder and connect the PostgreSQL container to the `databases` network (instructions in the file).
4. Give the data folders to the image's user (Dockge keeps stacks in `/opt/stacks` by default):

   ```bash
   cd /opt/stacks/db-tool && sudo mkdir -p data exports && sudo chown 1000:1000 data exports && sudo chmod 700 data exports
   ```

5. Start the stack, then check:

   ```bash
   curl -s https://db-tool.sensay-learning.com/readyz
   ```

   ```bash
   curl -s https://db-tool.sensay-learning.com/.well-known/oauth-protected-resource/mcp
   ```

   The second one must name `https://kc.sensay-learning.com/realms/db-tool`.

## 5. Connections

1. Create the database accounts from [docs/database-accounts.md](../../docs/database-accounts.md): read-only, writer and monitoring for each database.
2. In DigitalOcean, add the Hetzner server's public IP to the MySQL cluster's **Trusted sources**. Download its CA certificate.
3. Sign in at `https://db-tool.sensay-learning.com` and add the connections under **Connections**. Run **Test connection** before saving:
   - **PostgreSQL**: the container name as the host (on the `databases` network), port 5432, TLS `disable` on that private network;
   - **MySQL**: the DigitalOcean host name, port `25060`, TLS `verify-full` with the CA certificate as **Custom CA**.

   Mark connections read-only where nobody needs to write; add the monitoring account under **Monitoring account**.

## 6. Claude Code

1. Under **MCP access**, add a profile (for example "Claude Code"):
   - bind it to the OAuth client `workbench-mcp`;
   - choose its connections, and leave it read-only unless Claude Code must write.
2. Where Claude Code runs (a current version):

   ```bash
   claude mcp add --transport http --client-id workbench-mcp --callback-port 8765 db-tool https://db-tool.sensay-learning.com/mcp
   ```

   Then run `/mcp` in Claude Code, choose **db-tool** and sign in.

3. Go through the [manual check](../../docs/identity.md#manual-check-with-the-real-keycloak-and-claude-code), and note the results in the PR or in `docs/implementation-status.md`.

## 7. Backups and upgrades

A nightly backup at 02:15, keeping 14 days (root crontab on the server):

```cron
15 2 * * * cd /opt/stacks/db-tool && docker compose exec -T workbench node packages/api/dist/cli.js backup >> /var/log/db-tool-backup.log 2>&1 && find data/backups -name 'workbench-*.sqlite' -mtime +14 -delete
```

Copy `data/backups/` off the server, for example to a Hetzner Storage Box. `ENCRYPTION_KEY` does not travel with the backups; keep it in the password manager.

To upgrade:

1. Release a new tag.
2. Take a backup.
3. Set `WORKBENCH_IMAGE` in the stack's `.env` to the new version, and redeploy.

Restore and rollback are in [operations.md](../../docs/operations.md#restore).
