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
import { log } from '../utils/logger.js';
// ─── Internos ────────────────────────────────────────────────────────────────
let _db = null;
let _stmts = null;
function stmt(key, sql) {
    const db = getDb();
    if (!_stmts)
        _stmts = {};
    if (!_stmts[key])
        _stmts[key] = db.prepare(sql);
    return _stmts[key];
}
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
    db.exec('PRAGMA busy_timeout = 5000');
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
      quoted_msg_id TEXT,
      media_json    TEXT,
      contact_json  TEXT,
      PRIMARY KEY (instance, jid, msg_id)
    )
  `);
    try {
        db.exec('ALTER TABLE messages ADD COLUMN participant TEXT');
    }
    catch (err) {
        if (!String(err).includes('duplicate column'))
            throw err;
    }
    try {
        db.exec('ALTER TABLE messages ADD COLUMN quoted_msg_id TEXT');
    }
    catch (err) {
        if (!String(err).includes('duplicate column'))
            throw err;
    }
    try {
        db.exec('ALTER TABLE chat_meta ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0');
    }
    catch (err) {
        if (!String(err).includes('duplicate column'))
            throw err;
    }
    // Defer the message_count backfill — it's a correlated subquery over all
    // chat_meta rows with message_count = 0, which can take several seconds on
    // large databases and would block the event loop at startup if run inline.
    setImmediate(() => {
        try {
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
        }
        catch (err) {
            log.msgStore.warn('message_count backfill falhou', err);
        }
    });
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_instance_jid_ts
      ON messages (instance, jid, ts)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_instance_msg_id
      ON messages (instance, msg_id)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chat_meta_instance_last_ts
      ON chat_meta (instance, last_ts)
  `);
    // Garante que a tabela chatwoot_synced existe antes que listUnsyncedSyncMessages
    // execute o LEFT JOIN. chatwoot-sync-store.ts usa a mesma conexão e também cria
    // esta tabela, mas a ordem de inicialização não é garantida.
    db.exec(`
    CREATE TABLE IF NOT EXISTS chatwoot_synced (
      instance        TEXT NOT NULL,
      msg_id          TEXT NOT NULL,
      conversation_id INTEGER NOT NULL DEFAULT 0,
      synced_at       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (instance, msg_id)
    )
  `);
    _db = db;
    _stmts = null;
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
    stmt('upsertMessage.ensureChatMeta', `
    INSERT OR IGNORE INTO chat_meta (instance, jid) VALUES (?, ?)
  `).run(instance, jid);
    const result = stmt('upsertMessage.insertMessage', `
    INSERT OR IGNORE INTO messages
      (instance, jid, msg_id, from_me, text, ts, sender_name, sender_number, participant, quoted_msg_id, media_json, contact_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(instance, jid, msg.id, msg.fromMe ? 1 : 0, msg.text ?? '', msg.timestamp ?? 0, msg.senderName ?? null, msg.senderNumber ?? null, msg.participant ?? null, msg.quotedMessageId ?? null, msg.media ? JSON.stringify(msg.media) : null, msg.contact ? JSON.stringify(msg.contact) : null);
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
export function updateMessageFields(instance, jid, msgId, patch) {
    if (!instance || !jid || !msgId)
        return;
    if (patch.senderName !== undefined) {
        stmt('updateMessageFields.senderName', 'UPDATE messages SET sender_name = ? WHERE instance = ? AND jid = ? AND msg_id = ?')
            .run(patch.senderName ?? null, instance, jid, msgId);
    }
    if (patch.senderNumber !== undefined) {
        stmt('updateMessageFields.senderNumber', 'UPDATE messages SET sender_number = ? WHERE instance = ? AND jid = ? AND msg_id = ?')
            .run(patch.senderNumber ?? null, instance, jid, msgId);
    }
    if (patch.participant !== undefined) {
        stmt('updateMessageFields.participant', 'UPDATE messages SET participant = ? WHERE instance = ? AND jid = ? AND msg_id = ?')
            .run(patch.participant ?? null, instance, jid, msgId);
    }
    if (patch.quotedMessageId !== undefined) {
        stmt('updateMessageFields.quotedMessageId', 'UPDATE messages SET quoted_msg_id = ? WHERE instance = ? AND jid = ? AND msg_id = ?')
            .run(patch.quotedMessageId ?? null, instance, jid, msgId);
    }
    if (patch.media !== undefined) {
        stmt('updateMessageFields.media', 'UPDATE messages SET media_json = ? WHERE instance = ? AND jid = ? AND msg_id = ?')
            .run(patch.media ? JSON.stringify(patch.media) : null, instance, jid, msgId);
    }
    if (patch.contact !== undefined) {
        stmt('updateMessageFields.contact', 'UPDATE messages SET contact_json = ? WHERE instance = ? AND jid = ? AND msg_id = ?')
            .run(patch.contact ? JSON.stringify(patch.contact) : null, instance, jid, msgId);
    }
}
/**
 * Atualiza metadados do chat.
 */
export function upsertChatMeta(instance, jid, patch) {
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
        stmt('upsertChatMeta.lastTimestamp', 'UPDATE chat_meta SET last_ts = MAX(last_ts, ?) WHERE instance = ? AND jid = ?').run(patch.lastTimestamp, instance, jid);
    }
    if (patch.unreadCount !== undefined) {
        stmt('upsertChatMeta.unreadCount', 'UPDATE chat_meta SET unread_count = ? WHERE instance = ? AND jid = ?')
            .run(patch.unreadCount, instance, jid);
    }
}
export function incrementUnread(instance, jid) {
    stmt('incrementUnread', `
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
 * Retorna o título salvo do chat (vindo de pushName ou subject de grupo). Null se vazio.
 */
export function getChatTitle(instance, jid) {
    const row = stmt('getChatTitle', 'SELECT title FROM chat_meta WHERE instance = ? AND jid = ?').get(instance, jid);
    if (!row)
        return null;
    const title = (row.title || '').trim();
    return title || null;
}
/**
 * Retorna todos os chats da instância, ordenados por last_ts DESC.
 */
export function listChats(instance) {
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
 * afterTs: se fornecido, retorna apenas mensagens com ts >= afterTs.
 * Quando afterTs não é fornecido, retorna as N mais recentes (não as N mais antigas).
 */
export function listMessages(instance, jid, limit = 500, afterTs) {
    const rows = stmt('listMessages', `
    SELECT msg_id, from_me, text, ts, sender_name, sender_number, participant, quoted_msg_id, media_json, contact_json
    FROM (
      SELECT msg_id, from_me, text, ts, sender_name, sender_number, participant, quoted_msg_id, media_json, contact_json
      FROM messages
      WHERE instance = ? AND jid = ? AND (? IS NULL OR ts >= ?)
      ORDER BY ts DESC
      LIMIT ?
    )
    ORDER BY ts ASC
  `).all(instance, jid, afterTs ?? null, afterTs ?? null, limit);
    return rows.map((r) => ({
        id: r.msg_id,
        fromMe: r.from_me === 1,
        text: r.text,
        timestamp: r.ts,
        senderName: r.sender_name ?? undefined,
        senderNumber: r.sender_number ?? undefined,
        participant: r.participant ?? undefined,
        quotedMessageId: r.quoted_msg_id ?? undefined,
        media: parseJson(r.media_json),
        contact: parseJson(r.contact_json),
    }));
}
/**
 * Variante otimizada para sync histórico: retorna apenas mensagens com conteúdo
 * útil para envio ao Chatwoot (texto não-vazio, mídia presente ou contato presente).
 */
export function listSyncMessages(instance, jid, limit = 500, afterTs) {
    const rows = stmt('listSyncMessages', `
    SELECT msg_id, from_me, text, ts, sender_name, sender_number, participant, quoted_msg_id, media_json, contact_json
    FROM messages
    WHERE instance = ?
      AND jid = ?
      AND (? IS NULL OR ts >= ?)
      AND (text != '' OR media_json IS NOT NULL OR contact_json IS NOT NULL)
    ORDER BY ts ASC
    LIMIT ?
  `).all(instance, jid, afterTs ?? null, afterTs ?? null, limit);
    return rows.map((r) => ({
        id: r.msg_id,
        fromMe: r.from_me === 1,
        text: r.text,
        timestamp: r.ts,
        senderName: r.sender_name ?? undefined,
        senderNumber: r.sender_number ?? undefined,
        participant: r.participant ?? undefined,
        quotedMessageId: r.quoted_msg_id ?? undefined,
        media: parseJson(r.media_json),
        contact: parseJson(r.contact_json),
    }));
}
/**
 * Variante ainda mais otimizada para sync histórico: já exclui mensagens que
 * constam em chatwoot_synced, evitando uma segunda consulta por chat.
 */
export function listUnsyncedSyncMessages(instance, jid, limit = 500, afterTs) {
    const rows = stmt('listUnsyncedSyncMessages', `
    SELECT m.msg_id, m.from_me, m.text, m.ts, m.sender_name, m.sender_number, m.participant, m.quoted_msg_id, m.media_json, m.contact_json
    FROM messages m
    LEFT JOIN chatwoot_synced s
      ON s.instance = m.instance
     AND s.msg_id = m.msg_id
    WHERE m.instance = ?
      AND m.jid = ?
      AND (? IS NULL OR m.ts >= ?)
      AND (m.text != '' OR m.media_json IS NOT NULL OR m.contact_json IS NOT NULL)
      AND s.msg_id IS NULL
    ORDER BY m.ts ASC
    LIMIT ?
  `).all(instance, jid, afterTs ?? null, afterTs ?? null, limit);
    return rows.map((r) => ({
        id: r.msg_id,
        fromMe: r.from_me === 1,
        text: r.text,
        timestamp: r.ts,
        senderName: r.sender_name ?? undefined,
        senderNumber: r.sender_number ?? undefined,
        participant: r.participant ?? undefined,
        quotedMessageId: r.quoted_msg_id ?? undefined,
        media: parseJson(r.media_json),
        contact: parseJson(r.contact_json),
    }));
}
/**
 * Retorna o timestamp da mensagem mais antiga armazenada para um chat.
 * Útil para decidir se é necessário buscar mais histórico.
 */
export function getOldestMessageTs(instance, jid) {
    const row = stmt('getOldestMessageTs', 'SELECT MIN(ts) AS min_ts FROM messages WHERE instance = ? AND jid = ?').get(instance, jid);
    return row?.min_ts ?? 0;
}
/**
 * Conta mensagens de um chat.
 */
export function countMessages(instance, jid) {
    const row = stmt('countMessages', 'SELECT message_count AS cnt FROM chat_meta WHERE instance = ? AND jid = ?').get(instance, jid);
    return row?.cnt ?? 0;
}
/**
 * Remove todos os dados de uma instância (ao fazer logout/delete).
 */
export function clearInstance(instance) {
    stmt('clearInstance.messages', 'DELETE FROM messages WHERE instance = ?').run(instance);
    stmt('clearInstance.chatMeta', 'DELETE FROM chat_meta WHERE instance = ?').run(instance);
}
// ─── Cleanup de mensagens por TTL ─────────────────────────────────────────────────
let _cleanupInterval = null;
/**
 * Inicia o job периодический de cleanup de mensagens antigas.
 * Use `stopMessageCleanupJob()` para encerrar.
 */
export function startMessageCleanupJob() {
    if (_cleanupInterval)
        return;
    if (config.messages.historyTtlDays === 0) {
        log.msgStore.info('TTL desabilitado (historyTtlDays=0) — cleanup não iniciado');
        return;
    }
    const ttlMs = config.messages.historyTtlDays * 24 * 60 * 60 * 1000;
    const intervalMs = config.messages.cleanupIntervalMs;
    log.msgStore.info(`iniciando cleanup: TTL=${config.messages.historyTtlDays}d  intervalo=${intervalMs / 1000 / 60}min`);
    // Executa cleanup imediato na inicialização
    runMessageCleanup();
    // Agenda execução periódica
    _cleanupInterval = setInterval(runMessageCleanup, intervalMs);
}
/**
 * Para o job de cleanup.
 */
export function stopMessageCleanupJob() {
    if (_cleanupInterval) {
        clearInterval(_cleanupInterval);
        _cleanupInterval = null;
        log.msgStore.info('cleanup job parado');
    }
}
/**
 * Executa a limpeza de mídias mais antigas que o TTL.
 * Não deleta mensagens - apenas remove o base64 para liberar espaço.
 * A mensagem permanece e pode ter sua mídia re-baixada do WhatsApp quando necessário.
 */
function runMessageCleanup() {
    if (config.messages.historyTtlDays === 0)
        return;
    const ttlMs = config.messages.historyTtlDays * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    try {
        // Limpa apenas o campo media_json (remove base64) de mensagens antigas
        // Não deleta a mensagem - apenas libera espaço da mídia armazenada localmente
        const result = stmt('cleanupMedia', 'UPDATE messages SET media_json = NULL WHERE ts < ? AND media_json IS NOT NULL').run(cutoff);
        const cleanedMedia = result.changes ?? 0;
        // Limpa chat_meta órfão (sem mensagens) — filtra por instance para não afetar outras instâncias
        const resultMeta = stmt('cleanupOrphanMeta', `
      DELETE FROM chat_meta WHERE (instance, jid) NOT IN (
        SELECT DISTINCT instance, jid FROM messages
      )
    `).run();
        const deletedMeta = resultMeta.changes ?? 0;
        if (cleanedMedia > 0 || deletedMeta > 0) {
            log.msgStore.success(`cleanup concluído: ${cleanedMedia} mídias limpas, ${deletedMeta} chats órfãos removidos`);
        }
    }
    catch (err) {
        log.msgStore.error(`cleanup falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=message-store.js.map