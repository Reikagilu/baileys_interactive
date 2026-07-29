# Security policy

## Supported version

Security fixes are applied to the latest commit on the `main` branch.

## Reporting a vulnerability

Please do **not** open a public issue containing an exploit, credential, phone number, WhatsApp session file, message content or production URL.

Use GitHub's private **Security advisories → Report a vulnerability** flow for this repository. Include:

- affected commit/version;
- reproduction steps with sanitized data;
- security impact;
- suggested mitigation, if known.

If private advisories are unavailable, contact the repository owner privately through the contact method shown on their GitHub profile.

## Secrets and sensitive state

The following must never be committed or attached to issues:

- `.env` and API keys;
- `auth/` or WhatsApp session files;
- `data/`, SQLite databases, WAL/SHM files and audit logs;
- Chatwoot/n8n tokens and webhook secrets;
- message payloads, contact lists and phone numbers.

If a secret is exposed, rotate it immediately. Removing it in a later commit does not remove it from Git history.

## Deployment baseline

- Use strong API keys and HTTPS.
- Keep public docs, readiness and metrics disabled unless intentionally exposed.
- Keep private-network webhook and integration destinations disabled by default.
- Configure `CHATWOOT_WEBHOOK_SECRET` for public Chatwoot callbacks.
- Back up authentication and data volumes before upgrades.
