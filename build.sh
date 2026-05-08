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

# Utils, middleware, workers, docs e types reais
for dir in utils middleware workers docs types; do
  if [ -d "$BACKUP_DIR/${dir}" ]; then
    mkdir -p "$SCRIPT_DIR/dist/${dir}"
    cp "$BACKUP_DIR/${dir}/"*.js "$SCRIPT_DIR/dist/${dir}/" 2>/dev/null || true
    cp "$BACKUP_DIR/${dir}/"*.d.ts "$SCRIPT_DIR/dist/${dir}/" 2>/dev/null || true
    cp "$BACKUP_DIR/${dir}/"*.js.map "$SCRIPT_DIR/dist/${dir}/" 2>/dev/null || true
  fi
done

echo "[build] Verificando tamanhos críticos..."
echo "  routes/instances.js: $(wc -c < dist/routes/instances.js) bytes"
echo "  services/webhooks.js: $(wc -c < dist/services/webhooks.js) bytes"
echo "  services/chatwoot-bridge.js: $(wc -c < dist/services/chatwoot-bridge.js) bytes"
echo "  services/whatsapp.js: $(wc -c < dist/services/whatsapp.js) bytes"

echo "[build] Concluído."
