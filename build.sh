#!/bin/bash
# Script de build para o projeto baileys_interactive (Beyound)
# Compila apenas os arquivos modificados localmente e restaura, a partir do
# dist/ atual, os módulos reais que o tsc insiste em sobrescrever via imports transitivos.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d dist ]; then
  echo "[build] dist/ não encontrado. O build incremental precisa de um dist base válido." >&2
  exit 1
fi

if [ -d dist/dist ]; then
  echo "[build] Limpando artefatos aninhados em dist/dist..."
  rm -rf dist/dist
fi

BACKUP_DIR="$(mktemp -d)"
trap 'rm -rf "$BACKUP_DIR"' EXIT

echo "[build] Fazendo backup do dist base..."
cp -a dist/. "$BACKUP_DIR/"

echo "[build] Compilando arquivos TypeScript modificados..."
npx --yes -p typescript -p @types/node -p @types/express -p @types/qrcode tsc -p tsconfig.build.json

echo "[build] Restaurando módulos reais preservados do dist base..."

# Routes reais (exceto integrations.js que é nosso)
for f in chats instances messages ops webhooks; do
  if [ -f "$BACKUP_DIR/routes/${f}.js" ]; then
    cp "$BACKUP_DIR/routes/${f}.js" "$SCRIPT_DIR/dist/routes/${f}.js"
  fi
done

# Services reais (os que não modificamos)
for f in audit-log webhooks instance-config idempotency; do
  if [ -f "$BACKUP_DIR/services/${f}.js" ]; then
    cp "$BACKUP_DIR/services/${f}.js" "$SCRIPT_DIR/dist/services/${f}.js"
  fi
done

# Utils, workers, docs e types reais (preservar do backup)
for dir in utils workers docs types; do
  if [ -d "$BACKUP_DIR/${dir}" ]; then
    mkdir -p "$SCRIPT_DIR/dist/${dir}"
    cp "$BACKUP_DIR/${dir}/"*.js "$SCRIPT_DIR/dist/${dir}/" 2>/dev/null || true
    cp "$BACKUP_DIR/${dir}/"*.d.ts "$SCRIPT_DIR/dist/${dir}/" 2>/dev/null || true
    cp "$BACKUP_DIR/${dir}/"*.js.map "$SCRIPT_DIR/dist/${dir}/" 2>/dev/null || true
  fi
done

# middleware: preservar request-context do backup; api-auth vem do tsc (implementação real em src/)
if [ -d "$BACKUP_DIR/middleware" ]; then
  mkdir -p "$SCRIPT_DIR/dist/middleware"
  if [ -f "$BACKUP_DIR/middleware/request-context.js" ]; then
    cp "$BACKUP_DIR/middleware/request-context.js" "$SCRIPT_DIR/dist/middleware/request-context.js"
  fi
fi

# Patch: substituir Atomics.wait (bloqueia main thread) por busy-wait simples em webhooks.js
if [ -f "$SCRIPT_DIR/dist/services/webhooks.js" ]; then
  sed -i 's/const shared = new SharedArrayBuffer(4);.*//; s/const view = new Int32Array(shared);.*//; s/Atomics\.wait(view, 0, 0, ms);/const end = Date.now() + ms; while (Date.now() < end) {}/' \
    "$SCRIPT_DIR/dist/services/webhooks.js" 2>/dev/null || true
fi

echo "[build] Verificando tamanhos críticos (stub < 500 bytes = FALHA)..."
check_size() {
  local file="$1"
  local min_bytes="${2:-500}"
  local size
  size=$(wc -c < "$SCRIPT_DIR/dist/${file}" 2>/dev/null || echo 0)
  if [ "$size" -lt "$min_bytes" ]; then
    echo "[build] ERRO: dist/${file} tem apenas ${size} bytes — provável stub! Build abortado." >&2
    exit 1
  fi
  echo "  dist/${file}: ${size} bytes OK"
}

check_size "routes/instances.js" 5000
check_size "routes/messages.js" 3000
check_size "routes/webhooks.js" 2000
check_size "services/webhooks.js" 5000
check_size "services/chatwoot-bridge.js" 50000
check_size "services/whatsapp.js" 50000
check_size "utils/api-response.js" 300
check_size "utils/helpers.js" 300
check_size "utils/media-signature.js" 300
check_size "utils/url-security.js" 500
check_size "middleware/request-context.js" 500

echo "[build] Concluído."
