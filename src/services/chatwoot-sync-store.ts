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

let _db: DatabaseSync | null = null;
const _messageSyncInFlight = new Set<string>();

function getDb(): DatabaseSync {
  if (_db) return _db;

  const resolved = path.resolve(process.cwd(), config.messages.dbPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

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
export function isMessageSynced(instance: string, msgId: string): boolean {
  if (!instance || !msgId) return false;
  const db = getDb();
  const row = db.prepare(
    'SELECT 1 AS x FROM chatwoot_synced WHERE instance = ? AND msg_id = ?'
  ).get(instance, msgId) as { x: number } | undefined;
  return !!row;
}

/**
 * Retorna apenas os msgIds que ainda NAO foram sincronizados.
 * Faz a verificação em lote para reduzir round-trips SQLite durante syncs grandes.
 */
export function getUnsyncedMessageIds(instance: string, msgIds: readonly string[]): Set<string> {
  if (!instance || msgIds.length === 0) return new Set();
  const db = getDb();
  const pending = new Set(msgIds.filter(Boolean));
  if (pending.size === 0) return new Set();

  const values = Array.from(pending);
  const chunkSize = 400;
  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT msg_id FROM chatwoot_synced WHERE instance = ? AND msg_id IN (${placeholders})`
    ).all(instance, ...chunk) as Array<{ msg_id: string }>;
    for (const row of rows) pending.delete(row.msg_id);
  }

  return pending;
}

/** Marca mensagem como sincronizada (idempotente). */
export function markMessageSynced(instance: string, msgId: string, conversationId: number): void {
  if (!instance || !msgId) return;
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO chatwoot_synced (instance, msg_id, conversation_id, synced_at)
    VALUES (?, ?, ?, ?)
  `).run(instance, msgId, conversationId | 0, Date.now());
}

function messageSyncKey(instance: string, msgId: string): string {
  return `${instance}:${msgId}`;
}

export function beginMessageSync(instance: string, msgId: string, skipPersistedCheck = false): boolean {
  if (!instance || !msgId) return false;
  if (!skipPersistedCheck && isMessageSynced(instance, msgId)) return false;
  const key = messageSyncKey(instance, msgId);
  if (_messageSyncInFlight.has(key)) return false;
  _messageSyncInFlight.add(key);
  return true;
}

export function finishMessageSync(instance: string, msgId: string): void {
  if (!instance || !msgId) return;
  _messageSyncInFlight.delete(messageSyncKey(instance, msgId));
}

/** Conta mensagens sincronizadas para uma instância. */
export function countSyncedMessages(instance: string): number {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM chatwoot_synced WHERE instance = ?'
  ).get(instance) as { c: number } | undefined;
  return row?.c ?? 0;
}

/** Limpa tracking de uma instância (usado em logout). */
export function clearInstanceSyncTracking(instance: string): void {
  const db = getDb();
  db.prepare('DELETE FROM chatwoot_synced WHERE instance = ?').run(instance);
}

// ─── Estado de progresso (em memória) ────────────────────────────────────────

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

const _progress = new Map<string, SyncProgress>();
const _cancelFlags = new Map<string, boolean>();

function defaultProgress(): SyncProgress {
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

export function getSyncProgress(instance: string): SyncProgress {
  return _progress.get(instance) ?? defaultProgress();
}

export function startSyncProgress(
  instance: string,
  trigger: 'manual' | 'connect',
  daysLimit: number,
): SyncProgress {
  // Preserva último sync info
  const prev = _progress.get(instance);
  const fresh: SyncProgress = {
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

export function updateSyncProgress(
  instance: string,
  patch: Partial<SyncProgress>,
): SyncProgress {
  const cur = _progress.get(instance) ?? defaultProgress();
  const next = { ...cur, ...patch };
  _progress.set(instance, next);
  return next;
}

export function finishSyncProgress(
  instance: string,
  status: 'completed' | 'failed' | 'cancelled',
  error?: string,
): SyncProgress {
  const cur = _progress.get(instance) ?? defaultProgress();
  const next: SyncProgress = {
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

export function requestSyncCancel(instance: string): boolean {
  const cur = _progress.get(instance);
  if (!cur || cur.status !== 'running') return false;
  _cancelFlags.set(instance, true);
  _progress.set(instance, { ...cur, status: 'cancelling' });
  return true;
}

export function isSyncCancelled(instance: string): boolean {
  return _cancelFlags.get(instance) === true;
}

export function isSyncRunning(instance: string): boolean {
  const cur = _progress.get(instance);
  return cur?.status === 'running' || cur?.status === 'cancelling';
}
