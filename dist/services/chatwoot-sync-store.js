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
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
// ─── DB ──────────────────────────────────────────────────────────────────────
let _db = null;
function getDb() {
    if (_db)
        return _db;
    const resolved = path.resolve(process.cwd(), config.messages.dbPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(resolved);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`
    CREATE TABLE IF NOT EXISTS chatwoot_synced (
      instance        TEXT NOT NULL,
      msg_id          TEXT NOT NULL,
      conversation_id INTEGER NOT NULL DEFAULT 0,
      synced_at       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (instance, msg_id)
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chatwoot_synced_instance
      ON chatwoot_synced (instance, synced_at)
  `);
    _db = db;
    return db;
}
// ─── Tracking persistido ─────────────────────────────────────────────────────
/** Verifica se uma mensagem já foi sincronizada para o Chatwoot. */
export function isMessageSynced(instance, msgId) {
    if (!instance || !msgId)
        return false;
    const db = getDb();
    const row = db.prepare('SELECT 1 AS x FROM chatwoot_synced WHERE instance = ? AND msg_id = ?').get(instance, msgId);
    return !!row;
}
/** Marca mensagem como sincronizada (idempotente). */
export function markMessageSynced(instance, msgId, conversationId) {
    if (!instance || !msgId)
        return;
    const db = getDb();
    db.prepare(`
    INSERT OR REPLACE INTO chatwoot_synced (instance, msg_id, conversation_id, synced_at)
    VALUES (?, ?, ?, ?)
  `).run(instance, msgId, conversationId | 0, Date.now());
}
/** Conta mensagens sincronizadas para uma instância. */
export function countSyncedMessages(instance) {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS c FROM chatwoot_synced WHERE instance = ?').get(instance);
    return row?.c ?? 0;
}
/** Limpa tracking de uma instância (usado em logout). */
export function clearInstanceSyncTracking(instance) {
    const db = getDb();
    db.prepare('DELETE FROM chatwoot_synced WHERE instance = ?').run(instance);
}
const _progress = new Map();
const _cancelFlags = new Map();
function defaultProgress() {
    return {
        status: 'idle',
        startedAt: null,
        finishedAt: null,
        totalChats: 0,
        processedChats: 0,
        totalMessages: 0,
        syncedMessages: 0,
        skippedMessages: 0,
        errorCount: 0,
        currentChatJid: null,
        currentChatTitle: null,
        trigger: null,
        daysLimit: null,
        lastError: null,
        lastSyncedAt: null,
        lastSyncCount: null,
    };
}
export function getSyncProgress(instance) {
    return _progress.get(instance) ?? defaultProgress();
}
export function startSyncProgress(instance, trigger, daysLimit) {
    // Preserva último sync info
    const prev = _progress.get(instance);
    const fresh = {
        ...defaultProgress(),
        status: 'running',
        startedAt: Date.now(),
        trigger,
        daysLimit,
        lastSyncedAt: prev?.lastSyncedAt ?? null,
        lastSyncCount: prev?.lastSyncCount ?? null,
    };
    _progress.set(instance, fresh);
    _cancelFlags.set(instance, false);
    return fresh;
}
export function updateSyncProgress(instance, patch) {
    const cur = _progress.get(instance) ?? defaultProgress();
    const next = { ...cur, ...patch };
    _progress.set(instance, next);
    return next;
}
export function finishSyncProgress(instance, status, error) {
    const cur = _progress.get(instance) ?? defaultProgress();
    const next = {
        ...cur,
        status,
        finishedAt: Date.now(),
        lastError: error ?? cur.lastError,
        lastSyncedAt: Date.now(),
        lastSyncCount: cur.syncedMessages,
        currentChatJid: null,
        currentChatTitle: null,
    };
    _progress.set(instance, next);
    _cancelFlags.set(instance, false);
    return next;
}
export function requestSyncCancel(instance) {
    const cur = _progress.get(instance);
    if (!cur || cur.status !== 'running')
        return false;
    _cancelFlags.set(instance, true);
    _progress.set(instance, { ...cur, status: 'cancelling' });
    return true;
}
export function isSyncCancelled(instance) {
    return _cancelFlags.get(instance) === true;
}
export function isSyncRunning(instance) {
    const cur = _progress.get(instance);
    return cur?.status === 'running' || cur?.status === 'cancelling';
}
//# sourceMappingURL=chatwoot-sync-store.js.map