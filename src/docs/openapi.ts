type HttpMethod = 'get' | 'post' | 'patch' | 'delete';
type Json = Record<string, unknown>;

const apiKeySecurity = [{ apiKey: [] }];
const jsonContent = (schema: Json) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const requestBody = (schema: Json, required = true) => ({ required, content: jsonContent(schema) });

const commonResponses: Record<string, Json> = {
  '400': { description: 'Invalid request.', content: jsonContent(ref('ErrorResponse')) },
  '401': { description: 'Missing or invalid API key.', content: jsonContent(ref('ErrorResponse')) },
  '404': { description: 'Resource not found.', content: jsonContent(ref('ErrorResponse')) },
  '409': { description: 'Resource state conflict.', content: jsonContent(ref('ErrorResponse')) },
  '429': { description: 'Rate limit exceeded.', headers: { 'Retry-After': { schema: { type: 'integer' } } }, content: jsonContent(ref('ErrorResponse')) },
  '500': { description: 'Internal error.', content: jsonContent(ref('ErrorResponse')) },
};

interface OperationOptions {
  security?: Json[];
  public?: boolean;
  destructive?: boolean;
  parameters?: Json[];
  body?: Json;
  bodyRequired?: boolean;
  response?: Json;
  responseDescription?: string;
  description?: string;
}

const paths: Record<string, Record<string, Json>> = {};

function pathParameters(path: string): Json[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

function add(method: HttpMethod, path: string, tag: string, summary: string, options: OperationOptions = {}): void {
  const successStatus = method === 'post' && path === '/v1/webhooks' ? '201' : '200';
  const operation: Json = {
    operationId: `${method}_${path.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    tags: [tag],
    summary,
    ...(options.description ? { description: options.description } : {}),
    ...(options.destructive ? { 'x-destructive': true } : {}),
    parameters: [...pathParameters(path), ...(options.parameters ?? [])],
    security: options.public ? [] : (options.security ?? apiKeySecurity),
    responses: {
      [successStatus]: {
        description: options.responseDescription ?? 'Successful response.',
        content: jsonContent(options.response ?? ref('SuccessResponse')),
      },
      ...commonResponses,
    },
  };
  if (options.body) operation.requestBody = requestBody(options.body, options.bodyRequired ?? true);
  paths[path] ??= {};
  paths[path][method] = operation;
}

const instanceParam = { name: 'instance', in: 'query', required: false, schema: { type: 'string', default: 'main' } };
const idempotencyHeaders = [
  { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 }, description: 'Prevents duplicate sends during retries.' },
];
const sendBase = {
  type: 'object', required: ['to'], properties: {
    instance: { type: 'string', default: 'main' },
    to: { type: 'string', example: '5511999999999' },
    typingMode: { type: 'string', enum: ['auto', 'manual'] },
    typingMs: { type: 'integer', minimum: 300, maximum: 10000 },
    requireDelivery: { type: 'boolean', default: true },
    deliveryTimeoutMs: { type: 'integer', minimum: 1000, maximum: 60000, default: 15000 },
  },
};
const sendSchema = (required: string[], properties: Json): Json => ({
  ...sendBase,
  required: ['to', ...required],
  properties: { ...(sendBase.properties as Json), ...properties },
});

add('get', '/health', 'System', 'Liveness probe', { public: true, response: { type: 'object', required: ['ok', 'service', 'requestId'], properties: { ok: { const: true }, service: { type: 'string' }, requestId: { type: 'string', format: 'uuid' } } } });
add('get', '/ready', 'System', 'Readiness probe', { description: 'Protected by API key unless PUBLIC_READY_ENABLED=true.' });
add('get', '/metrics', 'System', 'Prometheus metrics', { description: 'Protected by API key unless PUBLIC_METRICS_ENABLED=true.', response: { type: 'string' } });
add('get', '/openapi.json', 'Documentation', 'OpenAPI contract', { description: 'Protected by API key unless PUBLIC_DOCS_ENABLED=true.', response: { type: 'object' } });
add('get', '/docs', 'Documentation', 'Swagger UI', { description: 'Interactive API documentation. Protected by API key unless PUBLIC_DOCS_ENABLED=true.', response: { type: 'string' } });
add('get', '/v1/media/{instance}/{mediaId}', 'Media', 'Download signed media', { public: true, parameters: [
  { name: 'exp', in: 'query', required: true, schema: { type: 'integer' } },
  { name: 'sig', in: 'query', required: true, schema: { type: 'string' } },
], response: { type: 'string', format: 'binary' } });

// Instances and sessions
add('post', '/v1/instances', 'Instances', 'Create or connect an instance', { body: { type: 'object', properties: { instance: { type: 'string', default: 'main' } } } });
add('get', '/v1/instances', 'Instances', 'List active and saved instances');
add('get', '/v1/instances/saved', 'Instances', 'List saved instance names');
add('get', '/v1/instances/{name}', 'Instances', 'Get instance status');
add('get', '/v1/instances/{name}/details', 'Instances', 'Get detailed instance status');
add('get', '/v1/instances/{name}/qr', 'Instances', 'Get pairing QR code');
add('post', '/v1/instances/{name}/pairing-code', 'Instances', 'Request a pairing code', { body: { type: 'object', required: ['phoneNumber'], properties: { phoneNumber: { type: 'string' } } } });
add('post', '/v1/instances/{name}/restart', 'Instances', 'Restart an instance');
add('post', '/v1/instances/{name}/repair-sessions', 'Instances', 'Delete Signal sessions and restart', { destructive: true, description: 'Destructive recovery operation. Back up authentication state first.' });
add('post', '/v1/instances/{name}/disconnect', 'Instances', 'Disconnect while preserving credentials');
add('post', '/v1/instances/{name}/logout', 'Instances', 'Log out and delete authentication state', { destructive: true });
add('delete', '/v1/instances/{name}', 'Instances', 'Remove an active instance while preserving credentials', { destructive: true });
add('get', '/v1/instances/{name}/settings', 'Instance settings', 'Get instance settings');
add('patch', '/v1/instances/{name}/settings/general', 'Instance settings', 'Update general settings', { body: ref('GeneralSettings') });
add('patch', '/v1/instances/{name}/settings/proxy', 'Instance settings', 'Update proxy settings', { body: ref('ProxySettings') });
add('get', '/v1/instances/{name}/events', 'Instance events', 'Get instance event configuration');
add('patch', '/v1/instances/{name}/events', 'Instance events', 'Update instance event configuration', { body: { type: 'object', properties: { webhookUrl: { type: 'string', format: 'uri' }, toggles: { type: 'object', additionalProperties: { type: 'boolean' } } } } });
add('post', '/v1/instances/{name}/events/test', 'Instance events', 'Send a test instance event', { body: { type: 'object', properties: { event: { type: 'string' } } }, bodyRequired: false });
add('get', '/v1/instances/{name}/contacts', 'Contacts', 'List persisted contacts', { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10000, default: 5000 } }] });
add('post', '/v1/instances/{name}/contacts/backfill', 'Contacts', 'Backfill contacts from stored messages');
add('get', '/v1/instances/{name}/chats', 'Chats', 'List chats');
add('get', '/v1/instances/{name}/chats/{jid}/messages', 'Chats', 'List chat messages');
add('post', '/v1/instances/{name}/chats/{jid}/messages', 'Chats', 'Send a text message to a chat', { body: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } });
add('post', '/v1/instances/{name}/chats/{jid}/sync-history', 'Chats', 'Synchronize chat history', { body: { type: 'object', properties: { maxBatches: { type: 'integer', minimum: 1 }, fetchCount: { type: 'integer', minimum: 1 } } }, bodyRequired: false });
add('get', '/v1/instances/{name}/media/{mediaId}', 'Media', 'Download cached instance media', { response: { type: 'string', format: 'binary' } });

// Message sending
add('post', '/v1/messages/text', 'Messages', 'Send text', { parameters: idempotencyHeaders, body: sendSchema(['text'], { text: { type: 'string', maxLength: 65536 } }) });
add('post', '/v1/messages/location', 'Messages', 'Send location', { parameters: idempotencyHeaders, body: sendSchema(['latitude', 'longitude'], { latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, name: { type: 'string' }, address: { type: 'string' } }) });
add('post', '/v1/messages/contact', 'Messages', 'Send contact', { parameters: idempotencyHeaders, body: sendSchema(['displayName', 'phoneNumber'], { displayName: { type: 'string' }, phoneNumber: { type: 'string' } }) });
add('post', '/v1/messages/reaction', 'Messages', 'React to a message', { parameters: idempotencyHeaders, body: sendSchema(['messageId'], { messageId: { type: 'string' }, reaction: { type: 'string' }, fromMe: { type: 'boolean' } }) });
add('post', '/v1/messages/media', 'Messages', 'Send media from a URL', { parameters: idempotencyHeaders, body: sendSchema(['mediaType', 'mediaUrl'], { mediaType: { type: 'string', enum: ['image', 'video', 'audio', 'document', 'sticker'] }, mediaUrl: { type: 'string', format: 'uri' }, caption: { type: 'string' }, fileName: { type: 'string' }, mimetype: { type: 'string' }, ptt: { type: 'boolean' } }) });
add('post', '/v1/messages/forward', 'Messages', 'Forward safe message content', { parameters: idempotencyHeaders, body: sendSchema([], { text: { type: 'string' }, message: { type: 'object' } }) });
add('post', '/v1/messages/send_menu', 'Messages', 'Send a plain-text menu', { body: sendSchema(['text', 'options'], { text: { type: 'string' }, title: { type: 'string' }, footer: { type: 'string' }, options: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'object' }] } } }) });
add('post', '/v1/messages/send_buttons_helpers', 'Messages', 'Send reply buttons', { body: sendSchema(['text', 'buttons'], { text: { type: 'string' }, footer: { type: 'string' }, buttons: { type: 'array', maxItems: 3, items: { type: 'object' } } }) });
add('post', '/v1/messages/send_interactive_helpers', 'Messages', 'Send CTA buttons', { body: sendSchema(['text', 'ctas'], { text: { type: 'string' }, footer: { type: 'string' }, ctas: { type: 'array', maxItems: 3, items: { type: 'object' } } }) });
add('post', '/v1/messages/send_list_helpers', 'Messages', 'Send an interactive list', { body: sendSchema(['text', 'buttonText', 'sections'], { text: { type: 'string' }, buttonText: { type: 'string' }, sections: { type: 'array', maxItems: 10, items: { type: 'object' } } }) });
add('post', '/v1/messages/send_poll', 'Messages', 'Send a poll', { body: sendSchema(['name', 'options'], { name: { type: 'string' }, options: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'string' } }, selectableCount: { type: 'integer', minimum: 1 } }) });
add('post', '/v1/messages/send_carousel_helpers', 'Messages', 'Send a carousel', { body: sendSchema(['text', 'cards'], { text: { type: 'string' }, cards: { type: 'array', maxItems: 10, items: { type: 'object' } } }) });

// Chat actions
for (const action of ['read', 'archive', 'unarchive', 'pin', 'unpin', 'mute', 'unmute']) {
  const properties: Json = { instance: { type: 'string', default: 'main' } };
  if (action === 'read') properties.messageIds = { type: 'array', maxItems: 100, items: { type: 'string' } };
  if (action === 'mute') properties.durationSeconds = { type: 'integer', minimum: 1, maximum: 31536000 };
  add('post', `/v1/chats/{jid}/${action}`, 'Chats', `${action[0].toUpperCase()}${action.slice(1)} chat`, { body: { type: 'object', properties, ...(action === 'read' ? { required: ['messageIds'] } : {}) } });
}

// Webhooks
add('get', '/v1/webhooks/events', 'Webhooks', 'List supported events');
add('get', '/v1/webhooks', 'Webhooks', 'List webhooks');
add('post', '/v1/webhooks', 'Webhooks', 'Create a webhook', { body: ref('WebhookInput') });
add('patch', '/v1/webhooks/{id}', 'Webhooks', 'Update a webhook', { body: ref('WebhookInput'), bodyRequired: false });
add('delete', '/v1/webhooks/{id}', 'Webhooks', 'Delete a webhook', { destructive: true });
add('post', '/v1/webhooks/{id}/test', 'Webhooks', 'Queue a test delivery', { body: { type: 'object', properties: { event: { type: 'string' }, data: {} } }, bodyRequired: false });
add('get', '/v1/webhooks/{id}/deliveries', 'Webhooks', 'List deliveries for a webhook', { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } }] });
add('get', '/v1/webhooks/deliveries', 'Webhooks', 'List deliveries', { parameters: [
  { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'delivered', 'failed'] } },
  { name: 'webhookId', in: 'query', schema: { type: 'string' } },
  { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } },
] });
add('get', '/v1/webhooks/deliveries/{deliveryId}', 'Webhooks', 'Get a delivery');
add('post', '/v1/webhooks/deliveries/{deliveryId}/retry', 'Webhooks', 'Retry a delivery');
add('get', '/v1/webhooks/dlq', 'Webhooks', 'List dead-letter deliveries', { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 500 } }] });
add('post', '/v1/webhooks/dlq/purge', 'Webhooks', 'Purge old dead-letter deliveries', { destructive: true, body: { type: 'object', required: ['olderThanMs'], properties: { olderThanMs: { type: 'integer', minimum: 0 } } } });

// Operations
add('get', '/v1/ops/alerts', 'Operations', 'Get operational alerts');
add('get', '/v1/ops/metrics', 'Operations', 'Get JSON operational metrics');
add('get', '/v1/ops/audit', 'Operations', 'List recent audit events', { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 1000, default: 100 } }] });
add('post', '/v1/admin/recount', 'Operations', 'Recompute chat message counters');
add('post', '/v1/admin/recount/{instance}', 'Operations', 'Recompute counters for one instance');

// Integrations
add('get', '/v1/integrations', 'Integrations', 'List configured integration instances');
add('get', '/v1/integrations/{instance}', 'Integrations', 'Get redacted integration configuration');
add('patch', '/v1/integrations/{instance}/chatwoot', 'Integrations', 'Update Chatwoot configuration', { body: ref('ChatwootConfig'), bodyRequired: false });
add('post', '/v1/integrations/{instance}/chatwoot/test', 'Integrations', 'Test Chatwoot connectivity');
add('post', '/v1/integrations/{instance}/chatwoot/sync-contact-names', 'Integrations', 'Sync contact names to Chatwoot');
add('post', '/v1/integrations/{instance}/chatwoot/invalidate-cache', 'Integrations', 'Invalidate Chatwoot conversation cache');
add('post', '/v1/integrations/{instance}/chatwoot/autocreate', 'Integrations', 'Create or update the Chatwoot inbox', { body: { type: 'object', properties: { force: { type: 'boolean' } } }, bodyRequired: false });
add('post', '/v1/integrations/{instance}/chatwoot/sync-history', 'Integrations', 'Start Chatwoot history sync', { body: { type: 'object', properties: { daysLimit: { type: 'integer', minimum: 0, maximum: 365 } } }, bodyRequired: false });
add('get', '/v1/integrations/{instance}/chatwoot/sync-status', 'Integrations', 'Get Chatwoot sync status');
add('post', '/v1/integrations/{instance}/chatwoot/sync-cancel', 'Integrations', 'Cancel Chatwoot history sync');
add('patch', '/v1/integrations/{instance}/n8n', 'Integrations', 'Update n8n configuration', { body: ref('N8nConfig'), bodyRequired: false });
add('post', '/v1/integrations/{instance}/n8n/test', 'Integrations', 'Test n8n connectivity');
add('post', '/v1/integrations/{instance}/chatwoot/webhook', 'Chatwoot callbacks', 'Receive a Chatwoot webhook for an instance', { public: true, security: [], body: { type: 'object', additionalProperties: true } });
add('post', '/chatwoot/webhook/{slug}', 'Chatwoot callbacks', 'Receive a Chatwoot webhook by slug', { public: true, security: [], parameters: [{ name: 'secret', in: 'query', required: false, schema: { type: 'string' }, description: 'Use X-Chatwoot-Secret header instead when possible.' }], body: { type: 'object', additionalProperties: true } });

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Beyound API',
    version: '1.0.0',
    description: 'Self-hosted, multi-instance WhatsApp gateway. This project is unofficial and is not affiliated with WhatsApp or Meta. Use responsibly and comply with applicable terms and laws.',
    license: { name: 'MIT', identifier: 'MIT' },
  },
  servers: [{ url: 'http://localhost:8787', description: 'Local Docker deployment' }],
  tags: [
    'System', 'Documentation', 'Instances', 'Instance settings', 'Instance events', 'Contacts',
    'Messages', 'Chats', 'Media', 'Webhooks', 'Operations', 'Integrations', 'Chatwoot callbacks',
  ].map((name) => ({ name })),
  security: apiKeySecurity,
  paths,
  components: {
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'API key configured through API_KEY or API_KEYS_JSON.' },
    },
    schemas: {
      SuccessResponse: { type: 'object', required: ['ok', 'requestId'], properties: { ok: { const: true }, requestId: { type: 'string', format: 'uuid' } }, additionalProperties: true },
      ErrorResponse: { type: 'object', required: ['ok', 'error', 'requestId'], properties: { ok: { const: false }, error: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string', format: 'uuid' }, details: {} } },
      GeneralSettings: { type: 'object', properties: { rejectCalls: { type: 'boolean' }, ignoreGroups: { type: 'boolean' }, alwaysOnline: { type: 'boolean' }, autoReadMessages: { type: 'boolean' }, syncFullHistory: { type: 'boolean', description: 'Solicita uma sincronização única do histórico quando o socket conecta; não executa polling contínuo.' }, readStatus: { type: 'boolean' }, importContacts: { type: 'boolean' } } },
      ProxySettings: { type: 'object', properties: { enabled: { type: 'boolean' }, protocol: { type: 'string', enum: ['http', 'https', 'socks4', 'socks5'] }, host: { type: 'string' }, port: { oneOf: [{ type: 'string' }, { type: 'integer' }] }, username: { type: 'string' }, password: { type: 'string', writeOnly: true } } },
      WebhookInput: { type: 'object', required: ['name', 'url', 'events'], properties: { name: { type: 'string', maxLength: 200 }, url: { type: 'string', format: 'uri' }, events: { type: 'array', minItems: 1, items: { type: 'string' } }, instance: { type: ['string', 'null'] }, enabled: { type: 'boolean' }, secret: { type: ['string', 'null'], writeOnly: true, maxLength: 256 } } },
      ChatwootConfig: { type: 'object', properties: { enabled: { type: 'boolean' }, baseUrl: { type: 'string', format: 'uri' }, accountId: { type: 'string' }, inboxId: { type: 'string' }, apiAccessToken: { type: 'string', writeOnly: true }, nameInbox: { type: 'string' }, webhookSlug: { type: 'string' }, signMessages: { type: 'boolean' }, organization: { type: 'string' }, autoCreate: { type: 'boolean' }, importMessages: { type: 'boolean' }, daysLimitImportMessages: { type: 'integer', minimum: 0, maximum: 365 } } },
      N8nConfig: { type: 'object', properties: { enabled: { type: 'boolean' }, webhookUrl: { type: 'string', format: 'uri' }, authHeaderName: { type: 'string' }, authHeaderValue: { type: 'string', writeOnly: true } } },
    },
  },
} as const;

export type OpenApiSpec = typeof openApiSpec;
