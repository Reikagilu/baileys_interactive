# Beyound

API em TypeScript para multiplas instancias WhatsApp com InfiniteAPI (fork Baileys), com:

- conexao por QR e pairing code
- envio de mensagens (canonicas e helpers)
- webhooks com fila, retry e DLQ
- integracoes por instancia (Chatwoot/n8n)
- painel web operacional

## Documentacao da API

- Swagger UI: `GET /docs`
- OpenAPI JSON: `GET /openapi.json`

Observacao: a documentacao detalhada de rotas fica no Swagger. Este README foca operacao e configuracao.

## Requisitos

- Node.js >= 20
- npm

## Setup rapido

```bash
npm install
cp .env.example .env
npm run dev
```

Com a API rodando:

- painel web: `http://localhost:8787`
- health: `http://localhost:8787/health`
- docs: `http://localhost:8787/docs`

## Execucao

Desenvolvimento:

```bash
npm run dev
```

Build + start:

```bash
npm run build
npm start
```

API + worker de webhook (mesmo processo):

```bash
npm run start:stack
```

Worker dedicado de webhook:

```bash
npm run worker:webhooks
```

Scripts utilitarios (PID/logs em `.runtime/`):

```bash
./scripts/start-stack.sh
./scripts/logs-stack.sh both
./scripts/stop-stack.sh
```

## Autenticacao e autorizacao

- Rotas `/v1/*` usam `x-api-key` quando `API_KEY` estiver definido.
- Rotas publicas sem key: `/`, `/health`, `/ready`, `/metrics`, `/docs`, `/openapi.json`, `/v1/media/*` (assinada).
- Escopos suportados:
  - `instances:*`
  - `messages:send`
  - `webhooks:*`
  - `chats:*`
  - `ops:read`
  - `integrations:*`

Use `API_KEYS_JSON` para chaves com escopos distintos. `API_KEY` legada equivale a escopo total.

## Principais variaveis de ambiente

| Variavel | Descricao | Padrao |
|---|---|---|
| `PORT` | Porta da API | `8787` |
| `API_KEY` | Chave unica para `x-api-key` (modo simples) | - |
| `API_KEYS_JSON` | Lista de chaves por escopo | - |
| `AUTH_FOLDER` | Sessoes por instancia | `auth` |
| `REQUEST_LOGS_ENABLED` | Log estruturado por request com `requestId` | `true` |
| `MEDIA_SIGNED_URL_SECRET` | Segredo HMAC das URLs `/v1/media/*` | `API_KEY` |
| `MEDIA_SIGNED_URL_TTL_SECONDS` | TTL da URL assinada de midia | `3600` |
| `CHAT_MEDIA_RETENTION_MS` | Retencao de midia em disco | `7776000000` (90 dias) |
| `INTEGRATIONS_DB_PATH` | SQLite de integracoes | `data/integrations.sqlite` |
| `INTEGRATIONS_REQUEST_TIMEOUT_MS` | Timeout em testes de integracao | `8000` |
| `WEBHOOK_DB_PATH` | SQLite de webhooks/deliveries | `data/webhooks.sqlite` |
| `WEBHOOK_EMBEDDED_WORKER_ENABLED` | Worker embutido no processo da API | `true` |
| `WEBHOOK_MAX_ATTEMPTS` | Tentativas maximas por entrega | `5` |
| `WEBHOOK_REQUEST_TIMEOUT_MS` | Timeout da chamada do webhook | `8000` |
| `WEBHOOK_INCLUDE_INCOMING_MEDIA_BASE64` | Inclui base64 no inbound (nao video) | `false` |
| `WEBHOOK_INCLUDE_INCOMING_VIDEO_BASE64` | Inclui base64 de video no inbound | `false` |
| `ALLOW_PRIVATE_NETWORK_WEBHOOKS` | Libera destinos privados para webhooks | `false` |
| `ALLOW_PRIVATE_NETWORK_INTEGRATIONS` | Libera destinos privados para integracoes | `false` |

Consulte `.env.example` para a lista completa.

## Comportamentos importantes

### Reconnect no startup (estilo unless-stopped)

Ao subir a API, instancias com sessao salva tentam reconectar automaticamente, exceto quando foram explicitamente paradas pelo usuario.

### Midia por URL assinada

- payload de mensagem retorna `media.url` assinada (`/v1/media/...?...`).
- URL expira por TTL, mas o arquivo segue disponivel dentro da retencao.
- retencao padrao de midia: 90 dias.

### Typing antes de enviar

Rotas de envio aceitam:

- `typingMs` (300-10000) para delay manual
- `typingMode: "auto"` para calculo automatico

Fluxo: `composing` -> espera -> `sendMessage` -> `paused`.

### Idempotencia

Em mensagens canonicas, use `idempotency-key` (ou `x-idempotency-key`) para deduplicar retries.

### Webhooks

- entregas persistidas em SQLite
- retries com backoff
- DLQ para falhas definitivas
- assinatura HMAC opcional via segredo
- payload `MESSAGES_UPSERT` padronizado com `message_type`, `sender`, `media` e `reaction_target` (quando aplicavel)

## Observabilidade

- `GET /metrics` em formato Prometheus
- `x-request-id` em todas as respostas
- logs estruturados quando `REQUEST_LOGS_ENABLED=true`
- auditoria em `AUDIT_LOG_PATH` e endpoint de ops no Swagger

## Politica de seguranca outbound (SSRF)

Por padrao, URLs privadas/internas sao bloqueadas para webhooks e integracoes.

- bloqueia: localhost, RFC1918, hostnames internos
- liberar apenas em ambiente controlado com:
  - `ALLOW_PRIVATE_NETWORK_WEBHOOKS=true`
  - `ALLOW_PRIVATE_NETWORK_INTEGRATIONS=true`

## Testes

```bash
npm test
```

## Licenca

MIT
