const secure = [{ ApiKeyAuth: [] }];

const okResponse = {
  description: 'Successful response',
  content: {
    'application/json': {
      schema: {
        $ref: '#/components/schemas/SuccessEnvelope',
      },
    },
  },
};

const errorResponse = {
  description: 'Error response',
  content: {
    'application/json': {
      schema: {
        $ref: '#/components/schemas/ErrorResponse',
      },
    },
  },
};

function okResponseWithExample(example: Record<string, unknown>) {
  return {
    description: 'Successful response',
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/SuccessEnvelope',
        },
        example,
      },
    },
  };
}

function errorResponseWithExample(example: Record<string, unknown>) {
  return {
    description: 'Error response',
    content: {
      'application/json': {
        schema: {
          $ref: '#/components/schemas/ErrorResponse',
        },
        example,
      },
    },
  };
}

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Beyound API',
    version: '1.0.0',
    description:
      'API para gerenciamento de multiplas instancias WhatsApp, mensageria, webhooks, operacoes e integracoes por instancia.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'System', description: 'Health, readiness e metricas' },
    { name: 'Instances', description: 'Ciclo de vida e configuracoes de instancias' },
    { name: 'Messages', description: 'Envio de mensagens canonicas e helpers' },
    { name: 'Chats', description: 'Acoes de chat (read, archive, pin, mute)' },
    { name: 'Webhooks', description: 'Cadastro, fila e reprocessamento de webhooks' },
    { name: 'Ops', description: 'Alertas operacionais e auditoria' },
    { name: 'Integrations', description: 'Integracoes Chatwoot e n8n por instancia' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['System'],
        summary: 'Liveness check',
        operationId: 'getHealth',
        responses: {
          200: okResponse,
        },
      },
    },
    '/ready': {
      get: {
        tags: ['System'],
        summary: 'Readiness check',
        operationId: 'getReady',
        responses: {
          200: okResponse,
        },
      },
    },
    '/metrics': {
      get: {
        tags: ['System'],
        summary: 'Prometheus metrics',
        operationId: 'getMetrics',
        responses: {
          200: {
            description: 'Prometheus text format',
            content: {
              'text/plain': {
                schema: {
                  type: 'string',
                },
              },
            },
          },
        },
      },
    },

    '/v1/instances': {
      get: {
        tags: ['Instances'],
        summary: 'List active and saved instances',
        operationId: 'listInstances',
        security: secure,
        responses: { 200: okResponse, 401: errorResponse, 403: errorResponse },
      },
      post: {
        tags: ['Instances'],
        summary: 'Create or connect an instance',
        operationId: 'createInstance',
        security: secure,
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { instance: { type: 'string', example: 'main' } },
              },
              example: {
                instance: 'loja_sp',
              },
            },
          },
        },
        responses: {
          200: okResponseWithExample({
            ok: true,
            requestId: 'e79f21ad-f03e-4d71-ad5e-1f2f7d9f84e8',
            instance: 'loja_sp',
            status: 'qr',
            qr: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...',
          }),
          400: errorResponseWithExample({
            ok: false,
            error: 'invalid_instance_name',
            requestId: 'e79f21ad-f03e-4d71-ad5e-1f2f7d9f84e8',
          }),
          401: errorResponse,
          403: errorResponse,
        },
      },
    },
    '/v1/instances/saved': {
      get: {
        tags: ['Instances'],
        summary: 'List saved sessions',
        operationId: 'listSavedInstances',
        security: secure,
        responses: { 200: okResponse, 401: errorResponse, 403: errorResponse },
      },
    },
    '/v1/instances/{name}': {
      get: {
        tags: ['Instances'],
        summary: 'Get instance status',
        operationId: 'getInstanceStatus',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
      delete: {
        tags: ['Instances'],
        summary: 'Remove instance from memory',
        operationId: 'removeInstance',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
    },
    '/v1/instances/{name}/qr': {
      get: {
        tags: ['Instances'],
        summary: 'Get current QR code',
        operationId: 'getInstanceQr',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
    },
    '/v1/instances/{name}/pairing-code': {
      post: {
        tags: ['Instances'],
        summary: 'Generate pairing code',
        operationId: 'createPairingCode',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  phoneNumber: { type: 'string', example: '553598828503' },
                  number: { type: 'string', example: '553598828503' },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 403: errorResponse, 409: errorResponse },
      },
    },
    '/v1/instances/{name}/details': {
      get: {
        tags: ['Instances'],
        summary: 'Get rich instance details',
        operationId: 'getInstanceDetails',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: {
          200: okResponseWithExample({
            ok: true,
            requestId: '47d1b62d-a8e8-4b79-84b9-0fbeb16ca24f',
            instance: 'main',
            status: 'connected',
            hasQr: false,
            createdAt: '2026-03-09T12:30:41.123Z',
            linkedNumber: '5511999998888',
            profileName: 'Atendimento Loja',
            profilePictureUrl: 'https://pps.whatsapp.net/v/t61.24694-24/...',
            settings: {
              instance: 'main',
              proxy: { enabled: false, protocol: 'http', host: '', port: '', username: '', password: '' },
              general: {
                rejectCalls: false,
                ignoreGroups: false,
                alwaysOnline: false,
                autoReadMessages: false,
                syncFullHistory: false,
                readStatus: false,
              },
              events: {
                webhookUrl: '',
                toggles: { APPLICATION_STARTUP: false, SEND_MESSAGE: true },
              },
              createdAt: 1762790000000,
              updatedAt: 1762790000000,
            },
          }),
          404: errorResponse,
        },
      },
    },
    '/v1/instances/{name}/restart': {
      post: {
        tags: ['Instances'],
        summary: 'Restart instance connection',
        operationId: 'restartInstance',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: { 200: okResponse, 404: errorResponse, 500: errorResponse },
      },
    },
    '/v1/instances/{name}/disconnect': {
      post: {
        tags: ['Instances'],
        summary: 'Disconnect instance from memory',
        operationId: 'disconnectInstance',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
    },
    '/v1/instances/{name}/logout': {
      post: {
        tags: ['Instances'],
        summary: 'Logout and remove saved credentials',
        operationId: 'logoutInstance',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: { 200: okResponse, 400: errorResponse, 500: errorResponse },
      },
    },
    '/v1/instances/{name}/chats': {
      get: {
        tags: ['Instances'],
        summary: 'List cached chats for an instance',
        operationId: 'listInstanceChats',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
    },
    '/v1/instances/{name}/chats/{jid}/messages': {
      get: {
        tags: ['Instances'],
        summary: 'List cached messages in a chat',
        operationId: 'listInstanceChatMessages',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }, { $ref: '#/components/parameters/Jid' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
      post: {
        tags: ['Instances'],
        summary: 'Send text message from chat panel',
        operationId: 'sendMessageFromChatPanel',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }, { $ref: '#/components/parameters/Jid' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: {
                  text: { type: 'string', example: 'Ola! Tudo bem?' },
                },
              },
              example: {
                text: 'Bom dia! Em que posso ajudar?',
              },
            },
          },
        },
        responses: {
          200: okResponseWithExample({
            ok: true,
            requestId: 'a9ad42de-a52f-4aaf-95bd-b9cde2e44376',
            instance: 'main',
            jid: '5511999998888@s.whatsapp.net',
            messageId: '3EB0AA11BB22CC33DD44',
            timestamp: 1773059804,
          }),
          400: errorResponseWithExample({
            ok: false,
            error: 'text_required',
            requestId: 'a9ad42de-a52f-4aaf-95bd-b9cde2e44376',
          }),
          404: errorResponse,
          409: errorResponseWithExample({
            ok: false,
            error: 'instance_not_connected',
            requestId: 'a9ad42de-a52f-4aaf-95bd-b9cde2e44376',
            message: 'Instance must be connected.',
            details: { status: 'qr' },
          }),
        },
      },
    },
    '/v1/instances/{name}/chats/{jid}/sync-history': {
      post: {
        tags: ['Instances'],
        summary: 'Sync older chat history',
        operationId: 'syncChatHistory',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }, { $ref: '#/components/parameters/Jid' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  maxBatches: { type: 'integer', minimum: 1 },
                  fetchCount: { type: 'integer', minimum: 1 },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse, 501: errorResponse },
      },
    },
    '/v1/instances/{name}/settings': {
      get: {
        tags: ['Instances'],
        summary: 'Get instance settings',
        operationId: 'getInstanceSettings',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
    },
    '/v1/instances/{name}/settings/general': {
      patch: {
        tags: ['Instances'],
        summary: 'Update general settings',
        operationId: 'updateInstanceGeneralSettings',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  rejectCalls: { type: 'boolean' },
                  ignoreGroups: { type: 'boolean' },
                  alwaysOnline: { type: 'boolean' },
                  autoReadMessages: { type: 'boolean' },
                  syncFullHistory: { type: 'boolean' },
                  readStatus: { type: 'boolean' },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse },
      },
    },
    '/v1/instances/{name}/settings/proxy': {
      patch: {
        tags: ['Instances'],
        summary: 'Update proxy settings',
        operationId: 'updateInstanceProxySettings',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  protocol: { type: 'string', enum: ['http', 'https', 'socks5'] },
                  host: { type: 'string' },
                  port: { type: 'integer' },
                  username: { type: 'string' },
                  password: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse },
      },
    },
    '/v1/instances/{name}/events': {
      get: {
        tags: ['Instances'],
        summary: 'Get instance event webhook and toggles',
        operationId: 'getInstanceEvents',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
      patch: {
        tags: ['Instances'],
        summary: 'Update event webhook and toggles',
        operationId: 'updateInstanceEvents',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  webhookUrl: { type: 'string', format: 'uri' },
                  toggles: {
                    type: 'object',
                    additionalProperties: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse },
      },
    },
    '/v1/instances/{name}/events/test': {
      post: {
        tags: ['Instances'],
        summary: 'Trigger a test event',
        operationId: 'testInstanceEvent',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/InstanceName' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  event: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 502: errorResponse },
      },
    },

    '/v1/messages/text': {
      post: {
        tags: ['Messages'],
        summary: 'Send text message',
        operationId: 'sendTextMessage',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/BaseSendMessagePayload',
              },
              example: {
                instance: 'main',
                to: '5511999998888',
                text: 'Oi! Pedido confirmado.',
              },
            },
          },
        },
        responses: {
          200: okResponseWithExample({
            ok: true,
            requestId: 'b6f2f3e0-8f78-4fc5-b8f9-faf7b8f79df3',
            instance: 'main',
            to: '5511999998888@s.whatsapp.net',
            messageId: '3EB0123456789ABCDEF0',
            idempotency: { key: null, replayed: false },
          }),
          400: errorResponseWithExample({
            ok: false,
            error: 'missing_text',
            requestId: 'b6f2f3e0-8f78-4fc5-b8f9-faf7b8f79df3',
          }),
          404: errorResponse,
          409: errorResponseWithExample({
            ok: false,
            error: 'instance_not_connected',
            requestId: 'b6f2f3e0-8f78-4fc5-b8f9-faf7b8f79df3',
            message: 'Instance must be connected.',
            details: { status: 'qr' },
          }),
        },
      },
    },
    '/v1/messages/media': {
      post: {
        tags: ['Messages'],
        summary: 'Send media by URL',
        operationId: 'sendMediaMessage',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    required: ['mediaType', 'mediaUrl'],
                    properties: {
                      mediaType: {
                        type: 'string',
                        enum: ['image', 'video', 'audio', 'document', 'sticker'],
                      },
                      mediaUrl: { type: 'string', format: 'uri' },
                      caption: { type: 'string' },
                      fileName: { type: 'string' },
                      mimetype: { type: 'string' },
                      ptt: { type: 'boolean' },
                    },
                  },
                ],
              },
              example: {
                instance: 'main',
                to: '5511999998888',
                mediaType: 'document',
                mediaUrl: 'https://example.com/nota-fiscal.pdf',
                caption: 'Segue NF',
                fileName: 'nf-123.pdf',
                mimetype: 'application/pdf',
              },
            },
          },
        },
        responses: {
          200: okResponseWithExample({
            ok: true,
            requestId: 'f9cb0c6b-cff0-4dfb-ae6b-df4235d198f7',
            instance: 'main',
            to: '5511999998888@s.whatsapp.net',
            messageId: '3EB0ABCDEF1234567890',
            idempotency: { key: null, replayed: false },
          }),
          400: errorResponseWithExample({
            ok: false,
            error: 'invalid_media_payload',
            requestId: 'f9cb0c6b-cff0-4dfb-ae6b-df4235d198f7',
          }),
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    '/v1/messages/location': {
      post: {
        tags: ['Messages'],
        summary: 'Send location message',
        operationId: 'sendLocationMessage',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    required: ['latitude', 'longitude'],
                    properties: {
                      latitude: { type: 'number' },
                      longitude: { type: 'number' },
                      name: { type: 'string' },
                      address: { type: 'string' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse },
      },
    },
    '/v1/messages/contact': {
      post: {
        tags: ['Messages'],
        summary: 'Send contact (vCard)',
        operationId: 'sendContactMessage',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    properties: {
                      displayName: { type: 'string' },
                      name: { type: 'string' },
                      phoneNumber: { type: 'string' },
                      number: { type: 'string' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse },
      },
    },
    '/v1/messages/reaction': {
      post: {
        tags: ['Messages'],
        summary: 'Send reaction to message',
        operationId: 'sendReactionMessage',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    required: ['messageId'],
                    properties: {
                      messageId: { type: 'string' },
                      reaction: { type: 'string' },
                      text: { type: 'string' },
                      fromMe: { type: 'boolean' },
                    },
                  },
                ],
              },
              example: {
                instance: 'main',
                to: '5511999998888',
                messageId: '3EB0ABCDEF1234567890',
                reaction: '👍',
                fromMe: false,
              },
            },
          },
        },
        responses: {
          200: okResponseWithExample({
            ok: true,
            requestId: 'dc6f02f3-c652-4a3e-b9f9-5a1496f6e273',
            instance: 'main',
            to: '5511999998888@s.whatsapp.net',
            messageId: '3EB0F00DBABE12345678',
            idempotency: { key: null, replayed: false },
          }),
          400: errorResponseWithExample({
            ok: false,
            error: 'invalid_reaction_payload',
            requestId: 'dc6f02f3-c652-4a3e-b9f9-5a1496f6e273',
          }),
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    '/v1/messages/forward': {
      post: {
        tags: ['Messages'],
        summary: 'Forward a message payload or send text fallback',
        operationId: 'forwardMessage',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    properties: {
                      message: { type: 'object', additionalProperties: true },
                      text: { type: 'string' },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse },
      },
    },
    '/v1/messages/send_menu': {
      post: {
        tags: ['Messages'],
        summary: 'Send plain-text menu helper',
        operationId: 'sendMenuHelper',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    required: ['text', 'options'],
                    properties: {
                      title: { type: 'string' },
                      text: { type: 'string' },
                      footer: { type: 'string' },
                      options: { type: 'array', items: { type: 'string' } },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse },
      },
    },
    '/v1/messages/send_buttons_helpers': {
      post: {
        tags: ['Messages'],
        summary: 'Send quick-reply buttons helper',
        operationId: 'sendButtonsHelper',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    required: ['text', 'buttons'],
                    properties: {
                      text: { type: 'string' },
                      footer: { type: 'string' },
                      buttons: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            id: { type: 'string' },
                            text: { type: 'string' },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse },
      },
    },
    '/v1/messages/send_interactive_helpers': {
      post: {
        tags: ['Messages'],
        summary: 'Send CTA interactive helper',
        operationId: 'sendInteractiveHelper',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    required: ['text'],
                    properties: {
                      text: { type: 'string' },
                      footer: { type: 'string' },
                      ctas: { type: 'array', items: { type: 'object', additionalProperties: true } },
                      buttons: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse },
      },
    },
    '/v1/messages/send_list_helpers': {
      post: {
        tags: ['Messages'],
        summary: 'Send list helper',
        operationId: 'sendListHelper',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    required: ['text', 'buttonText', 'sections'],
                    properties: {
                      text: { type: 'string' },
                      buttonText: { type: 'string' },
                      footer: { type: 'string' },
                      sections: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse },
      },
    },
    '/v1/messages/send_poll': {
      post: {
        tags: ['Messages'],
        summary: 'Send poll',
        operationId: 'sendPoll',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    required: ['name', 'options'],
                    properties: {
                      name: { type: 'string' },
                      options: { type: 'array', items: { type: 'string' } },
                      selectableCount: { type: 'integer', minimum: 1 },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse },
      },
    },
    '/v1/messages/send_carousel_helpers': {
      post: {
        tags: ['Messages'],
        summary: 'Send carousel helper',
        operationId: 'sendCarouselHelper',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/TargetMessagePayload' },
                  {
                    type: 'object',
                    required: ['text', 'cards'],
                    properties: {
                      text: { type: 'string' },
                      footer: { type: 'string' },
                      cards: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    },
                  },
                ],
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse },
      },
    },

    '/v1/chats/{jid}/read': {
      post: {
        tags: ['Chats'],
        summary: 'Mark messages as read',
        operationId: 'readChatMessages',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/Jid' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['instance', 'messageIds'],
                properties: {
                  instance: { type: 'string', example: 'main' },
                  messageIds: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse, 501: errorResponse },
      },
    },
    '/v1/chats/{jid}/archive': {
      post: {
        tags: ['Chats'],
        summary: 'Archive chat',
        operationId: 'archiveChat',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/Jid' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/InstanceOnlyPayload' } } },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse, 501: errorResponse },
      },
    },
    '/v1/chats/{jid}/unarchive': {
      post: {
        tags: ['Chats'],
        summary: 'Unarchive chat',
        operationId: 'unarchiveChat',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/Jid' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/InstanceOnlyPayload' } } },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse, 501: errorResponse },
      },
    },
    '/v1/chats/{jid}/pin': {
      post: {
        tags: ['Chats'],
        summary: 'Pin chat',
        operationId: 'pinChat',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/Jid' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/InstanceOnlyPayload' } } },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse, 501: errorResponse },
      },
    },
    '/v1/chats/{jid}/unpin': {
      post: {
        tags: ['Chats'],
        summary: 'Unpin chat',
        operationId: 'unpinChat',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/Jid' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/InstanceOnlyPayload' } } },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse, 501: errorResponse },
      },
    },
    '/v1/chats/{jid}/mute': {
      post: {
        tags: ['Chats'],
        summary: 'Mute chat',
        operationId: 'muteChat',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/Jid' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/InstanceOnlyPayload' } } },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse, 501: errorResponse },
      },
    },
    '/v1/chats/{jid}/unmute': {
      post: {
        tags: ['Chats'],
        summary: 'Unmute chat',
        operationId: 'unmuteChat',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/Jid' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/InstanceOnlyPayload' } } },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse, 501: errorResponse },
      },
    },

    '/v1/webhooks/events': {
      get: {
        tags: ['Webhooks'],
        summary: 'List supported webhook events',
        operationId: 'listWebhookEvents',
        security: secure,
        responses: { 200: okResponse },
      },
    },
    '/v1/webhooks': {
      get: {
        tags: ['Webhooks'],
        summary: 'List registered webhooks',
        operationId: 'listWebhooks',
        security: secure,
        responses: {
          200: okResponseWithExample({
            ok: true,
            requestId: '8f6c9583-9903-4458-b90e-67bdb5d3f5eb',
            webhooks: [
              {
                id: 'f2f2d8b4-b8d7-47d1-9a39-4f7616f8c593',
                name: 'n8n-prod',
                url: 'https://n8n.example.com/webhook/whatsapp',
                events: ['messages.upsert', 'connection.update'],
                instance: 'main',
                enabled: true,
                secret: 'whsec_***',
                createdAt: 1773059200123,
                updatedAt: 1773059200123,
              },
            ],
          }),
        },
      },
      post: {
        tags: ['Webhooks'],
        summary: 'Create webhook',
        operationId: 'createWebhook',
        security: secure,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'url', 'events'],
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string', format: 'uri' },
                  events: { type: 'array', items: { type: 'string' } },
                  instance: { type: 'string' },
                  enabled: { type: 'boolean' },
                  secret: { type: 'string' },
                },
              },
              example: {
                name: 'webhook-principal',
                url: 'https://hooks.example.com/wa',
                events: ['messages.upsert', 'connection.update'],
                instance: 'main',
                enabled: true,
                secret: 'whsec_live_123',
              },
            },
          },
        },
        responses: {
          201: okResponseWithExample({
            ok: true,
            requestId: 'ee9ca5fe-8b39-4b95-b34b-67f3d267a82f',
            webhook: {
              id: '2aef47a0-8ea6-4f89-a9c4-13c9761c6b0f',
              name: 'webhook-principal',
              url: 'https://hooks.example.com/wa',
              events: ['messages.upsert', 'connection.update'],
              instance: 'main',
              enabled: true,
              secret: 'whsec_live_123',
              createdAt: 1773059905123,
              updatedAt: 1773059905123,
            },
          }),
          400: errorResponseWithExample({
            ok: false,
            error: 'invalid_url',
            requestId: 'ee9ca5fe-8b39-4b95-b34b-67f3d267a82f',
            message: 'Webhook URL blocked by security policy.',
            details: {
              reason: 'private_network_url_not_allowed',
              details: 'blocked_host=localhost',
            },
          }),
        },
      },
    },
    '/v1/webhooks/deliveries': {
      get: {
        tags: ['Webhooks'],
        summary: 'List deliveries with optional filters',
        operationId: 'listWebhookDeliveries',
        security: secure,
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'processing', 'delivered', 'failed'] } },
          { name: 'webhookId', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
        ],
        responses: { 200: okResponse },
      },
    },
    '/v1/webhooks/dlq': {
      get: {
        tags: ['Webhooks'],
        summary: 'List dead-letter queue entries',
        operationId: 'listWebhookDlq',
        security: secure,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } }],
        responses: { 200: okResponse },
      },
    },
    '/v1/webhooks/dlq/purge': {
      post: {
        tags: ['Webhooks'],
        summary: 'Purge dead-letter queue',
        operationId: 'purgeWebhookDlq',
        security: secure,
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { olderThanMs: { type: 'integer', minimum: 0 } },
              },
            },
          },
        },
        responses: { 200: okResponse },
      },
    },
    '/v1/webhooks/{id}': {
      patch: {
        tags: ['Webhooks'],
        summary: 'Update webhook',
        operationId: 'updateWebhook',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/WebhookId' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  url: { type: 'string', format: 'uri' },
                  events: { type: 'array', items: { type: 'string' } },
                  instance: { type: 'string' },
                  enabled: { type: 'boolean' },
                  secret: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse },
      },
      delete: {
        tags: ['Webhooks'],
        summary: 'Delete webhook',
        operationId: 'deleteWebhook',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/WebhookId' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
    },
    '/v1/webhooks/{id}/deliveries': {
      get: {
        tags: ['Webhooks'],
        summary: 'List deliveries for webhook',
        operationId: 'listWebhookDeliveriesByWebhook',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/WebhookId' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
    },
    '/v1/webhooks/{id}/test': {
      post: {
        tags: ['Webhooks'],
        summary: 'Queue webhook test event',
        operationId: 'testWebhook',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/WebhookId' }],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  event: { type: 'string' },
                  data: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse },
      },
    },
    '/v1/webhooks/deliveries/{deliveryId}': {
      get: {
        tags: ['Webhooks'],
        summary: 'Get delivery details',
        operationId: 'getWebhookDelivery',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/DeliveryId' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
    },
    '/v1/webhooks/deliveries/{deliveryId}/retry': {
      post: {
        tags: ['Webhooks'],
        summary: 'Retry a delivery',
        operationId: 'retryWebhookDelivery',
        security: secure,
        parameters: [{ $ref: '#/components/parameters/DeliveryId' }],
        responses: { 200: okResponse, 404: errorResponse },
      },
    },

    '/v1/ops/alerts': {
      get: {
        tags: ['Ops'],
        summary: 'Get operational alerts and recommendations',
        operationId: 'getOpsAlerts',
        security: secure,
        responses: {
          200: okResponseWithExample({
            ok: true,
            requestId: 'afdb6d92-4f99-41f9-8159-f1f0f38f15da',
            status: 'degraded',
            alerts: [
              {
                id: 'webhook.pending.high',
                severity: 'high',
                metric: 'webhook.deliveriesPending',
                value: 150,
                threshold: 100,
                message: 'Pending webhook deliveries exceed threshold.',
                recommendation: 'Scale workers and verify target endpoints latency.',
              },
            ],
            snapshot: {
              connectedInstances: 1,
              totalInstances: 3,
              webhook: {
                webhooksTotal: 4,
                webhooksEnabled: 3,
                deliveriesPending: 150,
                deliveriesProcessing: 5,
                deliveriesDelivered: 1000,
                deliveriesFailed: 20,
                deliveriesTotal: 1175,
                oldestPendingAgeSeconds: 420,
              },
            },
          }),
        },
      },
    },
    '/v1/ops/audit': {
      get: {
        tags: ['Ops'],
        summary: 'List latest audit events',
        operationId: 'listAuditEvents',
        security: secure,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } }],
        responses: { 200: okResponse },
      },
    },

    '/v1/integrations': {
      get: {
        tags: ['Integrations'],
        summary: 'List integrations by instance',
        operationId: 'listIntegrations',
        security: secure,
        responses: { 200: okResponse },
      },
    },
    '/v1/integrations/{instance}': {
      get: {
        tags: ['Integrations'],
        summary: 'Get integration config for instance',
        operationId: 'getIntegrationByInstance',
        security: secure,
        parameters: [{ name: 'instance', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: okResponse, 400: errorResponse },
      },
    },
    '/v1/integrations/{instance}/chatwoot': {
      patch: {
        tags: ['Integrations'],
        summary: 'Update Chatwoot integration config',
        operationId: 'updateChatwootIntegration',
        security: secure,
        parameters: [{ name: 'instance', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  baseUrl: { type: 'string', format: 'uri' },
                  accountId: { type: 'integer' },
                  inboxId: { type: 'integer' },
                  apiAccessToken: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse },
      },
    },
    '/v1/integrations/{instance}/chatwoot/test': {
      post: {
        tags: ['Integrations'],
        summary: 'Test Chatwoot connectivity',
        operationId: 'testChatwootIntegration',
        security: secure,
        parameters: [{ name: 'instance', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: okResponse, 400: errorResponse, 502: errorResponse },
      },
    },
    '/v1/integrations/{instance}/n8n': {
      patch: {
        tags: ['Integrations'],
        summary: 'Update n8n integration config',
        operationId: 'updateN8nIntegration',
        security: secure,
        parameters: [{ name: 'instance', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean' },
                  webhookUrl: { type: 'string', format: 'uri' },
                  authHeaderName: { type: 'string' },
                  authHeaderValue: { type: 'string' },
                },
              },
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse },
      },
    },
    '/v1/integrations/{instance}/n8n/test': {
      post: {
        tags: ['Integrations'],
        summary: 'Test n8n webhook connectivity',
        operationId: 'testN8nIntegration',
        security: secure,
        parameters: [{ name: 'instance', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: okResponseWithExample({
            ok: true,
            requestId: '7b1b245d-ae8e-4d49-9f75-838f9fb7f15d',
            tested: true,
            status: 200,
          }),
          400: errorResponseWithExample({
            ok: false,
            error: 'n8n_not_configured',
            requestId: '7b1b245d-ae8e-4d49-9f75-838f9fb7f15d',
          }),
          502: errorResponseWithExample({
            ok: false,
            error: 'n8n_test_failed',
            requestId: '7b1b245d-ae8e-4d49-9f75-838f9fb7f15d',
            message: 'n8n_http_404',
            details: { status: 404 },
          }),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'Use a chave da API no header x-api-key para acessar rotas /v1/*.',
      },
    },
    parameters: {
      InstanceName: {
        name: 'name',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      Jid: {
        name: 'jid',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      WebhookId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
      DeliveryId: {
        name: 'deliveryId',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    },
    schemas: {
      SuccessEnvelope: {
        type: 'object',
        required: ['ok', 'requestId'],
        properties: {
          ok: { type: 'boolean', example: true },
          requestId: { type: 'string', example: '52f15dc9-2379-44fc-b056-3fe2dfdb9482' },
        },
        additionalProperties: true,
      },
      ErrorResponse: {
        type: 'object',
        required: ['ok', 'error'],
        properties: {
          ok: { type: 'boolean', example: false },
          error: { type: 'string', example: 'validation_failed' },
          requestId: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
      InstanceOnlyPayload: {
        type: 'object',
        required: ['instance'],
        properties: {
          instance: { type: 'string', example: 'main' },
        },
      },
      TargetMessagePayload: {
        type: 'object',
        required: ['to'],
        properties: {
          instance: { type: 'string', example: 'main' },
          to: { type: 'string', example: '5511999999999' },
          typingMs: {
            type: 'integer',
            minimum: 300,
            maximum: 10000,
            description: 'Delay opcional de digitacao antes do envio da mensagem.',
            example: 1800,
          },
          typingMode: {
            type: 'string',
            enum: ['auto', 'manual'],
            description: 'Modo de digitacao. `auto` calcula delay por tamanho do texto quando typingMs nao for informado.',
            example: 'auto',
          },
        },
      },
      BaseSendMessagePayload: {
        allOf: [
          { $ref: '#/components/schemas/TargetMessagePayload' },
          {
            type: 'object',
            required: ['text'],
            properties: {
              text: { type: 'string', example: 'Ola! Este e um teste.' },
            },
          },
        ],
      },
      WebhookMessageCrypto: {
        type: 'object',
        description: 'Contexto criptografico compacto opcional da mensagem.',
        properties: {
          senderKeyHash: { type: 'string' },
          recipientKeyHash: { type: 'string' },
          messageSecret: { type: 'string' },
        },
      },
      WebhookMessageMedia: {
        type: 'object',
        description: 'Representacao de midia no payload de webhook/evento de instancia.',
        properties: {
          kind: { type: 'string', enum: ['audio', 'image', 'video', 'sticker', 'document'] },
          mimeType: { type: 'string' },
          fileName: { type: 'string' },
          caption: { type: 'string' },
          mediaId: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          base64: { type: 'string', description: 'Opcional; recomendado manter desabilitado em producao.' },
          bytes: { type: 'integer', minimum: 0 },
          omittedReason: { type: 'string', enum: ['too_large', 'download_failed'] },
        },
      },
      WebhookMessageUpsertItem: {
        type: 'object',
        properties: {
          key: {
            type: 'object',
            properties: {
              remoteJid: { type: 'string' },
              fromMe: { type: 'boolean' },
              id: { type: 'string' },
              participant: { type: 'string' },
            },
            additionalProperties: true,
          },
          messageTimestamp: { type: 'integer' },
          pushName: { type: 'string' },
          text: { type: 'string' },
          message_type: { type: 'string', example: 'audio' },
          messageType: { type: 'string', example: 'audio' },
          sender: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              number: { type: 'string' },
            },
          },
          media: { $ref: '#/components/schemas/WebhookMessageMedia' },
          crypto: { $ref: '#/components/schemas/WebhookMessageCrypto' },
          message: {
            type: 'object',
            description: 'Mensagem raw sanitizada (sem waveform e hashes binarios).',
            additionalProperties: true,
          },
        },
      },
      WebhookMessagesUpsertPayload: {
        type: 'object',
        description: 'Payload padrao emitido em MESSAGES_UPSERT / messages.upsert.',
        properties: {
          type: { type: 'string', example: 'notify' },
          messages: {
            type: 'array',
            items: { $ref: '#/components/schemas/WebhookMessageUpsertItem' },
          },
        },
      },
    },
  },
} as const;
