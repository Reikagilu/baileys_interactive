# Release Checklist

Checklist minimo para subir versao com seguranca e previsibilidade.

## 1) Preparacao

- [ ] `.env` preenchido com `API_KEY` forte ou `API_KEYS_JSON`
- [ ] Confirmar flags de seguranca outbound (`ALLOW_PRIVATE_NETWORK_*`) conforme ambiente
- [ ] Revisar mudancas de schema/paths persistentes (`WEBHOOK_DB_PATH`, `INTEGRATIONS_DB_PATH`, `AUTH_FOLDER`)

## 2) Qualidade

- [ ] `npm test`
- [ ] `node --check public/app.js`
- [ ] `node --check public/instance.js`
- [ ] Smoke manual UI (`/`, `/instance.html?instance=...`)

## 3) Runtime

- [ ] Build de producao (`npm run build`)
- [ ] Start API + worker (`./scripts/start-stack.sh` ou equivalente)
- [ ] Healthcheck `/health` e `/ready`
- [ ] Verificar logs (`./scripts/logs-stack.sh both`)

## 4) Pos-deploy

- [ ] Confirmar resposta padrao com `requestId` nas rotas criticas
- [ ] Validar bloqueio SSRF com URL privada em endpoint de webhook/integracao
- [ ] Validar envio normal para URL publica
- [ ] Registrar riscos remanescentes e plano de mitigacao
