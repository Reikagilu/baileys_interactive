#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
API_PID_FILE="$RUNTIME_DIR/api.pid"
WORKER_PID_FILE="$RUNTIME_DIR/worker.pid"

stop_pid_file() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return
  fi

  local pid
  pid="$(cat "$pid_file" || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.5
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi

  rm -f "$pid_file"
}

stop_pid_file "$API_PID_FILE"
stop_pid_file "$WORKER_PID_FILE"

pkill -f "^node dist/index.js$" 2>/dev/null || true
pkill -f "^node dist/workers/webhook-delivery-worker.js$" 2>/dev/null || true

echo "[stack] stopped"
