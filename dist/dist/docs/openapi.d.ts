export declare const openApiSpec: {
    readonly openapi: "3.0.3";
    readonly info: {
        readonly title: "Beyound API";
        readonly version: "1.0.0";
        readonly description: "API para gerenciamento de multiplas instancias WhatsApp, mensageria, webhooks, operacoes e integracoes por instancia.";
    };
    readonly servers: readonly [{
        readonly url: "/";
    }];
    readonly tags: readonly [{
        readonly name: "System";
        readonly description: "Health, readiness e metricas";
    }, {
        readonly name: "Instances";
        readonly description: "Ciclo de vida e configuracoes de instancias";
    }, {
        readonly name: "Messages";
        readonly description: "Envio de mensagens canonicas e helpers";
    }, {
        readonly name: "Chats";
        readonly description: "Acoes de chat (read, archive, pin, mute)";
    }, {
        readonly name: "Webhooks";
        readonly description: "Cadastro, fila e reprocessamento de webhooks";
    }, {
        readonly name: "Ops";
        readonly description: "Alertas operacionais e auditoria";
    }, {
        readonly name: "Integrations";
        readonly description: "Integracoes Chatwoot e n8n por instancia";
    }];
    readonly paths: {
        readonly '/health': {
            readonly get: {
                readonly tags: readonly ["System"];
                readonly summary: "Liveness check";
                readonly operationId: "getHealth";
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/ready': {
            readonly get: {
                readonly tags: readonly ["System"];
                readonly summary: "Readiness check";
                readonly operationId: "getReady";
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/metrics': {
            readonly get: {
                readonly tags: readonly ["System"];
                readonly summary: "Prometheus metrics";
                readonly operationId: "getMetrics";
                readonly responses: {
                    readonly 200: {
                        readonly description: "Prometheus text format";
                        readonly content: {
                            readonly 'text/plain': {
                                readonly schema: {
                                    readonly type: "string";
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances': {
            readonly get: {
                readonly tags: readonly ["Instances"];
                readonly summary: "List active and saved instances";
                readonly operationId: "listInstances";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 401: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 403: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly post: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Create or connect an instance";
                readonly operationId: "createInstance";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: false;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly instance: {
                                        readonly type: "string";
                                        readonly example: "main";
                                    };
                                };
                            };
                            readonly example: {
                                readonly instance: "loja_sp";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 401: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 403: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/saved': {
            readonly get: {
                readonly tags: readonly ["Instances"];
                readonly summary: "List saved sessions";
                readonly operationId: "listSavedInstances";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 401: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 403: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}': {
            readonly get: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Get instance status";
                readonly operationId: "getInstanceStatus";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly delete: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Remove instance from memory";
                readonly operationId: "removeInstance";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/qr': {
            readonly get: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Get current QR code";
                readonly operationId: "getInstanceQr";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/pairing-code': {
            readonly post: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Generate pairing code";
                readonly operationId: "createPairingCode";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly phoneNumber: {
                                        readonly type: "string";
                                        readonly example: "553598828503";
                                    };
                                    readonly number: {
                                        readonly type: "string";
                                        readonly example: "553598828503";
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 403: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/details': {
            readonly get: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Get rich instance details";
                readonly operationId: "getInstanceDetails";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/restart': {
            readonly post: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Restart instance connection";
                readonly operationId: "restartInstance";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 500: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/disconnect': {
            readonly post: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Disconnect instance from memory";
                readonly operationId: "disconnectInstance";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/logout': {
            readonly post: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Logout and remove saved credentials";
                readonly operationId: "logoutInstance";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 500: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/chats': {
            readonly get: {
                readonly tags: readonly ["Instances"];
                readonly summary: "List cached chats for an instance";
                readonly operationId: "listInstanceChats";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/chats/{jid}/messages': {
            readonly get: {
                readonly tags: readonly ["Instances"];
                readonly summary: "List cached messages in a chat";
                readonly operationId: "listInstanceChatMessages";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }, {
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly post: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Send text message from chat panel";
                readonly operationId: "sendMessageFromChatPanel";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }, {
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly required: readonly ["text"];
                                readonly properties: {
                                    readonly text: {
                                        readonly type: "string";
                                        readonly example: "Ola! Tudo bem?";
                                    };
                                };
                            };
                            readonly example: {
                                readonly text: "Bom dia! Em que posso ajudar?";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/chats/{jid}/sync-history': {
            readonly post: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Sync older chat history";
                readonly operationId: "syncChatHistory";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }, {
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly requestBody: {
                    readonly required: false;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly maxBatches: {
                                        readonly type: "integer";
                                        readonly minimum: 1;
                                    };
                                    readonly fetchCount: {
                                        readonly type: "integer";
                                        readonly minimum: 1;
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 501: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/settings': {
            readonly get: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Get instance settings";
                readonly operationId: "getInstanceSettings";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/settings/general': {
            readonly patch: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Update general settings";
                readonly operationId: "updateInstanceGeneralSettings";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly rejectCalls: {
                                        readonly type: "boolean";
                                    };
                                    readonly ignoreGroups: {
                                        readonly type: "boolean";
                                    };
                                    readonly alwaysOnline: {
                                        readonly type: "boolean";
                                    };
                                    readonly autoReadMessages: {
                                        readonly type: "boolean";
                                    };
                                    readonly syncFullHistory: {
                                        readonly type: "boolean";
                                    };
                                    readonly readStatus: {
                                        readonly type: "boolean";
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/settings/proxy': {
            readonly patch: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Update proxy settings";
                readonly operationId: "updateInstanceProxySettings";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly protocol: {
                                        readonly type: "string";
                                        readonly enum: readonly ["http", "https", "socks5"];
                                    };
                                    readonly host: {
                                        readonly type: "string";
                                    };
                                    readonly port: {
                                        readonly type: "integer";
                                    };
                                    readonly username: {
                                        readonly type: "string";
                                    };
                                    readonly password: {
                                        readonly type: "string";
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/events': {
            readonly get: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Get instance event webhook and toggles";
                readonly operationId: "getInstanceEvents";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly patch: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Update event webhook and toggles";
                readonly operationId: "updateInstanceEvents";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly webhookUrl: {
                                        readonly type: "string";
                                        readonly format: "uri";
                                    };
                                    readonly toggles: {
                                        readonly type: "object";
                                        readonly additionalProperties: {
                                            readonly type: "boolean";
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/instances/{name}/events/test': {
            readonly post: {
                readonly tags: readonly ["Instances"];
                readonly summary: "Trigger a test event";
                readonly operationId: "testInstanceEvent";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/InstanceName";
                }];
                readonly requestBody: {
                    readonly required: false;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly event: {
                                        readonly type: "string";
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 502: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/text': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send text message";
                readonly operationId: "sendTextMessage";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/BaseSendMessagePayload";
                            };
                            readonly example: {
                                readonly instance: "main";
                                readonly to: "5511999998888";
                                readonly text: "Oi! Pedido confirmado.";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/media': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send media by URL";
                readonly operationId: "sendMediaMessage";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly required: readonly ["mediaType", "mediaUrl"];
                                    readonly properties: {
                                        readonly mediaType: {
                                            readonly type: "string";
                                            readonly enum: readonly ["image", "video", "audio", "document", "sticker"];
                                        };
                                        readonly mediaUrl: {
                                            readonly type: "string";
                                            readonly format: "uri";
                                        };
                                        readonly caption: {
                                            readonly type: "string";
                                        };
                                        readonly fileName: {
                                            readonly type: "string";
                                        };
                                        readonly mimetype: {
                                            readonly type: "string";
                                        };
                                        readonly ptt: {
                                            readonly type: "boolean";
                                        };
                                    };
                                }];
                            };
                            readonly example: {
                                readonly instance: "main";
                                readonly to: "5511999998888";
                                readonly mediaType: "document";
                                readonly mediaUrl: "https://example.com/nota-fiscal.pdf";
                                readonly caption: "Segue NF";
                                readonly fileName: "nf-123.pdf";
                                readonly mimetype: "application/pdf";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/location': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send location message";
                readonly operationId: "sendLocationMessage";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly required: readonly ["latitude", "longitude"];
                                    readonly properties: {
                                        readonly latitude: {
                                            readonly type: "number";
                                        };
                                        readonly longitude: {
                                            readonly type: "number";
                                        };
                                        readonly name: {
                                            readonly type: "string";
                                        };
                                        readonly address: {
                                            readonly type: "string";
                                        };
                                    };
                                }];
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/contact': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send contact (vCard)";
                readonly operationId: "sendContactMessage";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly displayName: {
                                            readonly type: "string";
                                        };
                                        readonly name: {
                                            readonly type: "string";
                                        };
                                        readonly phoneNumber: {
                                            readonly type: "string";
                                        };
                                        readonly number: {
                                            readonly type: "string";
                                        };
                                    };
                                }];
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/reaction': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send reaction to message";
                readonly operationId: "sendReactionMessage";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly required: readonly ["messageId"];
                                    readonly properties: {
                                        readonly messageId: {
                                            readonly type: "string";
                                        };
                                        readonly reaction: {
                                            readonly type: "string";
                                        };
                                        readonly text: {
                                            readonly type: "string";
                                        };
                                        readonly fromMe: {
                                            readonly type: "boolean";
                                        };
                                    };
                                }];
                            };
                            readonly example: {
                                readonly instance: "main";
                                readonly to: "5511999998888";
                                readonly messageId: "3EB0ABCDEF1234567890";
                                readonly reaction: "👍";
                                readonly fromMe: false;
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/forward': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Forward a message payload or send text fallback";
                readonly operationId: "forwardMessage";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly properties: {
                                        readonly message: {
                                            readonly type: "object";
                                            readonly additionalProperties: true;
                                        };
                                        readonly text: {
                                            readonly type: "string";
                                        };
                                    };
                                }];
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/send_menu': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send plain-text menu helper";
                readonly operationId: "sendMenuHelper";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly required: readonly ["text", "options"];
                                    readonly properties: {
                                        readonly title: {
                                            readonly type: "string";
                                        };
                                        readonly text: {
                                            readonly type: "string";
                                        };
                                        readonly footer: {
                                            readonly type: "string";
                                        };
                                        readonly options: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "string";
                                            };
                                        };
                                    };
                                }];
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/send_buttons_helpers': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send quick-reply buttons helper";
                readonly operationId: "sendButtonsHelper";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly required: readonly ["text", "buttons"];
                                    readonly properties: {
                                        readonly text: {
                                            readonly type: "string";
                                        };
                                        readonly footer: {
                                            readonly type: "string";
                                        };
                                        readonly buttons: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "object";
                                                readonly properties: {
                                                    readonly id: {
                                                        readonly type: "string";
                                                    };
                                                    readonly text: {
                                                        readonly type: "string";
                                                    };
                                                };
                                            };
                                        };
                                    };
                                }];
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/send_interactive_helpers': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send CTA interactive helper";
                readonly operationId: "sendInteractiveHelper";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly required: readonly ["text"];
                                    readonly properties: {
                                        readonly text: {
                                            readonly type: "string";
                                        };
                                        readonly footer: {
                                            readonly type: "string";
                                        };
                                        readonly ctas: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "object";
                                                readonly additionalProperties: true;
                                            };
                                        };
                                        readonly buttons: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "object";
                                                readonly additionalProperties: true;
                                            };
                                        };
                                    };
                                }];
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/send_list_helpers': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send list helper";
                readonly operationId: "sendListHelper";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly required: readonly ["text", "buttonText", "sections"];
                                    readonly properties: {
                                        readonly text: {
                                            readonly type: "string";
                                        };
                                        readonly buttonText: {
                                            readonly type: "string";
                                        };
                                        readonly footer: {
                                            readonly type: "string";
                                        };
                                        readonly sections: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "object";
                                                readonly additionalProperties: true;
                                            };
                                        };
                                    };
                                }];
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/send_poll': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send poll";
                readonly operationId: "sendPoll";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly required: readonly ["name", "options"];
                                    readonly properties: {
                                        readonly name: {
                                            readonly type: "string";
                                        };
                                        readonly options: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "string";
                                            };
                                        };
                                        readonly selectableCount: {
                                            readonly type: "integer";
                                            readonly minimum: 1;
                                        };
                                    };
                                }];
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/messages/send_carousel_helpers': {
            readonly post: {
                readonly tags: readonly ["Messages"];
                readonly summary: "Send carousel helper";
                readonly operationId: "sendCarouselHelper";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly allOf: readonly [{
                                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                                }, {
                                    readonly type: "object";
                                    readonly required: readonly ["text", "cards"];
                                    readonly properties: {
                                        readonly text: {
                                            readonly type: "string";
                                        };
                                        readonly footer: {
                                            readonly type: "string";
                                        };
                                        readonly cards: {
                                            readonly type: "array";
                                            readonly items: {
                                                readonly type: "object";
                                                readonly additionalProperties: true;
                                            };
                                        };
                                    };
                                }];
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/chats/{jid}/read': {
            readonly post: {
                readonly tags: readonly ["Chats"];
                readonly summary: "Mark messages as read";
                readonly operationId: "readChatMessages";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly required: readonly ["instance", "messageIds"];
                                readonly properties: {
                                    readonly instance: {
                                        readonly type: "string";
                                        readonly example: "main";
                                    };
                                    readonly messageIds: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 501: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/chats/{jid}/archive': {
            readonly post: {
                readonly tags: readonly ["Chats"];
                readonly summary: "Archive chat";
                readonly operationId: "archiveChat";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/InstanceOnlyPayload";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 501: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/chats/{jid}/unarchive': {
            readonly post: {
                readonly tags: readonly ["Chats"];
                readonly summary: "Unarchive chat";
                readonly operationId: "unarchiveChat";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/InstanceOnlyPayload";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 501: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/chats/{jid}/pin': {
            readonly post: {
                readonly tags: readonly ["Chats"];
                readonly summary: "Pin chat";
                readonly operationId: "pinChat";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/InstanceOnlyPayload";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 501: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/chats/{jid}/unpin': {
            readonly post: {
                readonly tags: readonly ["Chats"];
                readonly summary: "Unpin chat";
                readonly operationId: "unpinChat";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/InstanceOnlyPayload";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 501: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/chats/{jid}/mute': {
            readonly post: {
                readonly tags: readonly ["Chats"];
                readonly summary: "Mute chat";
                readonly operationId: "muteChat";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/InstanceOnlyPayload";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 501: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/chats/{jid}/unmute': {
            readonly post: {
                readonly tags: readonly ["Chats"];
                readonly summary: "Unmute chat";
                readonly operationId: "unmuteChat";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/Jid";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly $ref: "#/components/schemas/InstanceOnlyPayload";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 409: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 501: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/events': {
            readonly get: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "List supported webhook events";
                readonly operationId: "listWebhookEvents";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks': {
            readonly get: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "List registered webhooks";
                readonly operationId: "listWebhooks";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                };
            };
            readonly post: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "Create webhook";
                readonly operationId: "createWebhook";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly required: readonly ["name", "url", "events"];
                                readonly properties: {
                                    readonly name: {
                                        readonly type: "string";
                                    };
                                    readonly url: {
                                        readonly type: "string";
                                        readonly format: "uri";
                                    };
                                    readonly events: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly instance: {
                                        readonly type: "string";
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly secret: {
                                        readonly type: "string";
                                    };
                                };
                            };
                            readonly example: {
                                readonly name: "webhook-principal";
                                readonly url: "https://hooks.example.com/wa";
                                readonly events: readonly ["messages.upsert", "connection.update"];
                                readonly instance: "main";
                                readonly enabled: true;
                                readonly secret: "[REDACTED]";
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 201: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/deliveries': {
            readonly get: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "List deliveries with optional filters";
                readonly operationId: "listWebhookDeliveries";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly name: "status";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                        readonly enum: readonly ["pending", "processing", "delivered", "failed"];
                    };
                }, {
                    readonly name: "webhookId";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "string";
                    };
                }, {
                    readonly name: "limit";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "integer";
                        readonly minimum: 1;
                    };
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/dlq': {
            readonly get: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "List dead-letter queue entries";
                readonly operationId: "listWebhookDlq";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly name: "limit";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "integer";
                        readonly minimum: 1;
                    };
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/dlq/purge': {
            readonly post: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "Purge dead-letter queue";
                readonly operationId: "purgeWebhookDlq";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly requestBody: {
                    readonly required: false;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly olderThanMs: {
                                        readonly type: "integer";
                                        readonly minimum: 0;
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/{id}': {
            readonly patch: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "Update webhook";
                readonly operationId: "updateWebhook";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/WebhookId";
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly name: {
                                        readonly type: "string";
                                    };
                                    readonly url: {
                                        readonly type: "string";
                                        readonly format: "uri";
                                    };
                                    readonly events: {
                                        readonly type: "array";
                                        readonly items: {
                                            readonly type: "string";
                                        };
                                    };
                                    readonly instance: {
                                        readonly type: "string";
                                    };
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly secret: {
                                        readonly type: "string";
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
            readonly delete: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "Delete webhook";
                readonly operationId: "deleteWebhook";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/WebhookId";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/{id}/deliveries': {
            readonly get: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "List deliveries for webhook";
                readonly operationId: "listWebhookDeliveriesByWebhook";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/WebhookId";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/{id}/test': {
            readonly post: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "Queue webhook test event";
                readonly operationId: "testWebhook";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/WebhookId";
                }];
                readonly requestBody: {
                    readonly required: false;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly event: {
                                        readonly type: "string";
                                    };
                                    readonly data: {
                                        readonly type: "object";
                                        readonly additionalProperties: true;
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/deliveries/{deliveryId}': {
            readonly get: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "Get delivery details";
                readonly operationId: "getWebhookDelivery";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/DeliveryId";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/webhooks/deliveries/{deliveryId}/retry': {
            readonly post: {
                readonly tags: readonly ["Webhooks"];
                readonly summary: "Retry a delivery";
                readonly operationId: "retryWebhookDelivery";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly $ref: "#/components/parameters/DeliveryId";
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 404: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/ops/alerts': {
            readonly get: {
                readonly tags: readonly ["Ops"];
                readonly summary: "Get operational alerts and recommendations";
                readonly operationId: "getOpsAlerts";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/ops/audit': {
            readonly get: {
                readonly tags: readonly ["Ops"];
                readonly summary: "List latest audit events";
                readonly operationId: "listAuditEvents";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly name: "limit";
                    readonly in: "query";
                    readonly schema: {
                        readonly type: "integer";
                        readonly minimum: 1;
                    };
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/integrations': {
            readonly get: {
                readonly tags: readonly ["Integrations"];
                readonly summary: "List integrations by instance";
                readonly operationId: "listIntegrations";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/integrations/{instance}': {
            readonly get: {
                readonly tags: readonly ["Integrations"];
                readonly summary: "Get integration config for instance";
                readonly operationId: "getIntegrationByInstance";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly name: "instance";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/integrations/{instance}/chatwoot': {
            readonly patch: {
                readonly tags: readonly ["Integrations"];
                readonly summary: "Update Chatwoot integration config";
                readonly operationId: "updateChatwootIntegration";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly name: "instance";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly baseUrl: {
                                        readonly type: "string";
                                        readonly format: "uri";
                                    };
                                    readonly accountId: {
                                        readonly type: "integer";
                                    };
                                    readonly inboxId: {
                                        readonly type: "integer";
                                    };
                                    readonly apiAccessToken: {
                                        readonly type: "string";
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/integrations/{instance}/chatwoot/test': {
            readonly post: {
                readonly tags: readonly ["Integrations"];
                readonly summary: "Test Chatwoot connectivity";
                readonly operationId: "testChatwootIntegration";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly name: "instance";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 502: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/integrations/{instance}/n8n': {
            readonly patch: {
                readonly tags: readonly ["Integrations"];
                readonly summary: "Update n8n integration config";
                readonly operationId: "updateN8nIntegration";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly name: "instance";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly requestBody: {
                    readonly required: true;
                    readonly content: {
                        readonly 'application/json': {
                            readonly schema: {
                                readonly type: "object";
                                readonly properties: {
                                    readonly enabled: {
                                        readonly type: "boolean";
                                    };
                                    readonly webhookUrl: {
                                        readonly type: "string";
                                        readonly format: "uri";
                                    };
                                    readonly authHeaderName: {
                                        readonly type: "string";
                                    };
                                    readonly authHeaderValue: {
                                        readonly type: "string";
                                    };
                                };
                            };
                        };
                    };
                };
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                            };
                        };
                    };
                };
            };
        };
        readonly '/v1/integrations/{instance}/n8n/test': {
            readonly post: {
                readonly tags: readonly ["Integrations"];
                readonly summary: "Test n8n webhook connectivity";
                readonly operationId: "testN8nIntegration";
                readonly security: {
                    ApiKeyAuth: never[];
                }[];
                readonly parameters: readonly [{
                    readonly name: "instance";
                    readonly in: "path";
                    readonly required: true;
                    readonly schema: {
                        readonly type: "string";
                    };
                }];
                readonly responses: {
                    readonly 200: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 400: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                    readonly 502: {
                        description: string;
                        content: {
                            'application/json': {
                                schema: {
                                    $ref: string;
                                };
                                example: Record<string, unknown>;
                            };
                        };
                    };
                };
            };
        };
    };
    readonly components: {
        readonly securitySchemes: {
            readonly ApiKeyAuth: {
                readonly type: "apiKey";
                readonly in: "header";
                readonly name: "x-api-key";
                readonly description: "Use a chave da API no header x-api-key para acessar rotas /v1/*.";
            };
        };
        readonly parameters: {
            readonly InstanceName: {
                readonly name: "name";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                };
            };
            readonly Jid: {
                readonly name: "jid";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                };
            };
            readonly WebhookId: {
                readonly name: "id";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                };
            };
            readonly DeliveryId: {
                readonly name: "deliveryId";
                readonly in: "path";
                readonly required: true;
                readonly schema: {
                    readonly type: "string";
                };
            };
        };
        readonly schemas: {
            readonly SuccessEnvelope: {
                readonly type: "object";
                readonly required: readonly ["ok", "requestId"];
                readonly properties: {
                    readonly ok: {
                        readonly type: "boolean";
                        readonly example: true;
                    };
                    readonly requestId: {
                        readonly type: "string";
                        readonly example: "52f15dc9-2379-44fc-b056-3fe2dfdb9482";
                    };
                };
                readonly additionalProperties: true;
            };
            readonly ErrorResponse: {
                readonly type: "object";
                readonly required: readonly ["ok", "error"];
                readonly properties: {
                    readonly ok: {
                        readonly type: "boolean";
                        readonly example: false;
                    };
                    readonly error: {
                        readonly type: "string";
                        readonly example: "validation_failed";
                    };
                    readonly requestId: {
                        readonly type: "string";
                    };
                    readonly message: {
                        readonly type: "string";
                    };
                    readonly details: {
                        readonly type: "object";
                        readonly additionalProperties: true;
                    };
                };
            };
            readonly InstanceOnlyPayload: {
                readonly type: "object";
                readonly required: readonly ["instance"];
                readonly properties: {
                    readonly instance: {
                        readonly type: "string";
                        readonly example: "main";
                    };
                };
            };
            readonly TargetMessagePayload: {
                readonly type: "object";
                readonly required: readonly ["to"];
                readonly properties: {
                    readonly instance: {
                        readonly type: "string";
                        readonly example: "main";
                    };
                    readonly to: {
                        readonly type: "string";
                        readonly example: "5511999999999";
                    };
                    readonly typingMs: {
                        readonly type: "integer";
                        readonly minimum: 300;
                        readonly maximum: 10000;
                        readonly description: "Delay opcional de digitacao antes do envio da mensagem.";
                        readonly example: 1800;
                    };
                    readonly typingMode: {
                        readonly type: "string";
                        readonly enum: readonly ["auto", "manual"];
                        readonly description: "Modo de digitacao. `auto` calcula delay por tamanho do texto quando typingMs nao for informado.";
                        readonly example: "auto";
                    };
                };
            };
            readonly BaseSendMessagePayload: {
                readonly allOf: readonly [{
                    readonly $ref: "#/components/schemas/TargetMessagePayload";
                }, {
                    readonly type: "object";
                    readonly required: readonly ["text"];
                    readonly properties: {
                        readonly text: {
                            readonly type: "string";
                            readonly example: "Ola! Este e um teste.";
                        };
                    };
                }];
            };
            readonly WebhookMessageCrypto: {
                readonly type: "object";
                readonly description: "Contexto criptografico compacto opcional da mensagem.";
                readonly properties: {
                    readonly senderKeyHash: {
                        readonly type: "string";
                    };
                    readonly recipientKeyHash: {
                        readonly type: "string";
                    };
                    readonly messageSecret: {
                        readonly type: "string";
                    };
                };
            };
            readonly WebhookMessageMedia: {
                readonly type: "object";
                readonly description: "Representacao de midia no payload de webhook/evento de instancia.";
                readonly properties: {
                    readonly kind: {
                        readonly type: "string";
                        readonly enum: readonly ["audio", "image", "video", "sticker", "document"];
                    };
                    readonly mimeType: {
                        readonly type: "string";
                    };
                    readonly fileName: {
                        readonly type: "string";
                    };
                    readonly caption: {
                        readonly type: "string";
                    };
                    readonly mediaId: {
                        readonly type: "string";
                    };
                    readonly url: {
                        readonly type: "string";
                        readonly format: "uri";
                    };
                    readonly base64: {
                        readonly type: "string";
                        readonly description: "Opcional; recomendado manter desabilitado em producao.";
                    };
                    readonly bytes: {
                        readonly type: "integer";
                        readonly minimum: 0;
                    };
                    readonly omittedReason: {
                        readonly type: "string";
                        readonly enum: readonly ["too_large", "download_failed"];
                    };
                };
            };
            readonly WebhookMessageUpsertItem: {
                readonly type: "object";
                readonly properties: {
                    readonly key: {
                        readonly type: "object";
                        readonly properties: {
                            readonly remoteJid: {
                                readonly type: "string";
                            };
                            readonly fromMe: {
                                readonly type: "boolean";
                            };
                            readonly id: {
                                readonly type: "string";
                            };
                            readonly participant: {
                                readonly type: "string";
                            };
                        };
                        readonly additionalProperties: true;
                    };
                    readonly messageTimestamp: {
                        readonly type: "integer";
                    };
                    readonly pushName: {
                        readonly type: "string";
                    };
                    readonly text: {
                        readonly type: "string";
                    };
                    readonly message_type: {
                        readonly type: "string";
                        readonly example: "audio";
                    };
                    readonly messageType: {
                        readonly type: "string";
                        readonly example: "audio";
                    };
                    readonly sender: {
                        readonly type: "object";
                        readonly properties: {
                            readonly name: {
                                readonly type: "string";
                            };
                            readonly number: {
                                readonly type: "string";
                            };
                        };
                    };
                    readonly media: {
                        readonly $ref: "#/components/schemas/WebhookMessageMedia";
                    };
                    readonly crypto: {
                        readonly $ref: "#/components/schemas/WebhookMessageCrypto";
                    };
                    readonly message: {
                        readonly type: "object";
                        readonly description: "Mensagem raw sanitizada (sem waveform e hashes binarios).";
                        readonly additionalProperties: true;
                    };
                };
            };
            readonly WebhookMessagesUpsertPayload: {
                readonly type: "object";
                readonly description: "Payload padrao emitido em MESSAGES_UPSERT / messages.upsert.";
                readonly properties: {
                    readonly type: {
                        readonly type: "string";
                        readonly example: "notify";
                    };
                    readonly messages: {
                        readonly type: "array";
                        readonly items: {
                            readonly $ref: "#/components/schemas/WebhookMessageUpsertItem";
                        };
                    };
                };
            };
        };
    };
};
//# sourceMappingURL=openapi.d.ts.map