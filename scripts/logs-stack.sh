#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT_DIR/.runtime"
API_LOG_FILE="$RUNTIME_DIR/api.log"
WORKER_LOG_FILE="$RUNTIME_DIR/worker.log"

MODE="${1:-both}"

case "$MODE" in
  api)
    tail -f "$API_LOG_FILE"
    ;;
  worker)
    tail -f "$WORKER_LOG_FILE"
    ;;
  both)
    tail -f "$API_LOG_FILE" "$WORKER_LOG_FILE"
    ;;
  *)
    echo "usage: $0 [api|worker|both]"
    exit 1
    ;;
esac
