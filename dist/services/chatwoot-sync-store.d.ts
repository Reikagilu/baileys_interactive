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
/** Verifica se uma mensagem já foi sincronizada para o Chatwoot. */
export declare function isMessageSynced(instance: string, msgId: string): boolean;
/** Marca mensagem como sincronizada (idempotente). */
export declare function markMessageSynced(instance: string, msgId: string, conversationId: number): void;
/** Conta mensagens sincronizadas para uma instância. */
export declare function countSyncedMessages(instance: string): number;
/** Limpa tracking de uma instância (usado em logout). */
export declare function clearInstanceSyncTracking(instance: string): void;
export type SyncStatus = 'idle' | 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
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
}
export declare function getSyncProgress(instance: string): SyncProgress;
export declare function startSyncProgress(instance: string, trigger: 'manual' | 'connect', daysLimit: number): SyncProgress;
export declare function updateSyncProgress(instance: string, patch: Partial<SyncProgress>): SyncProgress;
export declare function finishSyncProgress(instance: string, status: 'completed' | 'failed' | 'cancelled', error?: string): SyncProgress;
export declare function requestSyncCancel(instance: string): boolean;
export declare function isSyncCancelled(instance: string): boolean;
export declare function isSyncRunning(instance: string): boolean;
