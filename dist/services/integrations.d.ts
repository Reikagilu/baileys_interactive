export interface ChatwootConfig {
    enabled: boolean;
    baseUrl: string;
    accountId: string;
    inboxId: string;
    apiAccessToken: string;
    nameInbox: string;
    webhookSlug: string;
    signMessages: boolean;
    signDelimiter: string;
    organization: string;
    logoUrl: string;
    conversationPending: boolean;
    reopenConversation: boolean;
    importContacts: boolean;
    importMessages: boolean;
    daysLimitImportMessages: number;
    ignoreJids: string[];
    autoCreate: boolean;
}
export interface N8nConfig {
    enabled: boolean;
    webhookUrl: string;
    authHeaderName: string;
    authHeaderValue: string;
}
export interface InstanceIntegrations {
    instance: string;
    chatwoot: ChatwootConfig;
    n8n: N8nConfig;
    createdAt: number;
    updatedAt: number;
}
export declare function getInstanceIntegrations(instance: string): InstanceIntegrations;
/**
 * Find the instance name that has a given webhookSlug configured.
 * Returns null if not found.
 */
export declare function findInstanceByWebhookSlug(slug: string): string | null;
export declare function listIntegrationInstances(): InstanceIntegrations[];
export declare function updateChatwootConfig(instance: string, patch: Partial<ChatwootConfig>): InstanceIntegrations;
export declare function updateN8nConfig(instance: string, patch: Partial<N8nConfig>): InstanceIntegrations;
export declare function testChatwoot(instance: string): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
}>;
export declare function testN8n(instance: string): Promise<{
    ok: boolean;
    status?: number;
    error?: string;
}>;
