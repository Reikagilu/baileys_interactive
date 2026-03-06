---
source: Context7 API + Official Chatwoot docs
library: Chatwoot
package: chatwoot
topic: outbound integration setup for create/update conversations and messages
fetched: 2026-03-05T00:00:00Z
official_docs: https://developers.chatwoot.com/api-reference/introduction
---

## Scope

This extract covers the minimum fields and endpoints for outbound integrations from external systems using Chatwoot APIs.

## Authentication (Application API)

- Header auth uses `api_access_token` (API key in request header).
- Token type: user access token from Profile Settings (or agent bot token where supported).
- Base path: `/api/v1/...`

## Create Conversation

Endpoint:

- `POST /api/v1/accounts/{account_id}/conversations`

Minimum required fields (per OpenAPI):

- Path: `account_id`
- Body: `source_id`, `inbox_id`

Commonly required in real integrations:

- `contact_id` (to attach to an existing contact)

Optional commonly used:

- `status`, `assignee_id`, `team_id`, `custom_attributes`, `message.content`

## Update Conversation

Primary attribute update endpoint:

- `PATCH /api/v1/accounts/{account_id}/conversations/{conversation_id}`

Fields supported in this endpoint:

- `priority` (`urgent|high|medium|low|none`)
- `sla_policy_id` (enterprise)

Status update endpoint:

- `POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/toggle_status`

Minimum required fields:

- Path: `account_id`, `conversation_id`
- Body: `status` (`open|resolved|pending|snoozed`)

Optional:

- `snoozed_until` (unix timestamp seconds; for `snoozed`)

## Create Message (Application API)

Endpoint:

- `POST /api/v1/accounts/{account_id}/conversations/{conversation_id}/messages`

Minimum required fields:

- Path: `account_id`, `conversation_id`
- Body: `content`

Optional commonly used:

- `message_type` (`outgoing|incoming`)
- `private` (private note)
- `content_type` (default text)

## Update Message

Documented update endpoint in current docs is under Client API (public API), not Application API:

- `PATCH /public/api/v1/inboxes/{inbox_identifier}/contacts/{contact_identifier}/conversations/{conversation_id}/messages/{message_id}`

Payload focus:

- `submitted_values` (bot/message form response update payload)

## Lightweight Connectivity Test Endpoint

Use:

- `GET /api/v1/profile`

Why: minimal read call, validates `api_access_token` and returns authenticated user profile (`200` on success, `401` on auth failure).

## Source pages used

- https://developers.chatwoot.com/api-reference/introduction
- https://developers.chatwoot.com/api-reference/conversations/create-new-conversation
- https://developers.chatwoot.com/api-reference/conversations/update-conversation
- https://developers.chatwoot.com/api-reference/conversations/toggle-status
- https://developers.chatwoot.com/api-reference/messages/create-new-message
- https://developers.chatwoot.com/api-reference/messages-api/update-a-message
- https://developers.chatwoot.com/api-reference/profile/fetch-user-profile
