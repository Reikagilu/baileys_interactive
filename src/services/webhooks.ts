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
export function normalizeWebhookEvents(events: unknown): WebhookEventName[] { return undefined as any; }
export function createWebhook(input: {
    name: string;
    url: string;
    events: unknown;
    instance?: string;
    enabled?: boolean;
    secret?: string;
}): WebhookConfig { return undefined as any; }
export function listWebhooks(): WebhookConfig[] { return undefined as any; }
export function getWebhook(id: string): WebhookConfig | null { return undefined as any; }
export function updateWebhook(id: string, update: Partial<Pick<WebhookConfig, 'name' | 'url' | 'instance' | 'enabled' | 'secret'>> & {
    events?: unknown;
}): WebhookConfig | null { return undefined as any; }
export function deleteWebhook(id: string): boolean { return undefined as any; }
export function listSupportedWebhookEvents(): WebhookEventName[] { return undefined as any; }
export function emitWebhookEvent(event: WebhookEventName, payload: unknown, instance?: string): {
    queued: number;
} { return undefined as any; }
export function enqueueWebhookTestDelivery(webhookId: string, event: WebhookEventName, payload: unknown): {
    queued: number;
    reason?: 'webhook_not_found' | 'webhook_disabled';
} { return undefined as any; }
export function listWebhookDeliveries(filters?: {
    webhookId?: string;
    status?: 'pending' | 'processing' | 'delivered' | 'failed';
    limit?: number;
}): WebhookDelivery[] { return undefined as any; }
export function listDeadLetterDeliveries(limit?: number): WebhookDelivery[] { return undefined as any; }
export function purgeDeadLetterDeliveries(olderThanMs: number): number { return undefined as any; }
export function getWebhookDelivery(id: string): WebhookDelivery | null { return undefined as any; }
export function retryWebhookDelivery(id: string): WebhookDelivery | null { return undefined as any; }
export function claimDueDeliveries(batchSize: number, workerId: string, lockMs: number): WebhookDelivery[] { return undefined as any; }
export function markDeliveryAttemptStart(id: string, attemptCount: number): void { return undefined as any; }
export function markDeliverySuccess(id: string, responseStatus: number): void { return undefined as any; }
export function markDeliveryRetry(id: string, lastError: string, responseStatus: number | null, attemptCount: number): void { return undefined as any; }
export function markDeliveryFailed(id: string, lastError: string, responseStatus: number | null): void { return undefined as any; }
export function getWebhookMetrics(): {
    webhooksTotal: number;
    webhooksEnabled: number;
    deliveriesPending: number;
    deliveriesProcessing: number;
    deliveriesDelivered: number;
    deliveriesFailed: number;
    deliveriesTotal: number;
    oldestPendingAgeSeconds: number;
} { return undefined as any; }
export function loadWebhookForDelivery(id: string): WebhookConfig | null { return undefined as any; }
export function buildWebhookHeaders(delivery: WebhookDelivery, secret: string, payloadBody: string): Record<string, string> { return undefined as any; }
export function getWebhookDefaultSecret(): string { return undefined as any; }
