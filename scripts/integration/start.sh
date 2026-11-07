#!/usr/bin/env bash
# Starts disposable containers for integration tests and waits until they are ready.
# Used locally and in CI. Prints the environment variables the tests read.
#
#   scripts/integration/start.sh [keycloak] [postgres] [mysql]   (default: all)
#   scripts/integration/stop.sh
#
# Database servers use TLS with a throwaway CA (scripts/integration/certs.sh) and fixed throwaway
# passwords; the containers listen on 127.0.0.1 only.
set -euo pipefail

KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.4}"
KEYCLOAK_PORT="${KEYCLOAK_PORT:-18080}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16}"
POSTGRES_PORT="${POSTGRES_PORT:-15432}"
MYSQL_IMAGE="${MYSQL_IMAGE:-mysql:8.4}"
MYSQL_PORT="${MYSQL_PORT:-13306}"
PASSWORD="workbench-it"
PREFIX="workbench-it"
CERTS="$(pwd)/.integration/certs"
services=("$@")
[ ${#services[@]} -eq 0 ] && services=(keycloak postgres mysql)

needs_certs() { [[ " ${services[*]} " == *" postgres "* || " ${services[*]} " == *" mysql "* ]]; }
if needs_certs; then "$(dirname "$0")/certs.sh" "$CERTS"; fi

wait_exec() {
  local name="$1"; shift
  for _ in $(seq 90); do
    if docker exec "$PREFIX-$name" "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  echo "$name did not become ready; last log lines:" >&2
  docker logs --tail 50 "$PREFIX-$name" >&2 || true
  return 1
}

wait_for() {
  local name="$1" url="$2" tries="${3:-90}"
  for _ in $(seq "$tries"); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    sleep 2
  done
  echo "$name did not become ready; last log lines:" >&2
  docker logs --tail 50 "$PREFIX-$name" >&2 || true
  return 1
}

for service in "${services[@]}"; do
  case "$service" in
    keycloak)
      docker rm -f "$PREFIX-keycloak" >/dev/null 2>&1 || true
      # Throwaway admin credentials for a container that only lives for the test run.
      docker run -d --name "$PREFIX-keycloak" -p "127.0.0.1:${KEYCLOAK_PORT}:8080" \
        -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
        -e KC_HEALTH_ENABLED=true "$KEYCLOAK_IMAGE" start-dev >/dev/null
      wait_for keycloak "http://127.0.0.1:${KEYCLOAK_PORT}/realms/master/.well-known/openid-configuration"
      echo "KEYCLOAK_TEST_URL=http://127.0.0.1:${KEYCLOAK_PORT}"
      ;;
    postgres)
      docker rm -f "$PREFIX-postgres" >/dev/null 2>&1 || true
      docker run -d --name "$PREFIX-postgres" -p "127.0.0.1:${POSTGRES_PORT}:5432" \
        -e POSTGRES_PASSWORD="$PASSWORD" -v "$CERTS:/certs:ro" --entrypoint bash "$POSTGRES_IMAGE" -c '
          install -o postgres -g postgres -m 600 /certs/server.key /var/lib/postgresql/server.key
          install -o postgres -g postgres -m 644 /certs/server.crt /var/lib/postgresql/server.crt
          exec docker-entrypoint.sh postgres -c ssl=on \
            -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key' >/dev/null
      wait_exec postgres pg_isready -h 127.0.0.1 -U postgres
      echo "POSTGRES_TEST_URL=postgres://postgres:${PASSWORD}@localhost:${POSTGRES_PORT}/postgres"
      echo "INTEGRATION_CERTS=${CERTS}"
      ;;
    mysql)
      docker rm -f "$PREFIX-mysql" >/dev/null 2>&1 || true
      docker run -d --name "$PREFIX-mysql" -p "127.0.0.1:${MYSQL_PORT}:3306" \
        -e MYSQL_ROOT_PASSWORD="$PASSWORD" -v "$CERTS:/certs:ro" "$MYSQL_IMAGE" \
        --ssl-ca=/certs/ca.crt --ssl-cert=/certs/server.crt --ssl-key=/certs/server.key >/dev/null
      wait_exec mysql mysqladmin ping -h 127.0.0.1 -uroot "-p$PASSWORD" --silent
      echo "MYSQL_TEST_URL=mysql://root:${PASSWORD}@localhost:${MYSQL_PORT}/mysql"
      echo "INTEGRATION_CERTS=${CERTS}"
      ;;
    *)
      echo "unknown service: $service" >&2
      exit 2
      ;;
  esac
done
