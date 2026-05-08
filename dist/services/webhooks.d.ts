export type WebhookEventName = 'connection.update' | 'messages.upsert' | 'messages.update' | 'message-receipt.update' | 'chats.update' | 'groups.update';
export interface WebhookConfig {
    id: string;
    name: string;
    url: string;
    events: WebhookEventName[];
    instance?: string;
    enabled: boolean;
    secret?: string;
    createdAt: number;
    updatedAt: number;
}
export interface WebhookDelivery {
    id: string;
    webhookId: string;
    webhookName: string;
    webhookUrl: string;
    event: WebhookEventName;
    instance?: string;
    status: 'pending' | 'processing' | 'delivered' | 'failed';
    attemptCount: number;
    maxAttempts: number;
    nextAttemptAt: number;
    lastAttemptAt?: number;
    deliveredAt?: number;
    lastError?: string;
    responseStatus?: number;
    lockOwner?: string;
    lockExpiresAt?: number;
    payload: unknown;
    createdAt: number;
    updatedAt: number;
}
export declare function normalizeWebhookEvents(events: unknown): WebhookEventName[];
export declare function createWebhook(input: {
    name: string;
    url: string;
    events: unknown;
    instance?: string;
    enabled?: boolean;
    secret?: string;
}): WebhookConfig;
export declare function listWebhooks(): WebhookConfig[];
export declare function getWebhook(id: string): WebhookConfig | null;
export declare function updateWebhook(id: string, update: Partial<Pick<WebhookConfig, 'name' | 'url' | 'instance' | 'enabled' | 'secret'>> & {
    events?: unknown;
}): WebhookConfig | null;
export declare function deleteWebhook(id: string): boolean;
export declare function listSupportedWebhookEvents(): WebhookEventName[];
export declare function emitWebhookEvent(event: WebhookEventName, payload: unknown, instance?: string): {
    queued: number;
};
export declare function enqueueWebhookTestDelivery(webhookId: string, event: WebhookEventName, payload: unknown): {
    queued: number;
    reason?: 'webhook_not_found' | 'webhook_disabled';
};
export declare function listWebhookDeliveries(filters?: {
    webhookId?: string;
    status?: 'pending' | 'processing' | 'delivered' | 'failed';
    limit?: number;
}): WebhookDelivery[];
export declare function listDeadLetterDeliveries(limit?: number): WebhookDelivery[];
export declare function purgeDeadLetterDeliveries(olderThanMs: number): number;
export declare function getWebhookDelivery(id: string): WebhookDelivery | null;
export declare function retryWebhookDelivery(id: string): WebhookDelivery | null;
export declare function claimDueDeliveries(batchSize: number, workerId: string, lockMs: number): WebhookDelivery[];
export declare function markDeliveryAttemptStart(id: string, attemptCount: number): void;
export declare function markDeliverySuccess(id: string, responseStatus: number): void;
export declare function markDeliveryRetry(id: string, lastError: string, responseStatus: number | null, attemptCount: number): void;
export declare function markDeliveryFailed(id: string, lastError: string, responseStatus: number | null): void;
export declare function getWebhookMetrics(): {
    webhooksTotal: number;
    webhooksEnabled: number;
    deliveriesPending: number;
    deliveriesProcessing: number;
    deliveriesDelivered: number;
    deliveriesFailed: number;
    deliveriesTotal: number;
    oldestPendingAgeSeconds: number;
};
export declare function loadWebhookForDelivery(id: string): WebhookConfig | null;
export declare function buildWebhookHeaders(delivery: WebhookDelivery, secret: string, payloadBody: string): Record<string, string>;
export declare function getWebhookDefaultSecret(): string;
