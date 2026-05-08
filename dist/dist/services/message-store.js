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
// ─── Internos ────────────────────────────────────────────────────────────────
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
    CREATE TABLE IF NOT EXISTS chat_meta (
      instance     TEXT NOT NULL,
      jid          TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '',
      last_message TEXT NOT NULL DEFAULT '',
      last_ts      INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
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
      media_json    TEXT,
      contact_json  TEXT,
      PRIMARY KEY (instance, jid, msg_id)
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_instance_jid_ts
      ON messages (instance, jid, ts)
  `);
    _db = db;
    return db;
}
function parseJson(raw) {
    if (typeof raw !== 'string' || !raw)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
// ─── Escrita ─────────────────────────────────────────────────────────────────
/**
 * Insere ou ignora uma mensagem (ON CONFLICT IGNORE — não substitui existente).
 * Retorna true se foi inserida, false se já existia.
 */
export function upsertMessage(instance, jid, msg) {
    const db = getDb();
    const result = db.prepare(`
    INSERT OR IGNORE INTO messages
      (instance, jid, msg_id, from_me, text, ts, sender_name, sender_number, media_json, contact_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(instance, jid, msg.id, msg.fromMe ? 1 : 0, msg.text ?? '', msg.timestamp ?? 0, msg.senderName ?? null, msg.senderNumber ?? null, msg.media ? JSON.stringify(msg.media) : null, msg.contact ? JSON.stringify(msg.contact) : null);
    return (result.changes ?? 0) > 0;
}
/**
 * Atualiza metadados do chat.
 */
export function upsertChatMeta(instance, jid, patch) {
    const db = getDb();
    // Garante que a linha existe
    db.prepare(`
    INSERT OR IGNORE INTO chat_meta (instance, jid) VALUES (?, ?)
  `).run(instance, jid);
    if (patch.title !== undefined) {
        db.prepare('UPDATE chat_meta SET title = ? WHERE instance = ? AND jid = ?')
            .run(patch.title, instance, jid);
    }
    if (patch.lastMessage !== undefined) {
        db.prepare('UPDATE chat_meta SET last_message = ? WHERE instance = ? AND jid = ?')
            .run(patch.lastMessage, instance, jid);
    }
    if (patch.lastTimestamp !== undefined) {
        db.prepare('UPDATE chat_meta SET last_ts = MAX(last_ts, ?) WHERE instance = ? AND jid = ?').run(patch.lastTimestamp, instance, jid);
    }
    if (patch.unreadCount !== undefined) {
        db.prepare('UPDATE chat_meta SET unread_count = ? WHERE instance = ? AND jid = ?')
            .run(patch.unreadCount, instance, jid);
    }
}
export function incrementUnread(instance, jid) {
    const db = getDb();
    db.prepare(`
    INSERT INTO chat_meta (instance, jid, unread_count)
    VALUES (?, ?, 1)
    ON CONFLICT (instance, jid) DO UPDATE SET unread_count = unread_count + 1
  `).run(instance, jid);
}
export function resetUnread(instance, jid) {
    upsertChatMeta(instance, jid, { unreadCount: 0 });
}
// ─── Leitura ─────────────────────────────────────────────────────────────────
/**
 * Retorna todos os chats da instância, ordenados por last_ts DESC.
 */
export function listChats(instance) {
    const db = getDb();
    const rows = db.prepare(`
    SELECT
      c.jid,
      c.title,
      c.last_message,
      c.last_ts,
      c.unread_count,
      COUNT(m.msg_id) AS message_count
    FROM chat_meta c
    LEFT JOIN messages m ON m.instance = c.instance AND m.jid = c.jid
    WHERE c.instance = ?
    GROUP BY c.jid
    ORDER BY c.last_ts DESC
  `).all(instance);
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
 */
export function listMessages(instance, jid, limit = 500) {
    const db = getDb();
    const rows = db.prepare(`
    SELECT msg_id, from_me, text, ts, sender_name, sender_number, media_json, contact_json
    FROM messages
    WHERE instance = ? AND jid = ?
    ORDER BY ts ASC
    LIMIT ?
  `).all(instance, jid, limit);
    return rows.map((r) => ({
        id: r.msg_id,
        fromMe: r.from_me === 1,
        text: r.text,
        timestamp: r.ts,
        senderName: r.sender_name ?? undefined,
        senderNumber: r.sender_number ?? undefined,
        media: parseJson(r.media_json),
        contact: parseJson(r.contact_json),
    }));
}
/**
 * Retorna o timestamp da mensagem mais antiga armazenada para um chat.
 * Útil para decidir se é necessário buscar mais histórico.
 */
export function getOldestMessageTs(instance, jid) {
    const db = getDb();
    const row = db.prepare('SELECT MIN(ts) AS min_ts FROM messages WHERE instance = ? AND jid = ?').get(instance, jid);
    return row?.min_ts ?? 0;
}
/**
 * Conta mensagens de um chat.
 */
export function countMessages(instance, jid) {
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) AS cnt FROM messages WHERE instance = ? AND jid = ?').get(instance, jid);
    return row.cnt ?? 0;
}
/**
 * Remove todos os dados de uma instância (ao fazer logout/delete).
 */
export function clearInstance(instance) {
    const db = getDb();
    db.prepare('DELETE FROM messages WHERE instance = ?').run(instance);
    db.prepare('DELETE FROM chat_meta WHERE instance = ?').run(instance);
}
//# sourceMappingURL=message-store.js.map