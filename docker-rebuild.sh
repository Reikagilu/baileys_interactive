#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

service="beyound"
if ! docker compose config --services | grep -qx "$service"; then
  # Backward-compatible service name used by installations created before rename.
  service="baileys_interactive"
fi

echo "[deploy] Validating Compose configuration..."
docker compose config --quiet

echo "[deploy] Building $service without removing persistent volumes..."
docker compose build "$service"
docker compose up -d --no-deps "$service"

container_id="$(docker compose ps -q "$service")"
if [[ -z "$container_id" ]]; then
  echo "[deploy] Container was not created." >&2
  exit 1
fi

for _ in $(seq 1 40); do
  health="$(docker inspect "$container_id" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  if [[ "$health" == "healthy" ]]; then
    echo "[deploy] Healthy. Persistent volumes were preserved."
    exit 0
  fi
  if [[ "$health" == "unhealthy" || "$health" == "exited" || "$health" == "dead" ]]; then
    echo "[deploy] Container entered state: $health" >&2
    docker compose logs --tail 80 "$service" >&2
    exit 1
  fi
  sleep 3
done

echo "[deploy] Timed out waiting for health." >&2
docker compose logs --tail 80 "$service" >&2
exit 1
