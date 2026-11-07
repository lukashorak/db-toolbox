#!/usr/bin/env bash
# Starts disposable containers for integration tests and waits until they are ready.
# Used locally and in CI. Prints the environment variables the tests read.
#
#   scripts/integration/start.sh [keycloak]     (more services are added in later steps)
#   scripts/integration/stop.sh
set -euo pipefail

KEYCLOAK_IMAGE="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.4}"
KEYCLOAK_PORT="${KEYCLOAK_PORT:-18080}"
PREFIX="workbench-it"
services=("$@")
[ ${#services[@]} -eq 0 ] && services=(keycloak)

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
    *)
      echo "unknown service: $service" >&2
      exit 2
      ;;
  esac
done
