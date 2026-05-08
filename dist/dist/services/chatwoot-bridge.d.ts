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
    message?: Record<string, unknown>;
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
    message_type?: string;
    private?: boolean;
    content?: string;
    conversation?: {
        id: number;
        meta?: {
            sender?: {
                identifier?: string;
                phone_number?: string;
            };
        };
        inbox_id?: number;
    };
    sender?: {
        type?: string;
    };
    attachments?: Array<{
        file_type: string;
        data_url: string;
        file_name?: string;
    }>;
}
/**
 * Process a Chatwoot webhook event.
 * Returns the JID to send to and the text, or null if not actionable.
 */
export declare function parseChatwootWebhook(payload: ChatwootWebhookPayload): {
    jid: string;
    text: string;
    mediaUrl?: string;
    mimeType?: string;
    fileName?: string;
} | null;
export declare function invalidateConversationCache(instanceName: string): void;
export {};
//# sourceMappingURL=chatwoot-bridge.d.ts.map