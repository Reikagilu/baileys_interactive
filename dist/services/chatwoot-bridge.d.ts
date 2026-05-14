/**
 * Chatwoot Bridge Service
 *
 * Handles bidirectional integration between WhatsApp (Baileys) and Chatwoot.
 *
 * WhatsApp → Chatwoot:
 *   1. Find or create contact in Chatwoot
 *   2. Find or create conversation (inbox + contact)
 *   3. Send message with source_id = WhatsApp message ID (deduplication)
 *
 * Chatwoot → WhatsApp:
 *   POST /v1/integrations/:instance/chatwoot/webhook receives Chatwoot events
 *   and dispatches messages to WhatsApp via sendMessage
 */
export declare const CHATWOOT_WEBHOOK_SLUG_PATTERN: RegExp;
export declare function normalizeChatwootWebhookSlug(input: unknown): string;
export declare function buildChatwootWebhookUrl(slugRaw: string): string;
interface NormalizedMessage {
    key: {
        id: string;
        remoteJid: string;
        fromMe: boolean;
        participant?: string;
    };
    pushName?: string;
    message_type?: string;
    messageType?: string;
    text?: string;
    quotedMessageId?: string;
    message?: Record<string, unknown>;
    timestamp?: number;
    media?: {
        kind: string;
        mimeType?: string;
        fileName?: string;
        caption?: string;
        base64?: string;
        url?: string;
    };
    sender?: {
        name?: string;
        number?: string;
    };
}
/**
 * Called for every messages.upsert event (normalized messages list).
 * Dispatches each message to Chatwoot if integration is enabled.
 */
export declare function dispatchToChatwoot(instanceName: string, messages: NormalizedMessage[]): Promise<void>;
export interface ChatwootWebhookPayload {
    event: string;
    id?: string | number;
    message_type?: string;
    private?: boolean;
    content?: string;
    source_id?: string | null;
    content_attributes?: Record<string, unknown>;
    conversation?: {
        id: number;
        meta?: {
            sender?: {
                identifier?: string;
                phone_number?: string;
            };
        };
        inbox_id?: number;
        messages?: Array<{
            id?: string | number;
            source_id?: string | null;
        }>;
    };
    sender?: {
        type?: string;
        name?: string;
        available_name?: string;
        display_name?: string;
        full_name?: string;
    };
    attachments?: Array<{
        file_type?: string;
        data_url?: string;
        download_url?: string;
        external_url?: string;
        file_url?: string;
        url?: string;
        file_name?: string;
    }>;
}
interface ParsedChatwootAttachment {
    mediaUrl: string;
    mimeType?: string;
    fileName?: string;
}
/**
 * Process a Chatwoot webhook event.
 * Returns the JID to send to and the text, or null if not actionable.
 */
export declare function parseChatwootWebhook(payload: ChatwootWebhookPayload): {
    jid: string;
    text: string;
    attachments?: ParsedChatwootAttachment[];
    replyToId?: string;
    agentName?: string;
} | null;
export declare function syncContactNamesToChatwoot(instanceName: string): Promise<{
    ok: boolean;
    scanned: number;
    updated: number;
    skipped: number;
    errors: number;
    error?: string;
}>;
/**
 * Called when a WhatsApp instance connects (connection = 'open') and autoCreate = true.
 * Creates an API inbox in Chatwoot with the configured nameInbox, then saves the inboxId back.
 * Also updates webhookSlug to the instanceName if not already set.
 */
export declare function autoCreateChatwootInbox(instanceName: string, linkedNumber?: string | null, force?: boolean): Promise<{
    ok: boolean;
    inboxId?: number;
    inboxName?: string;
    webhookUrl?: string;
    note?: string;
    error?: string;
}>;
export declare function invalidateConversationCache(instanceName: string): void;
/**
 * Syncs stored messages from SQLite to Chatwoot.
 * @param instanceName - WhatsApp instance name
 * @param jid - Optional: sync only this JID. If omitted, syncs all chats.
 * @param limitPerChat - Max messages per chat (default 200)
 */
export declare function syncHistoryToChatwoot(instanceName: string, jid?: string, limitPerChat?: number, trigger?: 'manual' | 'connect'): Promise<{
    ok: boolean;
    synced: number;
    errors: number;
    skipped?: number;
    cancelled?: boolean;
    error?: string;
}>;
export {};
