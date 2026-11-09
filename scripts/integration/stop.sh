#!/usr/bin/env bash
# Removes the containers started by start.sh.
set -euo pipefail
docker ps -aq --filter name=workbench-it- | xargs -r docker rm -f >/dev/null
