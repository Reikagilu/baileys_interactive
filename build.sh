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

# Todos os routes agora têm implementação real em src/routes/ — nenhum precisa ser restaurado do backup.
# O tsc compila tudo corretamente.

# Services: todos agora têm implementação real em src/ — nenhum precisa ser restaurado do backup.
# audit-log, webhooks, instance-config, idempotency, webhook-delivery-worker estão em src/.

# Utils, workers, docs e types reais (preservar do backup).
# Os seguintes arquivos têm implementação real em src/ e NÃO devem ser restaurados do backup:
#   helpers.js, api-response.js, media-signature.js, url-security.js
# Os demais utils do backup são restaurados para preservar implementações que não estão em src/.
for dir in utils workers docs types; do
  if [ -d "$BACKUP_DIR/${dir}" ]; then
    mkdir -p "$SCRIPT_DIR/dist/${dir}"
    if [ "$dir" = "utils" ]; then
      for file in "$BACKUP_DIR/${dir}/"*.js; do
        [ -e "$file" ] || continue
        base="$(basename "$file")"
        # Não restaurar arquivos que agora têm implementação real em src/
        if [ "$base" = "helpers.js" ] || [ "$base" = "api-response.js" ] || \
           [ "$base" = "media-signature.js" ] || [ "$base" = "url-security.js" ]; then
          continue
        fi
        cp "$file" "$SCRIPT_DIR/dist/${dir}/$base"
      done
    else
      cp "$BACKUP_DIR/${dir}/"*.js "$SCRIPT_DIR/dist/${dir}/" 2>/dev/null || true
    fi
    cp "$BACKUP_DIR/${dir}/"*.d.ts "$SCRIPT_DIR/dist/${dir}/" 2>/dev/null || true
    cp "$BACKUP_DIR/${dir}/"*.js.map "$SCRIPT_DIR/dist/${dir}/" 2>/dev/null || true
  fi
done

# middleware: api-auth e request-context vêm do tsc (implementação real em src/)
# Nenhum middleware precisa ser restaurado do backup.


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
