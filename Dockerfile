# syntax=docker/dockerfile:1
# Database Workbench: one Node process serving the GUI, the API (/api/v1) and MCP (/mcp).
ARG NODE_IMAGE=node:24.22.2-bookworm-slim

# ---------------------------------------------------------------- build: compile and bundle
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
# Behind a TLS-inspecting proxy, pass its CA: docker build --secret id=extra_ca,src=proxy-ca.pem .
RUN --mount=type=secret,id=extra_ca,required=false \
  if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
  && npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm run build

# ---------------------------------------------------------------- runtime dependencies only
# The web app is bundled at build time, so its packages are not needed at run time.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/mcp/package.json packages/mcp/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN --mount=type=secret,id=extra_ca,required=false \
  if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi \
  && npm ci --omit=dev --workspace=@workbench/api --workspace=@workbench/mcp --workspace=@workbench/core \
  && npm cache clean --force \
  # Only the MySQL grammar of node-sql-parser is loaded (packages/core/src/sql/analyze-mysql.ts).
  && rm -rf node_modules/node-sql-parser/umd \
  && find node_modules/node-sql-parser/build -type f ! -name 'mysql.js' ! -name 'mysql.d.ts' -delete \
  && find node_modules -name '*.map' -type f -delete

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.0.0
LABEL org.opencontainers.image.title="Database Workbench" \
  org.opencontainers.image.description="Self-hosted database workbench for MySQL and PostgreSQL with MCP access" \
  org.opencontainers.image.version="${VERSION}"
ENV WORKBENCH_VERSION=${VERSION} \
  NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=3000 \
  DATA_DIR=/data \
  EXPORT_DIR=/exports
WORKDIR /app
COPY --from=deps /app/package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/mcp/package.json packages/mcp/
COPY --from=build /app/packages/mcp/dist packages/mcp/dist
COPY --from=build /app/packages/api/package.json packages/api/
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/web/dist packages/web/dist
# Application files belong to root and are read-only for the service user; only the volumes are writable.
RUN mkdir -p /data /exports && chown node:node /data /exports && chmod 700 /data /exports
USER node
EXPOSE 3000
VOLUME ["/data", "/exports"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# The server lets running executions finish for SHUTDOWN_GRACE_MS (20 s) after SIGTERM; give the
# container more than that before it is killed (compose: stop_grace_period).
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/api/dist/main.js"]
