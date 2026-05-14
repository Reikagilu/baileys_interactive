/**
 * chatwoot-sync-store.ts
 *
 * Persistência de tracking de mensagens já sincronizadas com o Chatwoot
 * (deduplicação real — evita reenviar mensagens em syncs subsequentes).
 *
 * Também mantém o estado de progresso de syncs em curso (em memória, por instance).
 *
 * Tabela:
 *   chatwoot_synced (instance, msg_id, conversation_id, synced_at)
 */
export declare function persistChatwootOriginated(msgId: string): void;
export declare function isChatwootOriginatedPersisted(msgId: string): boolean;
/** Verifica se uma mensagem já foi sincronizada para o Chatwoot. */
export declare function isMessageSynced(instance: string, msgId: string): boolean;
/**
 * Retorna apenas os msgIds que ainda NAO foram sincronizados.
 * Faz a verificação em lote para reduzir round-trips SQLite durante syncs grandes.
 */
export declare function getUnsyncedMessageIds(instance: string, msgIds: readonly string[]): Set<string>;
/** Marca mensagem como sincronizada (idempotente). */
export declare function markMessageSynced(instance: string, msgId: string, conversationId: number): void;
export declare function beginMessageSync(instance: string, msgId: string, skipPersistedCheck?: boolean): boolean;
export declare function finishMessageSync(instance: string, msgId: string): void;
/** Conta mensagens sincronizadas para uma instância. */
export declare function countSyncedMessages(instance: string): number;
/** Limpa tracking de uma instância (usado em logout). */
export declare function clearInstanceSyncTracking(instance: string): void;
export type SyncStatus = 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export interface SyncErrorEntry {
    /** Timestamp em ms quando o erro foi registrado. */
    at: number;
    /** JID do chat em que ocorreu (quando aplicável). */
    jid: string | null;
    /** Título do chat (cache para exibir na UI sem precisar olhar contatos). */
    chatTitle: string | null;
    /** ID da mensagem que falhou (Baileys), quando aplicável. */
    msgId: string | null;
    /** Mensagem de erro humana. */
    error: string;
    /** Contexto adicional (ex: "dispatch", "media-download", "history"). */
    scope?: string;
}
export interface SyncProgress {
    status: SyncStatus;
    startedAt: number | null;
    finishedAt: number | null;
    totalChats: number;
    processedChats: number;
    totalMessages: number;
    syncedMessages: number;
    skippedMessages: number;
    errorCount: number;
    currentChatJid: string | null;
    currentChatTitle: string | null;
    trigger: 'manual' | 'connect' | null;
    daysLimit: number | null;
    lastError: string | null;
    lastSyncedAt: number | null;
    lastSyncCount: number | null;
    /** Últimos N erros detalhados (para popup da UI). Limitado para evitar bloat de memória. */
    errors: SyncErrorEntry[];
}
/**
 * Anexa um erro detalhado à lista de erros do progresso atual e incrementa
 * `errorCount`. Mantém apenas os MAX_TRACKED_ERRORS mais recentes.
 */
export declare function appendSyncError(instance: string, entry: Omit<SyncErrorEntry, 'at'> & {
    at?: number;
}): void;
export declare function getSyncProgress(instance: string): SyncProgress;
export declare function startSyncProgress(instance: string, trigger: 'manual' | 'connect', daysLimit: number): SyncProgress;
export declare function updateSyncProgress(instance: string, patch: Partial<SyncProgress>): SyncProgress;
export declare function finishSyncProgress(instance: string, status: 'completed' | 'failed' | 'cancelled', error?: string): SyncProgress;
export declare function requestSyncCancel(instance: string): boolean;
export declare function isSyncCancelled(instance: string): boolean;
export declare function isSyncRunning(instance: string): boolean;
export declare function beginMessageSyncWithPersistence(instance: string, msgId: string, skipPersistedCheck?: boolean): boolean;
export declare function finishMessageSyncWithPersistence(instance: string, msgId: string): void;
export declare function markMessageSyncedWithPersistence(instance: string, msgId: string, conversationId: number): void;
/** Adiciona mensagem à fila de retry. Chamado quando o envio ao Chatwoot falha. */
export declare function addPendingMessage(instance: string, msgId: string, payload: string, error?: string): void;
/** Retorna mensagens prontas para retry (próximo_attempt <= agora). */
type PendingMsg = {
    id: number;
    instance: string;
    msgId: string;
    payload: string;
    attempt: number;
    lastError: string | null;
};
export declare function getPendingMessages(limit?: number): PendingMsg[];
/** Remove mensagem da fila de retry após sucesso. */
export declare function removePendingMessage(id: number): void;
/** Incrementa tentativa de retry com backoff exponencial. */
export declare function updatePendingMessageRetry(id: number, attempt: number, error: string): void;
/** Remove mensagens pendentes antigas (após muitas tentativas ou muito tempo). */
export declare function prunePendingMessages(): number;
/** Retorna count de mensagens pendentes. */
export declare function countPendingMessages(instance?: string): number;
export {};
