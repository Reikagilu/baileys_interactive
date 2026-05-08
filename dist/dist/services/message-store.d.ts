/**
 * message-store.ts
 *
 * Persistência SQLite para mensagens e metadados de chats.
 * Cada instância usa o mesmo banco (particionado pela coluna `instance`).
 *
 * Tabelas:
 *   chat_meta   — metadados de cada chat (jid, título, lastTimestamp, unreadCount)
 *   messages    — mensagens (instance, jid, id, fromMe, text, timestamp, senderName,
 *                 senderNumber, mediaJson, contactJson)
 */
export interface StoredMessage {
    id: string;
    fromMe: boolean;
    text: string;
    timestamp: number;
    senderName?: string;
    senderNumber?: string;
    media?: Record<string, unknown>;
    contact?: Record<string, unknown>;
}
export interface StoredChatMeta {
    jid: string;
    title: string;
    lastMessage: string;
    lastTimestamp: number;
    unreadCount: number;
    messageCount: number;
}
/**
 * Insere ou ignora uma mensagem (ON CONFLICT IGNORE — não substitui existente).
 * Retorna true se foi inserida, false se já existia.
 */
export declare function upsertMessage(instance: string, jid: string, msg: StoredMessage): boolean;
/**
 * Atualiza metadados do chat.
 */
export declare function upsertChatMeta(instance: string, jid: string, patch: Partial<{
    title: string;
    lastMessage: string;
    lastTimestamp: number;
    unreadCount: number;
}>): void;
export declare function incrementUnread(instance: string, jid: string): void;
export declare function resetUnread(instance: string, jid: string): void;
/**
 * Retorna todos os chats da instância, ordenados por last_ts DESC.
 */
export declare function listChats(instance: string): StoredChatMeta[];
/**
 * Retorna as mensagens de um chat, ordenadas por ts ASC.
 * limit padrão: 500 mensagens mais recentes.
 */
export declare function listMessages(instance: string, jid: string, limit?: number): StoredMessage[];
/**
 * Retorna o timestamp da mensagem mais antiga armazenada para um chat.
 * Útil para decidir se é necessário buscar mais histórico.
 */
export declare function getOldestMessageTs(instance: string, jid: string): number;
/**
 * Conta mensagens de um chat.
 */
export declare function countMessages(instance: string, jid: string): number;
/**
 * Remove todos os dados de uma instância (ao fazer logout/delete).
 */
export declare function clearInstance(instance: string): void;
//# sourceMappingURL=message-store.d.ts.map