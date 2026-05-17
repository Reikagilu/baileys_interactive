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
import { log } from '../utils/logger.js';

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
  // ───────────────────────────────────────────────────────────────────────────
  // Tabela de mensagens EM PROCESSO (in-flight) - PERSISTIDA para survives crash
  // tracking de mensagens que estão sendo enviadas ao Chatwoot agora.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chatwoot_inflight (
      instance      TEXT NOT NULL,
      msg_id        TEXT NOT NULL,
      started_at    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (instance, msg_id)
    )
  `);
  // ───────────────────────────────────────────────────────────────────────────
  // Tabela de mensagens PENDENTES (retry) - para mensajes que falharam e precisam
  // ser retentadas. Isso garante ZERO perda de mensagens mesmo em falhas temporárias.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chatwoot_pending (
      id            INTEGER NOT NULL,
      instance      TEXT NOT NULL,
      msg_id        TEXT NOT NULL,
      payload       TEXT NOT NULL,
      attempt       INTEGER NOT NULL DEFAULT 0,
      next_attempt  INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      created_at    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (instance, msg_id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chatwoot_pending_next
      ON chatwoot_pending (next_attempt)
  `);
  // Atribui _db ANTES de carregar in-flight para que a função possa usar o banco
  _db = db;
  // Carrega in-flight do SQLite para memória ao iniciar
  loadInflightFromDb();
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
  // Reutiliza o array existente para evitar alocações intermediárias.
  const errors = cur.errors ? cur.errors.slice() : [];
  errors.push(full);
  // Mantém só os mais recentes — trim do início (in-place).
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

// ─── In-Flight Persistente (sobrevivência a crashes) ────────────────────────

/** Carrega in-flight do SQLite para memória ao iniciar. Garante que mensagens
 * que estavam sendo enviadas quando o processo caiu serão detectadas no restart.
 * Filtra mensagens que já foram marcadas como sincronizadas para evitar que
 * bloqueiem futuras tentativas de envio. */
function loadInflightFromDb(): void {
  if (!_db) return;
  try {
    // Busca apenas in-flight que NÃO já foram sincronizadas.
    // Sem este filtro, mensagens que foram dispatched com sucesso mas cujo
    // finishMessageSyncWithPersistence() não chegou a remover a entrada antes
    // do crash ficariam bloqueando futuros beginMessageSync() para o mesmo ID.
    const rows = _db!.prepare(`
      SELECT i.instance, i.msg_id
      FROM chatwoot_inflight i
      LEFT JOIN chatwoot_synced s ON s.instance = i.instance AND s.msg_id = i.msg_id
      WHERE s.msg_id IS NULL
    `).all() as Array<{ instance: string; msg_id: string }>;

    // Limpa entradas que já estão em chatwoot_synced (foram sincronizadas antes do crash)
    _db!.prepare(`
      DELETE FROM chatwoot_inflight
      WHERE (instance, msg_id) IN (
        SELECT i.instance, i.msg_id
        FROM chatwoot_inflight i
        INNER JOIN chatwoot_synced s ON s.instance = i.instance AND s.msg_id = i.msg_id
      )
    `).run();

    for (const row of rows) {
      const key = messageSyncKey(row.instance, row.msg_id);
      _messageSyncInFlight.add(key);
    }
    if (rows.length > 0) {
      log.chatwoot.info(`In-flight recovery: ${rows.length} mensagem(ns) em voo serão reprocessadas`);
    }
  } catch (err) {
    log.chatwoot.error('Falha ao carregar in-flight do SQLite', err);
  }
}

/** Persiste in-flight no SQLite para survives crash. */
function persistInflight(instance: string, msgId: string): void {
  if (!_db) return;
  try {
    _db!.prepare(
      'INSERT OR REPLACE INTO chatwoot_inflight (instance, msg_id, started_at) VALUES (?, ?, ?)'
    ).run(instance, msgId, Date.now());
  } catch {
    /* ignore - não bloqueia o fluxo */
  }
}

/** Remove do in-flight no SQLite. */
function removeInflight(instance: string, msgId: string): void {
  if (!_db) return;
  try {
    _db!.prepare(
      'DELETE FROM chatwoot_inflight WHERE instance = ? AND msg_id = ?'
    ).run(instance, msgId);
  } catch {
    /* ignore */
  }
}

// Wrapper que persiste in-flight antes de iniciar sync
export function beginMessageSyncWithPersistence(instance: string, msgId: string, skipPersistedCheck = false): boolean {
  if (!instance || !msgId) return false;
  if (!skipPersistedCheck && isMessageSynced(instance, msgId)) return false;
  const key = messageSyncKey(instance, msgId);
  if (_messageSyncInFlight.has(key)) return false;
  _messageSyncInFlight.add(key);
  persistInflight(instance, msgId);
  return true;
}

// Wrapper que remove do in-flight após completar
export function finishMessageSyncWithPersistence(instance: string, msgId: string): void {
  if (!instance || !msgId) return;
  _messageSyncInFlight.delete(messageSyncKey(instance, msgId));
  removeInflight(instance, msgId);
}

// Wrapper que marca como synced E remove do in-flight
export function markMessageSyncedWithPersistence(instance: string, msgId: string, conversationId: number): void {
  if (!instance || !msgId) return;
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO chatwoot_synced (instance, msg_id, conversation_id, synced_at)
    VALUES (?, ?, ?, ?)
  `).run(instance, msgId, conversationId | 0, Date.now());
  removeInflight(instance, msgId);
}

// ─── Fila de Retry (garantia zero perda) ──────────────────────────────────────

/** Backoff exponencial: 2s, 4s, 8s, 16s, 32s, max 60s */
const RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000, 60000];

/** Adiciona mensagem à fila de retry. Chamado quando o envio ao Chatwoot falha. */
export function addPendingMessage(
  instance: string,
  msgId: string,
  payload: string,
  error?: string
): void {
  // msg_id ou instance vazios causariam INSERT com NULL violando NOT NULL constraint
  if (!instance || !msgId) return;
  const db = getDb();
  const now = Date.now();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO chatwoot_pending
        (instance, msg_id, payload, attempt, next_attempt, last_error, created_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)
    `).run(instance, msgId, payload, now + RETRY_DELAYS_MS[0], error || 'unknown', now);
    log.chatwoot.child(instance).warn(`Mensagem ${msgId} adicionada à fila de retry (attempt=1)`);
  } catch (err) {
    log.chatwoot.child(instance).error('Falha ao adicionar mensagem à fila de retry', err);
  }
}

/** Retorna mensagens prontas para retry (próximo_attempt <= agora). */
type PendingMsg = {
  id: number;
  instance: string;
  msgId: string;
  payload: string;
  attempt: number;
  lastError: string | null;
};

export function getPendingMessages(limit = 50): PendingMsg[] {
  const db = getDb();
  const now = Date.now();
  try {
    const rows = db.prepare(`
      SELECT id, instance, msg_id AS msgId, payload, attempt, last_error AS lastError
      FROM chatwoot_pending
      WHERE next_attempt <= ?
        AND attempt <= 10
      ORDER BY next_attempt ASC
      LIMIT ?
    `).all(now, limit) as PendingMsg[];
    return rows;
  } catch (err) {
    log.chatwoot.error('Falha ao buscar mensagens pendentes', err);
    return [];
  }
}

/** Remove mensagem da fila de retry após sucesso. */
export function removePendingMessage(id: number): void {
  const db = getDb();
  try {
    db.prepare('DELETE FROM chatwoot_pending WHERE id = ?').run(id);
  } catch {
    /* ignore */
  }
}

/** Incrementa tentativa de retry com backoff exponencial. */
export function updatePendingMessageRetry(id: number, attempt: number, error: string): void {
  const db = getDb();
  const nextDelay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  const nextAttempt = Date.now() + nextDelay;
  try {
    db.prepare(`
      UPDATE chatwoot_pending
      SET attempt = ?, next_attempt = ?, last_error = ?
      WHERE id = ?
    `).run(attempt + 1, nextAttempt, error, id);
  } catch {
    /* ignore */
  }
}

/** Remove mensagens pendentes antigas (após muitas tentativas ou muito tempo). */
export function prunePendingMessages(): number {
  const db = getDb();
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 horas
  const maxAttempts = 10;
  try {
    const result = db.prepare(`
      DELETE FROM chatwoot_pending
      WHERE next_attempt < ? OR attempt > ?
    `).run(now - maxAge, maxAttempts);
    return Number(result.changes ?? 0);
  } catch {
    return 0;
  }
}

/** Retorna count de mensagens pendentes. */
export function countPendingMessages(instance?: string): number {
  const db = getDb();
  try {
    if (instance) {
      const row = db.prepare(
        'SELECT COUNT(*) AS c FROM chatwoot_pending WHERE instance = ?'
      ).get(instance) as { c: number } | undefined;
      return row?.c ?? 0;
    }
    const row = db.prepare('SELECT COUNT(*) AS c FROM chatwoot_pending').get() as { c: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}
