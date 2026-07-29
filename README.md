# Beyound

Self-hosted, multi-instance WhatsApp gateway built with Node.js, TypeScript, Express, SQLite and a Baileys-compatible provider.

> [!IMPORTANT]
> Beyound is an unofficial project and is not affiliated with WhatsApp or Meta. WhatsApp may change its private web protocol without notice. Use this software responsibly and comply with applicable terms, privacy rules and local law.

## Highlights

- Multiple independent WhatsApp instances with QR code or pairing code
- Text, media, location, contact, reaction, poll, list, button and carousel messages
- Persistent chats, messages, contacts and outbound delivery state in SQLite
- Idempotent message sending and delivery confirmation
- Durable webhooks with retries, dead-letter queue and HMAC signatures
- Chatwoot and n8n integrations
- Health, readiness, Prometheus and JSON operational metrics
- Built-in Swagger UI and OpenAPI 3.1 contract
- Docker-first deployment with persistent volumes

## Quick start

### Requirements

- Docker Engine with Docker Compose v2
- At least 2 GB RAM recommended for large initial history synchronizations

### Start

```bash
git clone https://github.com/Reikagilu/baileys_interactive.git
cd baileys_interactive
cp .env.example .env
openssl rand -hex 32
```

Place the generated value in `API_KEY` inside `.env`, set `SERVER_URL`, then start:

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:8787/health
```

The authentication and SQLite state are stored in the named volumes `baileys_auth` and `baileys_data`. Do not delete these volumes during upgrades.

### Connect the first instance

```bash
export BEYOUND_URL=http://localhost:8787
export BEYOUND_API_KEY='your-generated-key'

curl -sS -X POST "$BEYOUND_URL/v1/instances" \
  -H "X-API-Key: [REDACTED]" \
  -H 'Content-Type: application/json' \
  -d '{"instance":"main"}'
```

The response contains a QR data URL while the instance is waiting for pairing. You can also use `POST /v1/instances/{name}/pairing-code`.

## API documentation

Beyound ships a complete OpenAPI 3.1 contract:

- Swagger UI: `GET /docs`
- Machine-readable contract: `GET /openapi.json`
- Usage guide and examples: [`docs/API.md`](docs/API.md)

Documentation is protected by the API key by default. To view it:

```bash
curl -H "X-API-Key: [REDACTED]" "$BEYOUND_URL/openapi.json"
```

Set `PUBLIC_DOCS_ENABLED=true` only when you intentionally want public documentation. API operations remain protected.

## Authentication and scopes

Send the API key in every protected request:

```http
X-API-Key: [REDACTED]
```

For one administrator key, use `API_KEY`. For multiple scoped keys, use `API_KEYS_JSON`; see [`.env.example`](.env.example). Route groups use these scopes:

| Scope | Route group |
|---|---|
| `instances:*` | `/v1/instances/*` |
| `messages:send` | `/v1/messages/*` |
| `chats:*` | `/v1/chats/*` |
| `webhooks:*` | `/v1/webhooks/*` |
| `integrations:*` | `/v1/integrations/*` |
| `ops:read` | `/v1/ops/*`, docs, readiness and metrics |

## Development

```bash
npm ci
npm test
npm run docs:check
npm run dev
```

Node.js 22 is used in CI and Docker. Node.js 20 or newer is supported.

## Production notes

- Put Beyound behind HTTPS when exposing it outside a trusted network.
- Keep `PUBLIC_DOCS_ENABLED`, `PUBLIC_METRICS_ENABLED` and `PUBLIC_READY_ENABLED` disabled unless explicitly needed.
- Keep private-network webhook/integration access disabled by default to reduce SSRF exposure.
- Back up both named volumes before upgrades.
- Never commit `.env`, authentication state, SQLite databases or logs.
- `POST /v1/instances/{name}/logout` deletes authentication state. `POST /repair-sessions` deletes Signal session files. Treat both as destructive.

See [`SECURITY.md`](SECURITY.md) for vulnerability reporting and [`CONTRIBUTING.md`](CONTRIBUTING.md) for development guidance.

## License

MIT — see [`LICENSE`](LICENSE).
