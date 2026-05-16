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

// ─── Tipos públicos ──────────────────────────────────────────────────────────

export interface StoredMessage {
  id: string;
  fromMe: boolean;
  text: string;
  timestamp: number;
  senderName?: string;
  senderNumber?: string;
  participant?: string;
  quotedMessageId?: string;
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
export function runInTransaction<T>(fn: () => T): T {
  const db = getDb();
  let inOuterTransaction = false;
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch {
    // Já existe uma transação aberta no mesmo connection — apenas executa.
    inOuterTransaction = true;
  }
  try {
    const result = fn();
    if (!inOuterTransaction) db.exec('COMMIT');
    return result;
  } catch (err) {
    if (!inOuterTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    }
    throw err;
  }
}

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
  } catch (err) {
    if (!String(err).includes('duplicate column')) throw err;
  }
  try {
    db.exec('ALTER TABLE messages ADD COLUMN quoted_msg_id TEXT');
  } catch (err) {
    if (!String(err).includes('duplicate column')) throw err;
  }
  try {
    db.exec('ALTER TABLE chat_meta ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    if (!String(err).includes('duplicate column')) throw err;
  }
  // Defer the message_count backfill — runs a single GROUP BY scan instead of
  // a correlated subquery per row, which is 10-100x faster on large databases.
  // setImmediate only defers by 1 tick; the update itself is synchronous and can
  // still stall the event loop if the DB is huge. For very large databases
  // consider running this in a worker thread or skipping altogether.
  setImmediate(() => {
    try {
      db.exec(`
        UPDATE chat_meta
        SET message_count = (
          SELECT cnt FROM (
            SELECT instance, jid, COUNT(*) AS cnt
            FROM messages
            WHERE NOT (text = '[message]' AND media_json IS NULL AND contact_json IS NULL)
            GROUP BY instance, jid
          ) agg
          WHERE agg.instance = chat_meta.instance
            AND agg.jid = chat_meta.jid
        )
        WHERE message_count = 0
      `);
    } catch (err) {
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

function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
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
export function upsertMessage(instance: string, jid: string, msg: StoredMessage): boolean {
  const result = stmt('upsertMessage.insertMessage', `
    INSERT OR IGNORE INTO messages
      (instance, jid, msg_id, from_me, text, ts, sender_name, sender_number, participant, quoted_msg_id, media_json, contact_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    msg.quotedMessageId ?? null,
    msg.media ? JSON.stringify(msg.media) : null,
    msg.contact ? JSON.stringify(msg.contact) : null,
  );
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
  } else {
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
export function updateMessageFields(
  instance: string,
  jid: string,
  msgId: string,
  patch: Partial<StoredMessage>,
): void {
  if (!instance || !jid || !msgId) return;

  const setClauses: string[] = [];
  const args: unknown[] = [];

  // Bit-mask key for caching the prepared statement per field combination.
  let maskKey = 0;

  if (patch.senderName !== undefined)     { setClauses.push('sender_name = ?');   args.push(patch.senderName ?? null);                              maskKey |= 1; }
  if (patch.senderNumber !== undefined)   { setClauses.push('sender_number = ?'); args.push(patch.senderNumber ?? null);                            maskKey |= 2; }
  if (patch.participant !== undefined)    { setClauses.push('participant = ?');    args.push(patch.participant ?? null);                             maskKey |= 4; }
  if (patch.quotedMessageId !== undefined){ setClauses.push('quoted_msg_id = ?'); args.push(patch.quotedMessageId ?? null);                         maskKey |= 8; }
  if (patch.media !== undefined)          { setClauses.push('media_json = ?');    args.push(patch.media ? JSON.stringify(patch.media) : null);      maskKey |= 16; }
  if (patch.contact !== undefined)        { setClauses.push('contact_json = ?');  args.push(patch.contact ? JSON.stringify(patch.contact) : null);  maskKey |= 32; }

  if (!setClauses.length) return;

  args.push(instance, jid, msgId);
  const sql = `UPDATE messages SET ${setClauses.join(', ')} WHERE instance = ? AND jid = ? AND msg_id = ?`;
  // Cast para any pois node:sqlite aceita todos os tipos primitivos mas o TS não expõe o union type correto no spread.
  stmt(`updateMessageFields.m${maskKey}`, sql).run(...(args as Parameters<ReturnType<DatabaseSync['prepare']>['run']>));
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
export function upsertChatMeta(
  instance: string,
  jid: string,
  patch: Partial<{ title: string; lastMessage: string; lastTimestamp: number; unreadCount: number }>
): void {
  stmt('upsertChatMeta.unified', `
    INSERT INTO chat_meta (instance, jid, title, last_message, last_ts, unread_count)
    VALUES (?, ?, COALESCE(?, ''), COALESCE(?, ''), COALESCE(?, 0), COALESCE(?, 0))
    ON CONFLICT (instance, jid) DO UPDATE SET
      title        = CASE WHEN excluded.title        != '' THEN excluded.title        ELSE chat_meta.title        END,
      last_message = CASE WHEN excluded.last_message != '' THEN excluded.last_message ELSE chat_meta.last_message END,
      last_ts      = MAX(chat_meta.last_ts, COALESCE(excluded.last_ts, chat_meta.last_ts)),
      unread_count = CASE WHEN excluded.unread_count IS NOT NULL AND ? THEN excluded.unread_count ELSE chat_meta.unread_count END
  `).run(
    instance,
    jid,
    patch.title ?? null,
    patch.lastMessage ?? null,
    patch.lastTimestamp ?? null,
    patch.unreadCount ?? null,
    // Flag: 1 if unreadCount is explicitly set, 0 otherwise (to distinguish 0 from "not set")
    patch.unreadCount !== undefined ? 1 : 0,
  );
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
 * Quando afterTs não é fornecido, retorna as N mais recentes (não as N mais antigas).
 */
export function listMessages(instance: string, jid: string, limit = 500, afterTs?: number): StoredMessage[] {
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
  `).all(instance, jid, afterTs ?? null, afterTs ?? null, limit) as Array<{
    msg_id: string;
    from_me: number;
    text: string;
    ts: number;
    sender_name: string | null;
    sender_number: string | null;
    participant: string | null;
    quoted_msg_id: string | null;
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
    quotedMessageId: r.quoted_msg_id ?? undefined,
    media: parseJson<Record<string, unknown>>(r.media_json),
    contact: parseJson<Record<string, unknown>>(r.contact_json),
  }));
}

/**
 * Variante otimizada para sync histórico: retorna apenas mensagens com conteúdo
 * útil para envio ao Chatwoot (texto não-vazio, mídia presente ou contato presente).
 */
export function listSyncMessages(instance: string, jid: string, limit = 500, afterTs?: number): StoredMessage[] {
  const rows = stmt('listSyncMessages', `
    SELECT msg_id, from_me, text, ts, sender_name, sender_number, participant, quoted_msg_id, media_json, contact_json
    FROM messages
    WHERE instance = ?
      AND jid = ?
      AND (? IS NULL OR ts >= ?)
      AND (text != '' OR media_json IS NOT NULL OR contact_json IS NOT NULL)
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
    quoted_msg_id: string | null;
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
    quotedMessageId: r.quoted_msg_id ?? undefined,
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
  `).all(instance, jid, afterTs ?? null, afterTs ?? null, limit) as Array<{
    msg_id: string;
    from_me: number;
    text: string;
    ts: number;
    sender_name: string | null;
    sender_number: string | null;
    participant: string | null;
    quoted_msg_id: string | null;
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
    quotedMessageId: r.quoted_msg_id ?? undefined,
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
  ).get(instance, jid) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

/**
 * Remove todos os dados de uma instância (ao fazer logout/delete).
 */
export function clearInstance(instance: string): void {
  stmt('clearInstance.messages', 'DELETE FROM messages WHERE instance = ?').run(instance);
  stmt('clearInstance.chatMeta', 'DELETE FROM chat_meta WHERE instance = ?').run(instance);
}

// ─── Cleanup de mensagens por TTL ─────────────────────────────────────────────────

let _cleanupInterval: ReturnType<typeof setInterval> | null = null;
let _cleanupInitialTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Inicia o job periódico de cleanup de mensagens antigas.
 * Use `stopMessageCleanupJob()` para encerrar.
 */
export function startMessageCleanupJob(): void {
  if (_cleanupInterval) return;
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
export function stopMessageCleanupJob(): void {
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
function runMessageCleanup(): void {
  if (config.messages.historyTtlDays === 0) return;

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

    if (cleanedMedia > 0 || deletedMeta > 0) {
      log.msgStore.success(`cleanup concluído: ${cleanedMedia} mídias limpas, ${deletedMeta} chats órfãos removidos`);
    }
  } catch (err) {
    log.msgStore.error(`cleanup falhou: ${err instanceof Error ? err.message : String(err)}`);
  }
}
