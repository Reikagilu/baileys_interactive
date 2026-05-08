import type { InstanceContext } from '../types/whatsapp.js';
declare const MEDIA_NODE_BY_KIND: {
    readonly audio: {
        readonly field: "audioMessage";
        readonly downloadType: "audio";
    };
    readonly image: {
        readonly field: "imageMessage";
        readonly downloadType: "image";
    };
    readonly video: {
        readonly field: "videoMessage";
        readonly downloadType: "video";
    };
    readonly sticker: {
        readonly field: "stickerMessage";
        readonly downloadType: "sticker";
    };
    readonly document: {
        readonly field: "documentMessage";
        readonly downloadType: "document";
    };
};
type MediaKind = keyof typeof MEDIA_NODE_BY_KIND;
interface CachedMedia {
    kind: MediaKind;
    mimeType?: string;
    fileName?: string;
    caption?: string;
    base64?: string;
    url?: string;
    bytes?: number;
    mediaId?: string;
    omittedReason?: 'too_large' | 'download_failed';
}
interface CachedContact {
    displayName?: string;
    number?: string;
}
interface CachedMessage {
    id: string;
    fromMe: boolean;
    text: string;
    timestamp: number;
    senderName?: string;
    senderNumber?: string;
    media?: CachedMedia;
    contact?: CachedContact;
}
export declare function applyInstanceRuntimeSettings(name: string): {
    ok: boolean;
    applied: string[];
    requiresReconnect: string[];
};
/**
 * Retorna o contexto da instância pelo nome, ou undefined se não existir.
 */
export declare function getInstance(name: string): InstanceContext | undefined;
/**
 * Retorna todas as instâncias.
 */
export declare function getAllInstances(): InstanceContext[];
export declare function reconnectPreviouslyActiveInstances(authFolder: string): Promise<{
    attempted: number;
    started: number;
    failed: string[];
}>;
/**
 * Cria e inicia uma nova instância WhatsApp (InfiniteAPI/Baileys).
 * Gera QR code até o usuário escanear e conectar.
 * Em 515 (restartRequired) recria o socket automaticamente após 2s.
 */
export declare function createInstance(name: string, authFolder: string): Promise<{
    ok: boolean;
    instance: string;
    qr?: string;
    error?: string;
}>;
export declare function normalizePairingPhoneNumber(rawPhone: string, defaultCountryCode: string): string;
export declare function requestInstancePairingCode(name: string, phoneNumber: string): Promise<{
    ok: boolean;
    pairingCode?: string;
    error?: string;
    status?: string;
}>;
/**
 * Desconecta e remove a instância da memória (credenciais permanecem em disco).
 */
export declare function disconnectInstance(name: string, options?: {
    keepAutostart?: boolean;
}): boolean;
/**
 * Logout + apaga pasta de auth e remove instância. Próxima conexão gerará novo QR.
 */
export declare function logoutInstance(name: string, authFolder: string): Promise<{
    ok: boolean;
    error?: string;
}>;
/**
 * Remove a instância (fecha socket e remove do mapa). Não apaga credenciais.
 */
export declare function removeInstance(name: string): boolean;
export declare function getInstanceChatList(name: string): Array<{
    jid: string;
    title: string;
    unreadCount: number;
    messageCount: number;
    lastMessage: string;
    lastTimestamp: number;
}>;
export declare function getInstanceChatMessages(name: string, jid: string): CachedMessage[];
export declare function getInstanceChatMessagesWithMedia(name: string, jid: string): Promise<CachedMessage[]>;
export declare function getInstanceChatMediaBinary(name: string, mediaId: string): {
    ok: boolean;
    mimeType?: string;
    bytes?: Buffer;
    error?: 'not_found';
};
export declare function syncInstanceChatHistory(name: string, jid: string, options?: {
    maxBatches?: number;
    fetchCount?: number;
}): Promise<{
    ok: boolean;
    imported: number;
    batches: number;
    done: boolean;
    error?: string;
}>;
export declare function markInstanceChatAsRead(name: string, jid: string): void;
export declare function applyReadSettingsToCachedMessages(name: string): Promise<{
    ok: boolean;
    count: number;
}>;
/**
 * Send a plain-text message via an active WhatsApp instance.
 * Used by the Chatwoot webhook handler to reply from Chatwoot to WhatsApp.
 */
export declare function sendInstanceTextMessage(name: string, jid: string, text: string): Promise<{
    ok: boolean;
    id?: string;
    error?: string;
}>;
/**
 * Send a URL-based media message via an active WhatsApp instance.
 * Used when Chatwoot sends an attachment back to WhatsApp.
 */
export declare function sendInstanceMediaMessage(name: string, jid: string, params: {
    mediaUrl: string;
    mimeType?: string;
    fileName?: string;
    caption?: string;
}): Promise<{
    ok: boolean;
    id?: string;
    error?: string;
}>;
export {};
//# sourceMappingURL=whatsapp.d.ts.map