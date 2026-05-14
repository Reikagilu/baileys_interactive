export declare const config: {
    readonly port: number;
    /** URL pública deste servidor (usada para gerar URLs de webhook e mídia). */
    readonly serverUrl: string;
    readonly apiKey: string;
    readonly apiKeysJson: string;
    readonly authFolder: string;
    readonly audit: {
        readonly logPath: string;
        readonly maxInMemoryEvents: number;
    };
    readonly alerts: {
        readonly maxPendingDeliveries: number;
        readonly maxFailedDeliveries: number;
        readonly maxOldestPendingAgeSeconds: number;
        readonly minConnectedInstances: number;
    };
    readonly logging: {
        readonly requestLogsEnabled: boolean;
    };
    readonly security: {
        readonly trustProxy: boolean;
        readonly hstsEnabled: boolean;
        readonly hstsMaxAgeSeconds: number;
        readonly allowPrivateNetworkWebhooks: boolean;
        readonly allowPrivateNetworkIntegrations: boolean;
        readonly chatwootWebhookSecret: string;
        readonly apiRateLimitWindowMs: number;
        readonly apiRateLimitMax: number;
        readonly webhookRateLimitWindowMs: number;
        readonly webhookRateLimitMax: number;
        readonly publicDocsEnabled: boolean;
        readonly publicMetricsEnabled: boolean;
        readonly publicReadyEnabled: boolean;
    };
    readonly pairing: {
        readonly enabled: boolean;
        readonly defaultCountryCode: string;
        readonly forceFreshSession: boolean;
    };
    readonly integrations: {
        readonly dbPath: string;
        readonly requestTimeoutMs: number;
    };
    readonly messages: {
        readonly dbPath: string;
        readonly maxPerChat: number;
        readonly historyTtlDays: number;
        readonly cleanupIntervalMs: number;
    };
    readonly webhooks: {
        readonly dbPath: string;
        readonly maxAttempts: number;
        readonly retryBaseDelayMs: number;
        readonly retryMaxDelayMs: number;
        readonly requestTimeoutMs: number;
        readonly maxDeliveryHistory: number;
        readonly defaultSecret: string;
        readonly workerPollMs: number;
        readonly workerBatchSize: number;
        readonly workerLockMs: number;
        readonly embeddedWorkerEnabled: boolean;
        readonly dlqRetentionMs: number;
        readonly purgeIntervalMs: number;
        readonly includeIncomingMediaBase64: boolean;
        readonly includeIncomingVideoBase64: boolean;
        readonly incomingMediaBase64MaxBytes: number;
        readonly incomingVideoBase64MaxBytes: number;
    };
    readonly idempotency: {
        readonly enabled: boolean;
        readonly ttlMs: number;
        readonly maxEntries: number;
    };
    readonly media: {
        readonly signedUrlSecret: string;
        readonly signedUrlTtlSeconds: number;
    };
    readonly chatwoot: {
        /**
         * Limite máximo de bytes para baixar uma mídia recebida do WhatsApp
         * e encaminhá-la ao Chatwoot. Default 25MB cobre vídeos e áudios
         * típicos do WhatsApp. Mídias acima desse limite são puladas e o
         * Chatwoot recebe apenas o texto/legenda (se houver).
         */
        readonly mediaMaxBytes: number;
        /** Timeout HTTP para requests ao Chatwoot (uploads podem demorar). */
        readonly requestTimeoutMs: number;
        /** Retries para falhas transitórias como timeout/429/5xx. */
        readonly requestRetries: number;
        /** Pausa entre retries ao Chatwoot. */
        readonly requestRetryDelayMs: number;
        /** Atraso entre mensagens durante sync de histórico (anti-overload). */
        readonly syncMessageDelayMs: number;
        /** A cada N mensagens o sync faz uma pausa maior para aliviar I/O. */
        readonly syncBatchSize: number;
        /** Duração da pausa entre batches. */
        readonly syncBatchPauseMs: number;
    };
    readonly limits: {
        readonly maxButtons: 3;
        readonly maxCarouselCards: 10;
        readonly maxListSections: 10;
        readonly maxListRowsPerSection: 10;
        readonly maxPollOptions: 12;
        readonly chatInlineMediaMaxBytes: number;
        readonly chatVideoMaxBytes: number;
        readonly chatMediaRetentionMs: number;
    };
};
export type Config = typeof config;
