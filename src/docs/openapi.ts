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
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 401: errorResponse, 403: errorResponse },
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
        responses: { 200: okResponse, 404: errorResponse },
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
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse },
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
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse },
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
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse },
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
            },
          },
        },
        responses: { 200: okResponse, 400: errorResponse, 404: errorResponse, 409: errorResponse },
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
        responses: { 200: okResponse },
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
            },
          },
        },
        responses: { 201: okResponse, 400: errorResponse },
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
        responses: { 200: okResponse },
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
        responses: { 200: okResponse, 400: errorResponse, 502: errorResponse },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
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
        required: ['instance', 'to'],
        properties: {
          instance: { type: 'string', example: 'main' },
          to: { type: 'string', example: '5511999999999' },
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
    },
  },
} as const;
