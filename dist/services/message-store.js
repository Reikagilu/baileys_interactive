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
import { Worker } from 'node:worker_threads';
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
/**
 * Executa `fn` dentro de uma única transação SQLite (BEGIN IMMEDIATE/COMMIT).
 * Em caso de exceção, faz ROLLBACK e re-lança.
 *
 * Uso primário: ingest em lote durante history sync, onde sem transação cada
 * upsert vira um fsync separado e bloqueia o event loop por segundos com
 * milhares de mensagens. Com transação única, todas as escritas viram um
 * commit só (ganho típico 50-200x para batches grandes).
 *
 * Reentrância: se já houver transação aberta em outro lugar, este wrapper
 * detecta via try/catch ("cannot start a transaction within a transaction")
 * e executa fn diretamente, sem aninhar.
 */
export function runInTransaction(fn) {
    const db = getDb();
    let inOuterTransaction = false;
    try {
        db.exec('BEGIN IMMEDIATE');
    }
    catch {
        // Já existe uma transação aberta no mesmo connection — apenas executa.
        inOuterTransaction = true;
    }
    try {
        const result = fn();
        if (!inOuterTransaction)
            db.exec('COMMIT');
        return result;
    }
    catch (err) {
        if (!inOuterTransaction) {
            try {
                db.exec('ROLLBACK');
            }
            catch { /* ignore */ }
        }
        throw err;
    }
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
    // Delivery lives in a separate table so acknowledgements that arrive before
    // messages.upsert are not lost. PK(instance,msg_id) keeps writes O(log n).
    db.exec(`
    CREATE TABLE IF NOT EXISTS message_delivery (
      instance       TEXT NOT NULL,
      msg_id         TEXT NOT NULL,
      state          TEXT NOT NULL DEFAULT 'pending',
      status_code    INTEGER,
      updated_at     INTEGER NOT NULL DEFAULT 0,
      event          TEXT,
      description    TEXT,
      PRIMARY KEY (instance, msg_id)
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_message_delivery_updated
      ON message_delivery (updated_at)
  `);
    // Versions before 2026-07-28 persisted inbound status events in the outbound
    // delivery table. Remove only rows proven inbound by the primary message store;
    // keep orphan receipts because they may legitimately arrive before ingest.
    const cleanedInboundDelivery = db.prepare(`
    DELETE FROM message_delivery
    WHERE EXISTS (
      SELECT 1 FROM messages m
      WHERE m.instance = message_delivery.instance
        AND m.msg_id = message_delivery.msg_id
        AND m.from_me = 0
    )
  `).run().changes ?? 0;
    if (cleanedInboundDelivery > 0) {
        log.msgStore.info(`delivery cleanup: ${cleanedInboundDelivery} inbound rows removed`);
    }
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
    // Backfill de message_count removido do boot.
    //
    // Por quê: mesmo com setImmediate, este UPDATE roda síncrono no mesmo
    // thread do Node, escaneando todas as mensagens (378k+ em produção) e
    // travando o event loop por vários segundos/minutos. Durante esse tempo,
    // o handler de messages.upsert do Baileys fica bloqueado, e mensagens
    // em tempo real são perdidas (WhatsApp não retém stanzas indefinidamente).
    //
    // O upsertMessage() mantém message_count atualizado via UPSERT
    // (message_count = message_count + excluded.message_count) para qualquer
    // chat que recebe novas mensagens. Para chats pré-existentes que ficaram
    // com count=0 por causa desta remoção, usar:
    //   POST /v1/admin/recount            → recabeça todas as instâncias
    //   POST /v1/admin/recount/:instance  → recabeça uma instância
    // (rota registrada em src/index.ts). A operação roda em Worker Thread e
    // não trava o event loop.
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
    // ─── Tabela dedicada de contatos ───────────────────────────────────────────
    // Substitui o uso de chat_meta.title para armazenar nomes de contato.
    // chat_meta continua existindo para metadados de chat (lastMessage, unread,
    // group subject), mas o nome humano canônico de um contato individual vive
    // aqui. Resolução de nome lê primeiro desta tabela; chat_meta.title fica
    // como fallback para chats já populados antes da migração e para grupos.
    db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      instance      TEXT NOT NULL,
      jid           TEXT NOT NULL,
      lid           TEXT,
      phone_number  TEXT,
      name          TEXT,
      notify        TEXT,
      verified_name TEXT,
      updated_at    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (instance, jid)
    )
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contacts_instance_lid
      ON contacts (instance, lid)
  `);
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contacts_instance_phone
      ON contacts (instance, phone_number)
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
 *
 * Otimização P1+P3: fundir ensureChatMeta + insertMessage + bumpMessageCount em
 * 2 statements máx (1 INSERT messages + 1 UPSERT chat_meta condicional), em vez
 * dos 3 anteriores. Na prática a maioria das mensagens é inserida (não duplicada),
 * portanto o bumpMessageCount acontece na quase totalidade dos casos e a fusão
 * de "ensure + bump" no mesmo UPSERT economiza ~33% de statements por mensagem.
 */
export function upsertMessage(instance, jid, msg) {
    const result = stmt('upsertMessage.insertMessage', `
    INSERT OR IGNORE INTO messages
      (instance, jid, msg_id, from_me, text, ts, sender_name, sender_number, participant, quoted_msg_id, media_json, contact_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(instance, jid, msg.id, msg.fromMe ? 1 : 0, msg.text ?? '', msg.timestamp ?? 0, msg.senderName ?? null, msg.senderNumber ?? null, msg.participant ?? null, msg.quotedMessageId ?? null, msg.media ? JSON.stringify(msg.media) : null, msg.contact ? JSON.stringify(msg.contact) : null);
    const inserted = (result.changes ?? 0) > 0;
    // Always ensure chat_meta exists. When the message is a real one (not a junk
    // placeholder), also bump message_count — fused into a single UPSERT so that
    // "ensure row exists" and "increment counter" cost only 1 statement instead of 2.
    const isJunkPlaceholder = inserted && (msg.text ?? '') === '[message]' && !msg.media && !msg.contact;
    if (!isJunkPlaceholder) {
        stmt('upsertMessage.upsertMeta', `
      INSERT INTO chat_meta (instance, jid, message_count)
      VALUES (?, ?, ?)
      ON CONFLICT (instance, jid) DO UPDATE SET
        message_count = message_count + excluded.message_count
    `).run(instance, jid, inserted ? 1 : 0);
    }
    else {
        // Junk placeholder: still ensure the chat_meta row exists but don't increment.
        stmt('upsertMessage.ensureMeta', `
      INSERT OR IGNORE INTO chat_meta (instance, jid) VALUES (?, ?)
    `).run(instance, jid);
    }
    return inserted;
}
/**
 * Otimização P2: em vez de 1 UPDATE por campo (até 6 statements), constrói
 * um único UPDATE dinâmico com apenas os campos presentes no patch.
 * Statements são cacheados por "máscara de campos" (chave determinística),
 * portanto prepared statements continuam sendo reutilizados entre chamadas
 * com o mesmo conjunto de campos.
 */
export function updateMessageFields(instance, jid, msgId, patch) {
    if (!instance || !jid || !msgId)
        return;
    const setClauses = [];
    const args = [];
    // Bit-mask key for caching the prepared statement per field combination.
    let maskKey = 0;
    if (patch.senderName !== undefined) {
        setClauses.push('sender_name = ?');
        args.push(patch.senderName ?? null);
        maskKey |= 1;
    }
    if (patch.senderNumber !== undefined) {
        setClauses.push('sender_number = ?');
        args.push(patch.senderNumber ?? null);
        maskKey |= 2;
    }
    if (patch.participant !== undefined) {
        setClauses.push('participant = ?');
        args.push(patch.participant ?? null);
        maskKey |= 4;
    }
    if (patch.quotedMessageId !== undefined) {
        setClauses.push('quoted_msg_id = ?');
        args.push(patch.quotedMessageId ?? null);
        maskKey |= 8;
    }
    if (patch.media !== undefined) {
        setClauses.push('media_json = ?');
        args.push(patch.media ? JSON.stringify(patch.media) : null);
        maskKey |= 16;
    }
    if (patch.contact !== undefined) {
        setClauses.push('contact_json = ?');
        args.push(patch.contact ? JSON.stringify(patch.contact) : null);
        maskKey |= 32;
    }
    if (!setClauses.length)
        return;
    args.push(instance, jid, msgId);
    const sql = `UPDATE messages SET ${setClauses.join(', ')} WHERE instance = ? AND jid = ? AND msg_id = ?`;
    // Cast para any pois node:sqlite aceita todos os tipos primitivos mas o TS não expõe o union type correto no spread.
    stmt(`updateMessageFields.m${maskKey}`, sql).run(...args);
}
/** Persist/update a delivery acknowledgement independently of message ingest order. */
export function setMessageDeliveryState(instance, msgId, delivery) {
    if (!instance || !msgId || !delivery.state)
        return;
    stmt('setMessageDeliveryState', `
    INSERT INTO message_delivery
      (instance, msg_id, state, status_code, updated_at, event, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance, msg_id) DO UPDATE SET
      state = excluded.state,
      status_code = excluded.status_code,
      updated_at = excluded.updated_at,
      event = excluded.event,
      description = excluded.description
    WHERE excluded.updated_at >= message_delivery.updated_at
  `).run(instance, msgId, delivery.state, delivery.statusCode ?? null, delivery.updatedAt, delivery.event ?? null, delivery.description ?? null);
}
export function getMessageDeliveryState(instance, msgId) {
    if (!instance || !msgId)
        return undefined;
    const row = stmt('getMessageDeliveryState', `
    SELECT state, status_code, updated_at, event, description
    FROM message_delivery WHERE instance = ? AND msg_id = ?
  `).get(instance, msgId);
    return row ? {
        state: row.state,
        statusCode: row.status_code ?? undefined,
        updatedAt: row.updated_at,
        event: row.event ?? undefined,
        description: row.description ?? undefined,
    } : undefined;
}
export function getMessageDeliveryStates(instance, msgIds) {
    const result = new Map();
    const unique = [...new Set(msgIds.filter(Boolean))];
    for (let offset = 0; offset < unique.length; offset += 400) {
        const chunk = unique.slice(offset, offset + 400);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = getDb().prepare(`
      SELECT msg_id, state, status_code, updated_at, event, description
      FROM message_delivery
      WHERE instance = ? AND msg_id IN (${placeholders})
    `).all(instance, ...chunk);
        for (const row of rows)
            result.set(row.msg_id, {
                state: row.state,
                statusCode: row.status_code ?? undefined,
                updatedAt: row.updated_at,
                event: row.event ?? undefined,
                description: row.description ?? undefined,
            });
    }
    return result;
}
/**
 * Atualiza metadados do chat.
 *
 * Otimização P3: fundir "ensure row + N updates separados" em um único UPSERT
 * com COALESCE para campos opcionais. Cai de até 5 statements para 1 na maioria
 * dos casos. O statement é parametrizado sempre com todos os campos; NULL é
 * passado para campos ausentes no patch e COALESCE preserva o valor atual.
 * MAX() garante que last_ts nunca retrocede.
 */
export function upsertChatMeta(instance, jid, patch) {
    stmt('upsertChatMeta.unified', `
    INSERT INTO chat_meta (instance, jid, title, last_message, last_ts, unread_count)
    VALUES (?, ?, COALESCE(?, ''), COALESCE(?, ''), COALESCE(?, 0), COALESCE(?, 0))
    ON CONFLICT (instance, jid) DO UPDATE SET
      title        = CASE WHEN excluded.title        != '' THEN excluded.title        ELSE chat_meta.title        END,
      last_message = CASE WHEN excluded.last_message != '' THEN excluded.last_message ELSE chat_meta.last_message END,
      last_ts      = MAX(chat_meta.last_ts, COALESCE(excluded.last_ts, chat_meta.last_ts)),
      unread_count = CASE WHEN excluded.unread_count IS NOT NULL AND ? THEN excluded.unread_count ELSE chat_meta.unread_count END
  `).run(instance, jid, patch.title ?? null, patch.lastMessage ?? null, patch.lastTimestamp ?? null, patch.unreadCount ?? null, 
    // Flag: 1 if unreadCount is explicitly set, 0 otherwise (to distinguish 0 from "not set")
    patch.unreadCount !== undefined ? 1 : 0);
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
    SELECT msg_id, from_me, text, ts, sender_name, sender_number, participant, quoted_msg_id,
           media_json, contact_json, delivery_state, delivery_status_code,
           delivery_updated_at, delivery_event, delivery_description
    FROM (
      SELECT m.msg_id, m.from_me, m.text, m.ts, m.sender_name, m.sender_number,
             m.participant, m.quoted_msg_id, m.media_json, m.contact_json,
             d.state AS delivery_state, d.status_code AS delivery_status_code,
             d.updated_at AS delivery_updated_at, d.event AS delivery_event,
             d.description AS delivery_description
      FROM messages m
      LEFT JOIN message_delivery d
        ON d.instance = m.instance AND d.msg_id = m.msg_id
      WHERE m.instance = ? AND m.jid = ? AND (? IS NULL OR m.ts >= ?)
      ORDER BY m.ts DESC
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
        delivery: r.delivery_state ? {
            state: r.delivery_state,
            statusCode: r.delivery_status_code ?? undefined,
            updatedAt: r.delivery_updated_at ?? 0,
            event: r.delivery_event ?? undefined,
            description: r.delivery_description ?? undefined,
        } : undefined,
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
    stmt('clearInstance.contacts', 'DELETE FROM contacts WHERE instance = ?').run(instance);
}
// ─── Contatos ────────────────────────────────────────────────────────────────
/**
 * Normaliza string vinda de payload Baileys: trim + descarta vazio.
 * Retorna `null` para que SQL preserve a coluna existente via COALESCE.
 */
function normalizeContactField(value) {
    if (value === undefined || value === null)
        return null;
    const trimmed = String(value).trim();
    return trimmed || null;
}
/**
 * Regex usada para distinguir um pushName "fraco" (apenas dígitos do JID)
 * de um nome humano. Reutilizada do critério do chatwoot-bridge.
 */
function isMeaningfulName(value) {
    if (!value)
        return false;
    // Aceita números formatados ou nomes com letras; rejeita apenas
    // identificadores brutos (somente dígitos sem formatação).
    return /[a-zA-ZÀ-ÿ+\-\s]/.test(value);
}
/**
 * Upsert de um contato. Campos `null`/ausentes não sobrescrevem valores
 * existentes (COALESCE). Sempre atualiza `updated_at`.
 *
 * Para `name`/`notify`/`verifiedName` aplica também uma proteção extra:
 * uma string vazia ou só dígitos sem formatação NÃO sobrescreve um nome
 * humano já gravado — evita que pushNames "fracos" (que coincidem com o
 * número de telefone) apaguem o nome real vindo da agenda.
 */
export function upsertContact(instance, patch) {
    if (!instance || !patch.jid)
        return;
    const jid = patch.jid.trim();
    if (!jid)
        return;
    const name = normalizeContactField(patch.name);
    const notify = normalizeContactField(patch.notify);
    const verifiedName = normalizeContactField(patch.verifiedName);
    const lid = normalizeContactField(patch.lid);
    const phoneNumber = normalizeContactField(patch.phoneNumber);
    // Sentinela: 1 quando o campo de nome é "forte" (tem letras/acentos);
    // 0 caso contrário. Usada no CASE WHEN para decidir se sobrescreve.
    const nameStrong = name && isMeaningfulName(name) ? 1 : 0;
    const notifyStrong = notify && isMeaningfulName(notify) ? 1 : 0;
    const verifiedStrong = verifiedName && isMeaningfulName(verifiedName) ? 1 : 0;
    stmt('upsertContact', `
    INSERT INTO contacts (instance, jid, lid, phone_number, name, notify, verified_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (instance, jid) DO UPDATE SET
      lid           = COALESCE(excluded.lid,           contacts.lid),
      phone_number  = COALESCE(excluded.phone_number,  contacts.phone_number),
      name          = CASE WHEN ? = 1 THEN excluded.name          ELSE contacts.name          END,
      notify        = CASE WHEN ? = 1 THEN excluded.notify        ELSE contacts.notify        END,
      verified_name = CASE WHEN ? = 1 THEN excluded.verified_name ELSE contacts.verified_name END,
      updated_at    = excluded.updated_at
  `).run(instance, jid, lid, phoneNumber, name, notify, verifiedName, Date.now(), nameStrong, notifyStrong, verifiedStrong);
}
/**
 * Upsert em lote (envolve em uma única transação SQLite).
 * Aceita o tipo `Contact` do Baileys (`id`, `lid`, `phoneNumber`,
 * `name`, `notify`, `verifiedName`). Ignora silenciosamente entradas
 * sem `id`/`jid`.
 */
export function bulkUpsertContacts(instance, contacts) {
    if (!instance || !contacts || contacts.length === 0)
        return 0;
    let count = 0;
    runInTransaction(() => {
        for (const c of contacts) {
            const id = String(c.id ?? c.jid ?? '').trim();
            if (!id)
                continue;
            upsertContact(instance, {
                jid: id,
                lid: c.lid ?? null,
                phoneNumber: c.phoneNumber ?? null,
                name: c.name ?? null,
                notify: c.notify ?? null,
                verifiedName: c.verifiedName ?? null,
            });
            count += 1;
        }
    });
    return count;
}
function rowToContact(row) {
    if (!row)
        return null;
    return {
        jid: String(row.jid ?? ''),
        lid: row.lid ?? undefined,
        phoneNumber: row.phone_number ?? undefined,
        name: row.name ?? undefined,
        notify: row.notify ?? undefined,
        verifiedName: row.verified_name ?? undefined,
        updatedAt: Number(row.updated_at ?? 0),
    };
}
/**
 * Retorna o contato armazenado para um JID exato, ou null.
 * Não faz fallback por LID — use `getContactByAnyId` para isso.
 */
export function getContact(instance, jid) {
    const row = stmt('getContact', 'SELECT jid, lid, phone_number, name, notify, verified_name, updated_at FROM contacts WHERE instance = ? AND jid = ?').get(instance, jid);
    return rowToContact(row);
}
/**
 * Procura um contato pelo JID exato; se não achar, tenta pela coluna `lid`
 * (útil quando se recebe um @lid mas o registro está gravado como PN, ou
 * vice-versa).
 */
export function getContactByAnyId(instance, id) {
    if (!id)
        return null;
    const direct = getContact(instance, id);
    if (direct)
        return direct;
    const row = stmt('getContactByLid', 'SELECT jid, lid, phone_number, name, notify, verified_name, updated_at FROM contacts WHERE instance = ? AND lid = ? LIMIT 1').get(instance, id);
    return rowToContact(row);
}
/**
 * Retorna o nome mais forte disponível para um contato (verifiedName >
 * name > notify), ou `null` se nenhum estiver disponível ou todos forem
 * "fracos" (sem letras). Tenta JID direto e fallback pelo LID.
 */
export function getContactName(instance, id) {
    const contact = getContactByAnyId(instance, id);
    if (!contact)
        return null;
    const candidates = [contact.verifiedName, contact.name, contact.notify];
    for (const c of candidates) {
        const trimmed = (c ?? '').trim();
        if (trimmed && isMeaningfulName(trimmed))
            return trimmed;
    }
    // Fallback secundário: aceita qualquer string não-vazia se nenhum forte.
    for (const c of candidates) {
        const trimmed = (c ?? '').trim();
        if (trimmed)
            return trimmed;
    }
    return null;
}
/**
 * Lista todos os contatos da instância (mais recentes primeiro).
 * Limite padrão alto para uso de listagem; o caller pode filtrar.
 */
export function listContacts(instance, limit = 5000) {
    const rows = stmt('listContacts', `SELECT jid, lid, phone_number, name, notify, verified_name, updated_at
       FROM contacts
       WHERE instance = ?
       ORDER BY updated_at DESC
       LIMIT ?`).all(instance, limit);
    return rows.map((r) => rowToContact(r));
}
// ─── Backfill retroativo de contatos a partir de messages.sender_name ─────────────
/**
 * Popula a tabela `contacts` retroativamente a partir dos sender_name já capturados
 * em `messages`. Útil para instâncias antigas que receberam mensagens antes do flag
 * `importContacts` ser ativado, ou antes da tabela existir.
 *
 * Considera apenas:
 *   - mensagens com `sender_name` não-vazio
 *   - `from_me = 0`
 *   - JIDs `@s.whatsapp.net` (ignora grupos, status, newsletters, @lid)
 *
 * Para cada `jid` distinto pega o `sender_name` mais recente (maior `ts`).
 * Insere com `notify` = sender_name (campo "fraco", representando pushName).
 * Se já houver um nome "forte" em `name`/`verified_name`, não sobrescreve graças
 * ao CASE WHEN em `upsertContact`.
 *
 * Retorna `{ scanned, upserted }`.
 */
export function backfillContactsFromMessages(instance) {
    // Janela de coleta: para cada jid, pega o sender_name mais recente não-vazio.
    // Filtra apenas JIDs PN reais (@s.whatsapp.net), evitando @g.us / status / broadcast.
    const rows = stmt('backfillContacts.collect', `
    SELECT m.jid AS jid, m.sender_name AS sender_name, m.sender_number AS sender_number
      FROM messages m
      INNER JOIN (
        SELECT jid, MAX(ts) AS maxTs
          FROM messages
          WHERE instance = ?
            AND from_me  = 0
            AND sender_name IS NOT NULL
            AND TRIM(sender_name) <> ''
            AND jid LIKE '%@s.whatsapp.net'
          GROUP BY jid
      ) latest
      ON m.jid = latest.jid AND m.ts = latest.maxTs
     WHERE m.instance = ?
       AND m.from_me  = 0
       AND m.sender_name IS NOT NULL
       AND TRIM(m.sender_name) <> ''
       AND m.jid LIKE '%@s.whatsapp.net'
    `).all(instance, instance);
    let scanned = 0;
    let upserted = 0;
    runInTransaction(() => {
        for (const r of rows) {
            scanned += 1;
            const jid = r.jid;
            const senderName = (r.sender_name ?? '').trim();
            if (!senderName)
                continue;
            try {
                // sender_name é um pushName (definido pelo próprio contato → "fraco").
                // Mapeia para `notify`. Se houver "name" forte (vindo da agenda do usuário
                // via eventos Baileys), upsertContact preserva o existente.
                upsertContact(instance, {
                    jid,
                    phoneNumber: r.sender_number ?? jid,
                    notify: senderName,
                });
                upserted += 1;
            }
            catch (err) {
                log.msgStore.warn(`backfillContactsFromMessages: failed for jid=${jid}: ${err?.message}`);
            }
        }
    });
    log.msgStore.info(`backfillContactsFromMessages instance=${instance} scanned=${scanned} upserted=${upserted}`);
    return { scanned, upserted };
}
// ─── Cleanup de mensagens por TTL ─────────────────────────────────────────────────
let _cleanupInterval = null;
let _cleanupInitialTimeout = null;
/**
 * Inicia o job periódico de cleanup de mensagens antigas.
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
    // Atrasa a primeira execução para não bloquear o event loop durante o startup.
    // runMessageCleanup() é síncrono e pode levar segundos em bancos grandes.
    const INITIAL_DELAY_MS = 30_000;
    _cleanupInitialTimeout = setTimeout(() => {
        _cleanupInitialTimeout = null;
        runMessageCleanup();
        _cleanupInterval = setInterval(runMessageCleanup, intervalMs);
    }, INITIAL_DELAY_MS);
}
/**
 * Para o job de cleanup (incluindo o timer inicial se ainda não disparou).
 */
export function stopMessageCleanupJob() {
    if (_cleanupInitialTimeout) {
        clearTimeout(_cleanupInitialTimeout);
        _cleanupInitialTimeout = null;
    }
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
        // Limpa chat_meta órfão (sem mensagens).
        // NOT EXISTS com LIMIT 1 usa o índice (instance, jid) em O(log n) por linha
        // de chat_meta, evitando materializar o DISTINCT que varria toda a tabela.
        const resultMeta = stmt('cleanupOrphanMeta', `
      DELETE FROM chat_meta
      WHERE NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.instance = chat_meta.instance
          AND m.jid      = chat_meta.jid
        LIMIT 1
      )
    `).run();
        const deletedMeta = resultMeta.changes ?? 0;
        const resultDelivery = stmt('cleanupOrphanDelivery', `
      DELETE FROM message_delivery
      WHERE updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.instance = message_delivery.instance
            AND m.msg_id = message_delivery.msg_id
          LIMIT 1
        )
    `).run(cutoff);
        const deletedDelivery = resultDelivery.changes ?? 0;
        if (cleanedMedia > 0 || deletedMeta > 0 || deletedDelivery > 0) {
            log.msgStore.success(`cleanup concluído: ${cleanedMedia} mídias limpas, ${deletedMeta} chats órfãos, ${deletedDelivery} receipts órfãos removidos`);
        }
    }
    catch (err) {
        log.msgStore.error(`cleanup falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
}
// Recomputa message_count para chat_meta a partir da tabela messages.
//
// Estratégia: roda em Worker Thread (não trava o event loop do Node).
// - Se `instance` for passado, só recabeça aquela instância.
// - Caso contrário, recabeça TODAS as instâncias.
//
// Uso típico após adicionar/remover migration ou para corrigir chats
// pré-existentes que ficaram com count=0 por ausência de mensagens novas.
//
// Endpoint HTTP: POST /v1/admin/recount[/:instance]
//
// Retorna uma Promise<{ updated: number, scanned: number, instance?: string }>.
// módulo pai é ESM, e o worker precisa ser CommonJS para suportar `await`
// top-level sem warnings sobre formato de módulo.
let _workerScriptPath = null;
async function getWorkerScriptPathAsync() {
    if (_workerScriptPath)
        return _workerScriptPath;
    // Usa createRequire pra carregar módulos core do Node sem precisar de import
    // dinâmico assíncrono neste escopo síncrono.
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const fsSync = req('node:fs');
    const osSync = req('node:os');
    const pathSync = req('node:path');
    const dir = fsSync.mkdtempSync(pathSync.join(osSync.tmpdir(), 'beyound-recount-'));
    const file = pathSync.join(dir, 'recount.cjs');
    fsSync.writeFileSync(file, RECOUNT_WORKER_SRC, 'utf8');
    _workerScriptPath = file;
    return file;
}
const RECOUNT_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {  // IIFE wrapper for top-level await support

const { dbPath, instanceFilter } = workerData;

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

const CHUNK = 200;
const YIELD_EVERY_MS = 250;

const totalSql = instanceFilter
  ? 'SELECT COUNT(*) AS c FROM chat_meta WHERE instance = ?'
  : 'SELECT COUNT(*) AS c FROM chat_meta';
const totalParams = instanceFilter ? [instanceFilter] : [];
const { c: total } = db.prepare(totalSql).get(...totalParams);

let scanned = 0;
let updated = 0;
let offset = 0;

while (offset < total) {
  const chunkSql = instanceFilter
    ? 'SELECT instance, jid FROM chat_meta WHERE instance = ? ORDER BY instance, jid LIMIT ? OFFSET ?'
    : 'SELECT instance, jid FROM chat_meta ORDER BY instance, jid LIMIT ? OFFSET ?';
  const chunkParams = instanceFilter
    ? [instanceFilter, CHUNK, offset]
    : [CHUNK, offset];
  const rows = db.prepare(chunkSql).all(...chunkParams);
  if (rows.length === 0) break;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { instance, jid } of rows) {
      const cnt = db.prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE instance = ? AND jid = ? AND NOT (text = '[message]' AND media_json IS NULL AND contact_json IS NULL)"
      ).get(instance, jid).c;
      db.prepare('UPDATE chat_meta SET message_count = ? WHERE instance = ? AND jid = ?')
        .run(cnt, instance, jid);
      updated += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    parentPort.postMessage({ type: 'error', error: String(err) });
    break;
  }

  scanned += rows.length;
  offset += rows.length;
  parentPort.postMessage({ type: 'progress', scanned, updated, total });
  await sleep(YIELD_EVERY_MS);
}

parentPort.postMessage({ type: 'done', scanned, updated, total });
})().catch((e) => parentPort.postMessage({ type: 'error', error: String(e) }));
`;
export async function recomputeMessageCounts(opts = {}) {
    const dbPath = path.resolve(process.cwd(), config.messages.dbPath);
    const workerScriptPath = await getWorkerScriptPathAsync();
    return new Promise((resolve, reject) => {
        const worker = new Worker(workerScriptPath, {
            workerData: { dbPath, instanceFilter: opts.instance ?? null },
        });
        worker.on('message', (msg) => {
            if (msg.type === 'error') {
                log.msgStore.warn('recomputeMessageCounts worker error', msg.error);
            }
            else if (msg.type === 'done') {
                log.msgStore.info(`recomputeMessageCounts done  instance=${opts.instance ?? 'ALL'}  scanned=${msg.scanned}  updated=${msg.updated}`);
                resolve({ updated: msg.updated ?? 0, scanned: msg.scanned ?? 0, instance: opts.instance });
                worker.terminate().catch(() => { });
            }
        });
        worker.on('error', (err) => {
            log.msgStore.warn('recomputeMessageCounts worker thread error', err);
            reject(err);
        });
        worker.on('exit', (code) => {
            if (code !== 0) {
                log.msgStore.warn(`recomputeMessageCounts worker exited code=${code}`);
            }
        });
    });
}
