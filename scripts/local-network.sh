#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif [[ -x .tools/docker-compose ]]; then
  compose=(./.tools/docker-compose)
else
  printf '%s\n' 'Docker Compose is required; see docs/local-setup.md.' >&2
  exit 1
fi
case "${1:-status}" in
  up) "${compose[@]}" -f compose.yaml up -d --wait ;;
  status) "${compose[@]}" -f compose.yaml ps ;;
  stop) "${compose[@]}" -f compose.yaml stop ;;
  *) printf '%s\n' 'Usage: scripts/local-network.sh {up|status|stop}' >&2; exit 2 ;;
esac
