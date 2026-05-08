export declare const config: {
    readonly port: number;
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
        readonly allowPrivateNetworkWebhooks: boolean;
        readonly allowPrivateNetworkIntegrations: boolean;
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
