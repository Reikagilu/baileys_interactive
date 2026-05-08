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

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export interface StoredMessage {
  id: string;
  fromMe: boolean;
  text: string;
  timestamp: number;
  senderName?: string;
  senderNumber?: string;
  participant?: string;
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

// ─── Internos ────────────────────────────────────────────────────────────────

let _db: DatabaseSync | null = null;
let _stmts: Record<string, ReturnType<DatabaseSync['prepare']>> | null = null;

function stmt(key: string, sql: string) {
  const db = getDb();
  if (!_stmts) _stmts = {};
  if (!_stmts[key]) _stmts[key] = db.prepare(sql);
  return _stmts[key];
}

function getDb(): DatabaseSync {
  if (_db) return _db;

  const resolved = path.resolve(process.cwd(), config.messages.dbPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(resolved);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_meta (
      instance     TEXT NOT NULL,
      jid          TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      last_message TEXT NOT NULL DEFAULT '',
      last_ts      INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (instance, jid)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      instance      TEXT    NOT NULL,
      jid           TEXT    NOT NULL,
      msg_id        TEXT    NOT NULL,
      from_me       INTEGER NOT NULL DEFAULT 0,
      text          TEXT    NOT NULL DEFAULT '',
      ts            INTEGER NOT NULL DEFAULT 0,
      sender_name   TEXT,
      sender_number TEXT,
      participant   TEXT,
      media_json    TEXT,
      contact_json  TEXT,
      PRIMARY KEY (instance, jid, msg_id)
    )
  `);
  try {
    db.exec('ALTER TABLE messages ADD COLUMN participant TEXT');
  } catch {
    // column already exists
  }
  try {
    db.exec('ALTER TABLE chat_meta ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0');
  } catch {
    // column already exists
  }
  db.exec(`
    UPDATE chat_meta
    SET message_count = (
      SELECT COUNT(*)
      FROM messages m
      WHERE m.instance = chat_meta.instance
        AND m.jid = chat_meta.jid
        AND NOT (m.text = '[message]' AND m.media_json IS NULL AND m.contact_json IS NULL)
    )
    WHERE message_count = 0
      AND EXISTS (
        SELECT 1
        FROM messages m2
        WHERE m2.instance = chat_meta.instance
          AND m2.jid = chat_meta.jid
      )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_instance_jid_ts
      ON messages (instance, jid, ts)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_meta_instance_last_ts
      ON chat_meta (instance, last_ts)
  `);
  _db = db;
  _stmts = null;
  return db;
}

function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

/**
 * Insere ou ignora uma mensagem (ON CONFLICT IGNORE — não substitui existente).
 * Retorna true se foi inserida, false se já existia.
 */
export function upsertMessage(instance: string, jid: string, msg: StoredMessage): boolean {
  stmt('upsertMessage.ensureChatMeta', `
    INSERT OR IGNORE INTO chat_meta (instance, jid) VALUES (?, ?)
  `).run(instance, jid);
  const result = stmt('upsertMessage.insertMessage', `
    INSERT OR IGNORE INTO messages
      (instance, jid, msg_id, from_me, text, ts, sender_name, sender_number, participant, media_json, contact_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    instance,
    jid,
    msg.id,
    msg.fromMe ? 1 : 0,
    msg.text ?? '',
    msg.timestamp ?? 0,
    msg.senderName ?? null,
    msg.senderNumber ?? null,
    msg.participant ?? null,
    msg.media ? JSON.stringify(msg.media) : null,
    msg.contact ? JSON.stringify(msg.contact) : null,
  );
  const inserted = (result.changes ?? 0) > 0;
  if (inserted) {
    const isJunkPlaceholder = (msg.text ?? '') === '[message]' && !msg.media && !msg.contact;
    if (!isJunkPlaceholder) {
      stmt('upsertMessage.bumpMessageCount', 'UPDATE chat_meta SET message_count = message_count + 1 WHERE instance = ? AND jid = ?')
        .run(instance, jid);
    }
  }
  return inserted;
}

/**
 * Atualiza metadados do chat.
 */
export function upsertChatMeta(
  instance: string,
  jid: string,
  patch: Partial<{ title: string; lastMessage: string; lastTimestamp: number; unreadCount: number }>
): void {
  // Garante que a linha existe
  stmt('upsertChatMeta.ensureChatMeta', `
    INSERT OR IGNORE INTO chat_meta (instance, jid) VALUES (?, ?)
  `).run(instance, jid);

  if (patch.title !== undefined) {
    stmt('upsertChatMeta.title', 'UPDATE chat_meta SET title = ? WHERE instance = ? AND jid = ?')
      .run(patch.title, instance, jid);
  }
  if (patch.lastMessage !== undefined) {
    stmt('upsertChatMeta.lastMessage', 'UPDATE chat_meta SET last_message = ? WHERE instance = ? AND jid = ?')
      .run(patch.lastMessage, instance, jid);
  }
  if (patch.lastTimestamp !== undefined) {
    stmt(
      'upsertChatMeta.lastTimestamp',
      'UPDATE chat_meta SET last_ts = MAX(last_ts, ?) WHERE instance = ? AND jid = ?'
    ).run(patch.lastTimestamp, instance, jid);
  }
  if (patch.unreadCount !== undefined) {
    stmt('upsertChatMeta.unreadCount', 'UPDATE chat_meta SET unread_count = ? WHERE instance = ? AND jid = ?')
      .run(patch.unreadCount, instance, jid);
  }
}

export function incrementUnread(instance: string, jid: string): void {
  stmt('incrementUnread', `
    INSERT INTO chat_meta (instance, jid, unread_count)
    VALUES (?, ?, 1)
    ON CONFLICT (instance, jid) DO UPDATE SET unread_count = unread_count + 1
  `).run(instance, jid);
}

export function resetUnread(instance: string, jid: string): void {
  upsertChatMeta(instance, jid, { unreadCount: 0 });
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

/**
 * Retorna o título salvo do chat (vindo de pushName ou subject de grupo). Null se vazio.
 */
export function getChatTitle(instance: string, jid: string): string | null {
  const row = stmt('getChatTitle', 'SELECT title FROM chat_meta WHERE instance = ? AND jid = ?').get(instance, jid) as { title?: string } | undefined;
  if (!row) return null;
  const title = (row.title || '').trim();
  return title || null;
}

/**
 * Retorna todos os chats da instância, ordenados por last_ts DESC.
 */
export function listChats(instance: string): StoredChatMeta[] {
  const rows = stmt('listChats', `
    SELECT
      c.jid,
      c.title,
      c.last_message,
      c.last_ts,
      c.unread_count,
      c.message_count
    FROM chat_meta c
    WHERE c.instance = ?
    ORDER BY c.last_ts DESC
  `).all(instance) as Array<{
    jid: string;
    title: string;
    last_message: string;
    last_ts: number;
    unread_count: number;
    message_count: number;
  }>;

  return rows.map((r) => ({
    jid: r.jid,
    title: r.title || r.jid.split('@')[0],
    lastMessage: r.last_message,
    lastTimestamp: r.last_ts,
    unreadCount: r.unread_count,
    messageCount: r.message_count,
  }));
}

/**
 * Retorna as mensagens de um chat, ordenadas por ts ASC.
 * limit padrão: 500 mensagens mais recentes.
 * afterTs: se fornecido, retorna apenas mensagens com ts >= afterTs.
 */
export function listMessages(instance: string, jid: string, limit = 500, afterTs?: number): StoredMessage[] {
  const rows = stmt('listMessages', `
    SELECT msg_id, from_me, text, ts, sender_name, sender_number, participant, media_json, contact_json
    FROM messages
    WHERE instance = ? AND jid = ? AND (? IS NULL OR ts >= ?)
    ORDER BY ts ASC
    LIMIT ?
  `).all(instance, jid, afterTs ?? null, afterTs ?? null, limit) as Array<{
    msg_id: string;
    from_me: number;
    text: string;
    ts: number;
    sender_name: string | null;
    sender_number: string | null;
    participant: string | null;
    media_json: string | null;
    contact_json: string | null;
  }>;

  return rows.map((r) => ({
    id: r.msg_id,
    fromMe: r.from_me === 1,
    text: r.text,
    timestamp: r.ts,
    senderName: r.sender_name ?? undefined,
    senderNumber: r.sender_number ?? undefined,
    participant: r.participant ?? undefined,
    media: parseJson<Record<string, unknown>>(r.media_json),
    contact: parseJson<Record<string, unknown>>(r.contact_json),
  }));
}

/**
 * Variante otimizada para sync histórico: retorna apenas mensagens com conteúdo
 * útil para envio ao Chatwoot (texto não-vazio ou mídia presente).
 */
export function listSyncMessages(instance: string, jid: string, limit = 500, afterTs?: number): StoredMessage[] {
  const rows = stmt('listSyncMessages', `
    SELECT msg_id, from_me, text, ts, sender_name, sender_number, participant, media_json, contact_json
    FROM messages
    WHERE instance = ?
      AND jid = ?
      AND (? IS NULL OR ts >= ?)
      AND (text != '' OR media_json IS NOT NULL)
    ORDER BY ts ASC
    LIMIT ?
  `).all(instance, jid, afterTs ?? null, afterTs ?? null, limit) as Array<{
    msg_id: string;
    from_me: number;
    text: string;
    ts: number;
    sender_name: string | null;
    sender_number: string | null;
    participant: string | null;
    media_json: string | null;
    contact_json: string | null;
  }>;

  return rows.map((r) => ({
    id: r.msg_id,
    fromMe: r.from_me === 1,
    text: r.text,
    timestamp: r.ts,
    senderName: r.sender_name ?? undefined,
    senderNumber: r.sender_number ?? undefined,
    participant: r.participant ?? undefined,
    media: parseJson<Record<string, unknown>>(r.media_json),
    contact: parseJson<Record<string, unknown>>(r.contact_json),
  }));
}

/**
 * Variante ainda mais otimizada para sync histórico: já exclui mensagens que
 * constam em chatwoot_synced, evitando uma segunda consulta por chat.
 */
export function listUnsyncedSyncMessages(instance: string, jid: string, limit = 500, afterTs?: number): StoredMessage[] {
  const rows = stmt('listUnsyncedSyncMessages', `
    SELECT m.msg_id, m.from_me, m.text, m.ts, m.sender_name, m.sender_number, m.participant, m.media_json, m.contact_json
    FROM messages m
    LEFT JOIN chatwoot_synced s
      ON s.instance = m.instance
     AND s.msg_id = m.msg_id
    WHERE m.instance = ?
      AND m.jid = ?
      AND (? IS NULL OR m.ts >= ?)
      AND (m.text != '' OR m.media_json IS NOT NULL)
      AND s.msg_id IS NULL
    ORDER BY m.ts ASC
    LIMIT ?
  `).all(instance, jid, afterTs ?? null, afterTs ?? null, limit) as Array<{
    msg_id: string;
    from_me: number;
    text: string;
    ts: number;
    sender_name: string | null;
    sender_number: string | null;
    participant: string | null;
    media_json: string | null;
    contact_json: string | null;
  }>;

  return rows.map((r) => ({
    id: r.msg_id,
    fromMe: r.from_me === 1,
    text: r.text,
    timestamp: r.ts,
    senderName: r.sender_name ?? undefined,
    senderNumber: r.sender_number ?? undefined,
    participant: r.participant ?? undefined,
    media: parseJson<Record<string, unknown>>(r.media_json),
    contact: parseJson<Record<string, unknown>>(r.contact_json),
  }));
}

/**
 * Retorna o timestamp da mensagem mais antiga armazenada para um chat.
 * Útil para decidir se é necessário buscar mais histórico.
 */
export function getOldestMessageTs(instance: string, jid: string): number {
  const row = stmt(
    'getOldestMessageTs',
    'SELECT MIN(ts) AS min_ts FROM messages WHERE instance = ? AND jid = ?'
  ).get(instance, jid) as { min_ts: number | null } | undefined;
  return row?.min_ts ?? 0;
}

/**
 * Conta mensagens de um chat.
 */
export function countMessages(instance: string, jid: string): number {
  const row = stmt(
    'countMessages',
    'SELECT message_count AS cnt FROM chat_meta WHERE instance = ? AND jid = ?'
  ).get(instance, jid) as { cnt: number };
  return row.cnt ?? 0;
}

/**
 * Remove todos os dados de uma instância (ao fazer logout/delete).
 */
export function clearInstance(instance: string): void {
  stmt('clearInstance.messages', 'DELETE FROM messages WHERE instance = ?').run(instance);
  stmt('clearInstance.chatMeta', 'DELETE FROM chat_meta WHERE instance = ?').run(instance);
}
