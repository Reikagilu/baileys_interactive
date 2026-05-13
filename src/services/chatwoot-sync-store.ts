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
  db.exec('PRAGMA busy_timeout = 5000');
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
  // Tabela para rastrear mensagens originadas pelo Chatwoot (Chatwoot → WhatsApp).
  // Usada para deduplicar quando a mensagem chega de volta via messages.upsert.
  // Não é particionada por instance porque o msgId Baileys já é globalmente único
  // dentro da nossa frota e o consumo é por id direto.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chatwoot_originated (
      msg_id     TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chatwoot_originated_created
      ON chatwoot_originated (created_at)
  `);
  _db = db;
  return db;
}

// ─── Tracking persistido de mensagens originadas pelo Chatwoot ──────────────

/** TTL de persistência: ~7 dias. Suficiente para qualquer atraso de entrega. */
const CHATWOOT_ORIGINATED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let _lastOriginatedPrune = 0;

export function persistChatwootOriginated(msgId: string): void {
  if (!msgId) return;
  const db = getDb();
  const now = Date.now();
  db.prepare(
    'INSERT OR REPLACE INTO chatwoot_originated (msg_id, created_at) VALUES (?, ?)'
  ).run(msgId, now);
  // Prune amortizado: a cada ~1h, remove entradas expiradas.
  if (now - _lastOriginatedPrune > 60 * 60 * 1000) {
    _lastOriginatedPrune = now;
    try {
      db.prepare('DELETE FROM chatwoot_originated WHERE created_at < ?')
        .run(now - CHATWOOT_ORIGINATED_TTL_MS);
    } catch {
      /* ignore */
    }
  }
}

export function isChatwootOriginatedPersisted(msgId: string): boolean {
  if (!msgId) return false;
  const db = getDb();
  const row = db.prepare(
    'SELECT created_at AS c FROM chatwoot_originated WHERE msg_id = ?'
  ).get(msgId) as { c: number } | undefined;
  if (!row) return false;
  if (Date.now() - row.c > CHATWOOT_ORIGINATED_TTL_MS) {
    try { db.prepare('DELETE FROM chatwoot_originated WHERE msg_id = ?').run(msgId); } catch { /* ignore */ }
    return false;
  }
  return true;
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

const MAX_TRACKED_ERRORS = 200;

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
    errors: [],
  };
}

/**
 * Anexa um erro detalhado à lista de erros do progresso atual e incrementa
 * `errorCount`. Mantém apenas os MAX_TRACKED_ERRORS mais recentes.
 */
export function appendSyncError(instance: string, entry: Omit<SyncErrorEntry, 'at'> & { at?: number }): void {
  if (!instance) return;
  const cur = _progress.get(instance) ?? defaultProgress();
  const full: SyncErrorEntry = {
    at: entry.at ?? Date.now(),
    jid: entry.jid ?? null,
    chatTitle: entry.chatTitle ?? null,
    msgId: entry.msgId ?? null,
    error: entry.error,
    scope: entry.scope,
  };
  const errors = cur.errors ? [...cur.errors, full] : [full];
  // Mantém só os mais recentes — trim do início.
  if (errors.length > MAX_TRACKED_ERRORS) errors.splice(0, errors.length - MAX_TRACKED_ERRORS);
  _progress.set(instance, {
    ...cur,
    errors,
    errorCount: (cur.errorCount ?? 0) + 1,
    lastError: full.error,
  });
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
