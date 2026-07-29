# Contributing

Thank you for helping improve Beyound.

## Before opening a change

1. Search existing issues and keep each change focused.
2. Never include `.env`, WhatsApp authentication state, SQLite databases, phone numbers, message content, tokens or production logs.
3. For protocol/security changes, describe the threat model and compatibility impact.
4. For destructive behavior, add an explicit guard and documentation.

## Development workflow

```bash
npm ci
npm test
npm run docs:check
```

Use Node.js 22 when possible. Add or update tests for behavior changes. If a route changes, update `src/docs/openapi.ts`; the OpenAPI parity test rejects undocumented or stale routes.

## Pull requests

- Explain the problem, root cause and chosen solution.
- Include reproducible verification output.
- Call out migrations, compatibility changes and operational risks.
- Keep generated `dist/` files synchronized with `src/` by running `npm run build`.
- Do not commit `node_modules` or runtime state.

## Commit style

Use concise imperative commits, for example:

```text
fix: reject inbound delivery receipts
feat: document webhook retry API
docs: add Docker quick start
```

## Responsible use

Beyound uses an unofficial WhatsApp Web integration. Contributions intended for spam, account abuse, credential theft or bypassing platform protections are not accepted.
