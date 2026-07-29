# API guide

The canonical API contract is [`GET /openapi.json`](../README.md#api-documentation). Swagger UI is served at `GET /docs`. Both are protected by `X-API-Key` by default.

## Conventions

### Base URL

```text
http://localhost:8787
```

Use HTTPS through a reverse proxy for Internet-facing deployments.

### Authentication

```http
X-API-Key: [REDACTED]
```

The API supports a single administrator key through `API_KEY` or scoped keys through `API_KEYS_JSON`.

### Response envelope

Success responses include `ok: true` and a correlation ID:

```json
{
  "ok": true,
  "requestId": "8d68a2a0-8b93-4c42-9ebd-6a0f6e17f241"
}
```

Errors use a stable machine-readable `error` value:

```json
{
  "ok": false,
  "error": "instance_not_connected",
  "message": "Instance must be connected.",
  "requestId": "8d68a2a0-8b93-4c42-9ebd-6a0f6e17f241"
}
```

### Rate limiting

Protected API routes and Chatwoot callbacks have independent configurable rate limits. A rejected request returns HTTP `429` and a `Retry-After` header.

### Idempotency and delivery

Message endpoints accept `Idempotency-Key` (or `X-Idempotency-Key`). Reusing the same key and request scope returns the stored result instead of sending twice.

By default, basic message sends wait briefly for a WhatsApp delivery acknowledgement. Use `requireDelivery=false` only when enqueue/send acknowledgement is sufficient. Delivery states are `pending`, `server_ack`, `delivered`, `read`, `played` and `failed`.

## Common workflows

### Create and inspect an instance

```bash
curl -sS -X POST "$BEYOUND_URL/v1/instances" \
  -H "X-API-Key: [REDACTED]" \
  -H 'Content-Type: application/json' \
  -d '{"instance":"main"}'

curl -sS "$BEYOUND_URL/v1/instances/main" \
  -H "X-API-Key: [REDACTED]"
```

### Pair using a phone code

```bash
curl -sS -X POST "$BEYOUND_URL/v1/instances/main/pairing-code" \
  -H "X-API-Key: [REDACTED]" \
  -H 'Content-Type: application/json' \
  -d '{"phoneNumber":"5511999999999"}'
```

### Send text safely

```bash
curl -sS -X POST "$BEYOUND_URL/v1/messages/text" \
  -H "X-API-Key: [REDACTED]" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-123-confirmation-v1' \
  -d '{
    "instance":"main",
    "to":"5511999999999",
    "text":"Your order is ready.",
    "requireDelivery":true,
    "deliveryTimeoutMs":15000
  }'
```

### Send media

The backend downloads the URL with SSRF protection and size limits before sending it to WhatsApp.

```bash
curl -sS -X POST "$BEYOND_URL/v1/messages/media" \
  -H "X-API-Key: [REDACTED]" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: invoice-123-v1' \
  -d '{
    "instance":"main",
    "to":"5511999999999",
    "mediaType":"document",
    "mediaUrl":"https://example.org/invoice.pdf",
    "fileName":"invoice.pdf",
    "caption":"Invoice 123"
  }'
```

### Register a durable webhook

```bash
curl -sS -X POST "$BEYOUND_URL/v1/webhooks" \
  -H "X-API-Key: [REDACTED]" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"events",
    "url":"https://receiver.example.org/beyound",
    "events":["messages.upsert","connection.update"],
    "instance":"main",
    "secret":"generate-a-dedicated-secret"
  }'
```

Webhook delivery is persisted in SQLite and retried. Use `/v1/webhooks/deliveries` and `/v1/webhooks/dlq` for operations. Webhook secrets are write-only and should be different from the API key.

### Configure Chatwoot

```bash
curl -sS -X PATCH "$BEYOUND_URL/v1/integrations/main/chatwoot" \
  -H "X-API-Key: [REDACTED]" \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled":true,
    "baseUrl":"https://chatwoot.example.org",
    "accountId":"1",
    "inboxId":"2",
    "apiAccessToken":"replace-me"
  }'
```

Store `CHATWOOT_WEBHOOK_SECRET` in `.env` before exposing the callback. Integration read endpoints redact stored tokens.

## Endpoint groups

The full request and response schemas are in OpenAPI. This summary is intended for navigation.

| Group | Main routes |
|---|---|
| System | `/health`, `/ready`, `/metrics`, `/docs`, `/openapi.json` |
| Instances | `/v1/instances`, pairing, restart, disconnect, logout, session repair |
| Settings | `/v1/instances/{name}/settings/*`, event configuration |
| Chats | Chat listing, message history, read/archive/pin/mute actions |
| Messages | Text, media, contact, location, reaction, poll, list, buttons, carousel |
| Webhooks | Registration, delivery history, retry and dead-letter queue |
| Integrations | Chatwoot and n8n configuration, tests and synchronization |
| Operations | Alerts, JSON metrics, audit and message-counter maintenance |

## Public callbacks and media

- `POST /chatwoot/webhook/{slug}` and the instance-specific Chatwoot callback are not API-key protected because Chatwoot calls them. Configure `CHATWOOT_WEBHOOK_SECRET`; the secret can be supplied through `X-Chatwoot-Secret`, bearer authorization or the generated query parameter.
- `GET /v1/media/{instance}/{mediaId}` uses an expiring HMAC signature (`exp` and `sig`) rather than the API key.

## Destructive operations

- `POST /v1/instances/{name}/logout` logs out and deletes authentication state.
- `POST /v1/instances/{name}/repair-sessions` removes Signal session files and reconnects.
- `POST /v1/webhooks/dlq/purge` permanently deletes eligible dead-letter entries.

Back up state and confirm the target before invoking these endpoints.
