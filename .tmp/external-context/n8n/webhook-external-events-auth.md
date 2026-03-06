---
source: Context7 API
library: n8n
package: n8n
topic: webhook external events and optional api auth
fetched: 2026-03-05T00:00:00Z
official_docs: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
---

## Relevant n8n docs (filtered)

- Webhook node creates an HTTP endpoint to trigger workflows from external calls.
- Configure required fields: `HTTP Method` and `Path`.
- Use `Production URL` when workflow is active; use `Test URL` while developing with "Listen for Test Event".
- Optional authentication methods on Webhook node: `None`, `Basic auth`, `Header auth`, `JWT auth`.
- For API-key style integration, use `Header auth` and require a custom header name/value.

## Minimal per-instance integration fields

1. `webhook_url`
   - Test: `https://<your-n8n-host>/webhook-test/<path>`
   - Production: `https://<your-n8n-host>/webhook/<path>`
2. `auth_header_name` (optional)
   - Needed for Header auth (for example: `X-API-Key` or `Authorization`).
3. `auth_header_value` or `api_key` (optional)
   - Value expected by the webhook credential.

## Simple connectivity test

Use a request matching your configured method/path. Include header only if auth is enabled.

```bash
curl -i -X POST "https://<your-n8n-host>/webhook/<path>" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <api_key>" \
  -d '{"ping":"ok"}'
```

Expected result from docs:
- 2xx HTTP response (default 200 unless changed)
- Response like "Workflow got started" for immediate response mode, or configured output when response mode is set differently.

## Sources used

- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/
- https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/common-issues/
