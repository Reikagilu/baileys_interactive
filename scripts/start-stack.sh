#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
API_PID_FILE="$RUNTIME_DIR/api.pid"
WORKER_PID_FILE="$RUNTIME_DIR/worker.pid"
API_LOG_FILE="$RUNTIME_DIR/api.log"
WORKER_LOG_FILE="$RUNTIME_DIR/worker.log"

NO_BUILD=0
if [[ "${1:-}" == "--no-build" ]]; then
  NO_BUILD=1
fi

mkdir -p "$RUNTIME_DIR"

"$ROOT_DIR/scripts/stop-stack.sh" >/dev/null 2>&1 || true

if [[ $NO_BUILD -eq 0 ]]; then
  echo "[stack] building project..."
  (cd "$ROOT_DIR" && npm run build)
fi

echo "[stack] starting API..."
(cd "$ROOT_DIR" && nohup node dist/index.js >"$API_LOG_FILE" 2>&1 </dev/null & echo $! >"$API_PID_FILE")

echo "[stack] starting webhook worker..."
(cd "$ROOT_DIR" && nohup node dist/workers/webhook-delivery-worker.js >"$WORKER_LOG_FILE" 2>&1 </dev/null & echo $! >"$WORKER_PID_FILE")

echo "[stack] waiting for healthcheck..."
for _ in {1..20}; do
  if curl -fsS "http://127.0.0.1:8787/health" >/dev/null 2>&1; then
    echo "[stack] up"
    echo "- API PID: $(cat "$API_PID_FILE")"
    echo "- Worker PID: $(cat "$WORKER_PID_FILE")"
    echo "- Logs: $API_LOG_FILE | $WORKER_LOG_FILE"
    exit 0
  fi
  sleep 1
done

echo "[stack] failed to pass healthcheck"
echo "[stack] tail api log:"
tail -n 40 "$API_LOG_FILE" || true
"$ROOT_DIR/scripts/stop-stack.sh" >/dev/null 2>&1 || true
exit 1
