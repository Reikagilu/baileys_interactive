import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
const allowedEventSet = new Set([
    'connection.update',
    'messages.upsert',
    'messages.update',
    'message-receipt.update',
    'chats.update',
    'groups.update',
]);
// ---------------------------------------------------------------------------
// Lazy-init DB (side effects no import level causam crash em startup e testes)
// ---------------------------------------------------------------------------
let _db = null;
function getDb() {
    if (_db)
        return _db;
    _db = openDatabase(config.webhooks.dbPath);
    setupSchema(_db);
    return _db;
}
let _webhooksCache = null;
let _cleanupTimer = null;
function invalidateWebhooksCache() {
    _webhooksCache = null;
}
function getCachedWebhooks() {
    if (_webhooksCache !== null)
        return _webhooksCache;
    const db = getDb();
    const rows = db.prepare('SELECT * FROM webhooks WHERE enabled = 1 ORDER BY created_at DESC').all();
    // Pre-parse events once and store as Set for O(1) per-event checks during emit.
    _webhooksCache = rows.map((row) => ({
        row,
        events: new Set(parseEvents(String(row.events ?? '[]'))),
    }));
    return _webhooksCache;
}
// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
function openDatabase(dbPath) {
    const resolved = path.resolve(process.cwd(), dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const db = new DatabaseSync(resolved);
    db.exec('PRAGMA busy_timeout = 5000;');
    try {
        db.exec('PRAGMA journal_mode = WAL;');
    }
    catch { /* can be locked */ }
    try {
        db.exec('PRAGMA synchronous = NORMAL;');
    }
    catch { /* optional */ }
    return db;
}
function ensureColumn(db, tableName, columnName, definition) {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (columns.some((c) => c.name === columnName))
        return;
    try {
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        if (!msg.includes('duplicate column name'))
            throw error;
    }
}
function setupSchema(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      instance TEXT,
      enabled INTEGER NOT NULL,
      secret TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      webhook_name TEXT NOT NULL,
      webhook_url TEXT NOT NULL,
      event TEXT NOT NULL,
      instance TEXT,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      delivered_at INTEGER,
      last_error TEXT,
      response_status INTEGER,
      lock_owner TEXT,
      lock_expires_at INTEGER,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    `);
    ensureColumn(db, 'webhook_deliveries', 'lock_owner', 'TEXT');
    ensureColumn(db, 'webhook_deliveries', 'lock_expires_at', 'INTEGER');
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled);
    CREATE INDEX IF NOT EXISTS idx_deliveries_status_due ON webhook_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_created ON webhook_deliveries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deliveries_lock ON webhook_deliveries(lock_owner, lock_expires_at);
    `);
    // Índice para event matching (substitui LIKE scan no hot-path via filtro JS)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_webhooks_enabled_instance ON webhooks(enabled, instance);`);
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseEvents(raw) {
    try {
        const parsed = JSON.parse(raw);
        return normalizeWebhookEvents(parsed);
    }
    catch {
        return [];
    }
}
function parsePayload(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function toWebhook(row) {
    return {
        id: String(row.id),
        name: String(row.name),
        url: String(row.url),
        events: parseEvents(String(row.events ?? '[]')),
        instance: row.instance == null ? undefined : String(row.instance),
        enabled: Number(row.enabled) === 1,
        secret: row.secret == null ? undefined : String(row.secret),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}
function toDelivery(row) {
    return {
        id: String(row.id),
        webhookId: String(row.webhook_id),
        webhookName: String(row.webhook_name),
        webhookUrl: String(row.webhook_url),
        event: String(row.event),
        instance: row.instance == null ? undefined : String(row.instance),
        status: String(row.status),
        attemptCount: Number(row.attempt_count),
        maxAttempts: Number(row.max_attempts),
        nextAttemptAt: Number(row.next_attempt_at),
        lastAttemptAt: row.last_attempt_at == null ? undefined : Number(row.last_attempt_at),
        deliveredAt: row.delivered_at == null ? undefined : Number(row.delivered_at),
        lastError: row.last_error == null ? undefined : String(row.last_error),
        responseStatus: row.response_status == null ? undefined : Number(row.response_status),
        lockOwner: row.lock_owner == null ? undefined : String(row.lock_owner),
        lockExpiresAt: row.lock_expires_at == null ? undefined : Number(row.lock_expires_at),
        payload: parsePayload(String(row.payload)),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}
function toEventEnvelope(event, payload, instance) {
    return {
        id: randomUUID(),
        event,
        instance: instance ?? null,
        emittedAt: new Date().toISOString(),
        payload,
    };
}
function computeRetryDelayMs(attempt) {
    const exponent = Math.max(0, attempt - 1);
    const delay = config.webhooks.retryBaseDelayMs * 2 ** exponent;
    return Math.min(config.webhooks.retryMaxDelayMs, delay);
}
function computeSignature(secret, timestamp, body) {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
// ---------------------------------------------------------------------------
// Cleanup periódico de histórico (desacoplado do hot-path)
// ---------------------------------------------------------------------------
function scheduleCleanupTimer() {
    if (_cleanupTimer)
        return;
    const intervalMs = config.webhooks.purgeIntervalMs ?? 60_000;
    _cleanupTimer = setInterval(() => {
        try {
            runCleanupDeliveryHistory();
        }
        catch { /* ignore */ }
    }, intervalMs);
    _cleanupTimer.unref?.();
}
function runCleanupDeliveryHistory() {
    const db = getDb();
    const countRow = db.prepare('SELECT COUNT(*) AS c FROM webhook_deliveries').get();
    const total = Number(countRow.c ?? 0);
    const overBy = total - config.webhooks.maxDeliveryHistory;
    if (overBy <= 0)
        return;
    db.prepare(`DELETE FROM webhook_deliveries
     WHERE id IN (
       SELECT id FROM webhook_deliveries
       WHERE status NOT IN ('pending', 'processing')
       ORDER BY created_at ASC
       LIMIT ?
     )`).run(overBy);
}
// ---------------------------------------------------------------------------
// Exports públicos
// ---------------------------------------------------------------------------
export function normalizeWebhookEvents(events) {
    if (!Array.isArray(events))
        return [];
    const normalized = events
        .map((e) => String(e ?? '').trim())
        .filter((e) => allowedEventSet.has(e));
    return Array.from(new Set(normalized));
}
export function createWebhook(input) {
    const db = getDb();
    const now = Date.now();
    const id = randomUUID();
    const events = normalizeWebhookEvents(input.events);
    db.prepare(`INSERT INTO webhooks (id, name, url, events, instance, enabled, secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.url, JSON.stringify(events), input.instance ?? null, (input.enabled ?? true) ? 1 : 0, input.secret ?? null, now, now);
    invalidateWebhooksCache();
    scheduleCleanupTimer();
    return { id, name: input.name, url: input.url, events, instance: input.instance, enabled: input.enabled ?? true, secret: input.secret, createdAt: now, updatedAt: now };
}
export function listWebhooks() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all();
    return rows.map(toWebhook);
}
export function getWebhook(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
    return row ? toWebhook(row) : null;
}
export function updateWebhook(id, update) {
    const db = getDb();
    const current = getWebhook(id);
    if (!current)
        return null;
    const now = Date.now();
    const next = {
        ...current,
        name: update.name ?? current.name,
        url: update.url ?? current.url,
        // Usar 'instance' in update para detectar remoção explícita com null/undefined
        instance: 'instance' in update ? (update.instance ?? undefined) : current.instance,
        enabled: update.enabled ?? current.enabled,
        // Idem para secret: permite limpar com null
        secret: '[REDACTED]' in update ? (update.secret ?? undefined) : current.secret,
        events: update.events !== undefined ? normalizeWebhookEvents(update.events) : current.events,
        updatedAt: now,
    };
    db.prepare(`UPDATE webhooks
     SET name = ?, url = ?, events = ?, instance = ?, enabled = ?, secret = ?, updated_at = ?
     WHERE id = ?`).run(next.name, next.url, JSON.stringify(next.events), next.instance ?? null, next.enabled ? 1 : 0, next.secret ?? null, now, id);
    invalidateWebhooksCache();
    return next;
}
export function deleteWebhook(id) {
    const db = getDb();
    const result = db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
    invalidateWebhooksCache();
    return Number(result.changes ?? 0) > 0;
}
export function listSupportedWebhookEvents() {
    return [...allowedEventSet.values()];
}
// Filtro em JS a partir de cache: elimina LIKE-scan a cada emitWebhookEvent.
// Events pre-parsed as Set during cache build → O(1) per event lookup instead of O(events) includes.
function selectEligibleWebhooks(event, instance) {
    const all = getCachedWebhooks();
    const result = [];
    for (const entry of all) {
        if (!entry.events.has(event))
            continue;
        if (instance) {
            if (entry.row.instance != null && entry.row.instance !== instance)
                continue;
        }
        else {
            if (entry.row.instance != null)
                continue;
        }
        result.push(toWebhook(entry.row));
    }
    return result;
}
function enqueueDelivery(db, webhook, event, payload, instance) {
    const now = Date.now();
    db.prepare(`INSERT INTO webhook_deliveries (
      id, webhook_id, webhook_name, webhook_url, event, instance, status, attempt_count,
      max_attempts, next_attempt_at, payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), webhook.id, webhook.name, webhook.url, event, instance ?? null, 'pending', 0, config.webhooks.maxAttempts, now, JSON.stringify(toEventEnvelope(event, payload, instance)), now, now);
}
export function emitWebhookEvent(event, payload, instance) {
    const hooks = selectEligibleWebhooks(event, instance);
    if (!hooks.length)
        return { queued: 0 };
    const db = getDb();
    // Agrupar enfileiramentos em transação para reduzir fsyncs (N hooks/evento)
    db.exec('BEGIN');
    try {
        for (const webhook of hooks) {
            enqueueDelivery(db, webhook, event, payload, instance);
        }
        db.exec('COMMIT');
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
    // Cleanup periódico desacoplado — não rodar inline
    scheduleCleanupTimer();
    return { queued: hooks.length };
}
export function enqueueWebhookTestDelivery(webhookId, event, payload) {
    const webhook = getWebhook(webhookId);
    if (!webhook)
        return { queued: 0, reason: 'webhook_not_found' };
    if (!webhook.enabled)
        return { queued: 0, reason: 'webhook_disabled' };
    const db = getDb();
    enqueueDelivery(db, webhook, event, payload, webhook.instance);
    scheduleCleanupTimer();
    return { queued: 1 };
}
export function listWebhookDeliveries(filters) {
    const db = getDb();
    const conditions = [];
    const params = [];
    if (filters?.webhookId) {
        conditions.push('webhook_id = ?');
        params.push(filters.webhookId);
    }
    if (filters?.status) {
        conditions.push('status = ?');
        params.push(filters.status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(filters?.limit ?? 50, 1), 500);
    const rows = db.prepare(`SELECT * FROM webhook_deliveries ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, limit);
    return rows.map(toDelivery);
}
export function listDeadLetterDeliveries(limit = 100) {
    return listWebhookDeliveries({ status: 'failed', limit });
}
export function purgeDeadLetterDeliveries(olderThanMs) {
    if (typeof olderThanMs !== 'number' || !Number.isFinite(olderThanMs)) {
        throw new Error('olderThanMs must be a finite number');
    }
    const db = getDb();
    const cutoff = Date.now() - Math.max(olderThanMs, 0);
    const result = db.prepare("DELETE FROM webhook_deliveries WHERE status = 'failed' AND updated_at < ?").run(cutoff);
    return Number(result.changes ?? 0);
}
export function getWebhookDelivery(id) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id);
    return row ? toDelivery(row) : null;
}
export function retryWebhookDelivery(id) {
    const delivery = getWebhookDelivery(id);
    if (!delivery)
        return null;
    const maxAttempts = delivery.attemptCount >= delivery.maxAttempts ? delivery.attemptCount + 1 : delivery.maxAttempts;
    const now = Date.now();
    const db = getDb();
    // Condicional: não retentar se estiver sendo processado e lock válido
    db.prepare(`UPDATE webhook_deliveries
     SET status = 'pending',
         lock_owner = NULL,
         lock_expires_at = NULL,
         max_attempts = ?,
         next_attempt_at = ?,
         updated_at = ?
     WHERE id = ? AND (status != 'processing' OR COALESCE(lock_expires_at, 0) <= ?)`).run(maxAttempts, now, now, id, now);
    return getWebhookDelivery(id);
}
export function claimDueDeliveries(batchSize, workerId, lockMs) {
    const db = getDb();
    const now = Date.now();
    const lockExpiresAt = now + Math.max(lockMs, 1000);
    db.exec('BEGIN IMMEDIATE');
    try {
        const rows = db.prepare(`SELECT id FROM webhook_deliveries
         WHERE (
            status = 'pending'
            OR (status = 'processing' AND COALESCE(lock_expires_at, 0) <= ?)
         )
         AND next_attempt_at <= ?
         AND attempt_count < max_attempts
         ORDER BY next_attempt_at ASC
         LIMIT ?`).all(now, now, batchSize);
        if (!rows.length) {
            db.exec('COMMIT');
            return [];
        }
        const ids = rows.map((r) => r.id);
        const placeholders = ids.map(() => '?').join(', ');
        db.prepare(`UPDATE webhook_deliveries
       SET status = 'processing',
           lock_owner = ?,
           lock_expires_at = ?,
           updated_at = ?
       WHERE id IN (${placeholders})`).run(workerId, lockExpiresAt, now, ...ids);
        // RETURNING seria ideal mas usamos SELECT separado para compatibilidade
        const claimedRows = db.prepare(`SELECT * FROM webhook_deliveries WHERE id IN (${placeholders}) ORDER BY next_attempt_at ASC`).all(...ids);
        db.exec('COMMIT');
        return claimedRows.map(toDelivery);
    }
    catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}
export function markDeliveryAttemptStart(id, attemptCount) {
    const now = Date.now();
    getDb().prepare('UPDATE webhook_deliveries SET attempt_count = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?').run(attemptCount, now, now, id);
}
export function markDeliverySuccess(id, responseStatus, workerId) {
    const now = Date.now();
    // CAS: só atualiza se lock_owner bater (evita write após lock roubado)
    getDb().prepare(`UPDATE webhook_deliveries
     SET status = 'delivered', response_status = ?, delivered_at = ?, updated_at = ?,
         lock_owner = NULL, lock_expires_at = NULL
     WHERE id = ? AND (lock_owner = ? OR lock_owner IS NULL)`).run(responseStatus, now, now, id, workerId);
}
export function markDeliveryRetry(id, lastError, responseStatus, attemptCount, workerId) {
    const nextAttemptAt = Date.now() + computeRetryDelayMs(attemptCount);
    const now = Date.now();
    getDb().prepare(`UPDATE webhook_deliveries
     SET status = 'pending',
         last_error = ?,
         response_status = ?,
         lock_owner = NULL,
         lock_expires_at = NULL,
         next_attempt_at = ?,
         updated_at = ?
     WHERE id = ? AND (lock_owner = ? OR lock_owner IS NULL)`).run(lastError, responseStatus, nextAttemptAt, now, id, workerId);
}
export function markDeliveryFailed(id, lastError, responseStatus, workerId) {
    const now = Date.now();
    getDb().prepare(`UPDATE webhook_deliveries
     SET status = 'failed',
         last_error = ?,
         response_status = ?,
         lock_owner = NULL,
         lock_expires_at = NULL,
         updated_at = ?
     WHERE id = ? AND (lock_owner = ? OR lock_owner IS NULL)`).run(lastError, responseStatus, now, id, workerId);
}
export function renewDeliveryLock(id, workerId, lockMs) {
    const now = Date.now();
    const newExpiry = now + lockMs;
    const result = getDb().prepare(`UPDATE webhook_deliveries
     SET lock_expires_at = ?, updated_at = ?
     WHERE id = ? AND lock_owner = ? AND status = 'processing'`).run(newExpiry, now, id, workerId);
    return Number(result.changes ?? 0) > 0;
}
export function getWebhookMetrics() {
    const db = getDb();
    const hooksRow = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM webhooks').get();
    const statusRows = db.prepare('SELECT status, COUNT(*) AS count FROM webhook_deliveries GROUP BY status').all();
    const oldestPendingRow = db.prepare("SELECT created_at FROM webhook_deliveries WHERE status IN ('pending','processing') ORDER BY created_at ASC LIMIT 1").get();
    const counts = { pending: 0, processing: 0, delivered: 0, failed: 0 };
    for (const row of statusRows) {
        const status = String(row.status);
        const count = Number(row.count ?? 0);
        if (status === 'pending')
            counts.pending = count;
        else if (status === 'processing')
            counts.processing = count;
        else if (status === 'delivered')
            counts.delivered = count;
        else if (status === 'failed')
            counts.failed = count;
    }
    const oldestCreatedAt = oldestPendingRow?.created_at == null ? null : Number(oldestPendingRow.created_at);
    const oldestPendingAgeSeconds = oldestCreatedAt ? Math.max(0, Math.floor((Date.now() - oldestCreatedAt) / 1000)) : 0;
    return {
        webhooksTotal: Number(hooksRow.total ?? 0),
        webhooksEnabled: Number(hooksRow.enabled ?? 0),
        deliveriesPending: counts.pending,
        deliveriesProcessing: counts.processing,
        deliveriesDelivered: counts.delivered,
        deliveriesFailed: counts.failed,
        deliveriesTotal: counts.pending + counts.processing + counts.delivered + counts.failed,
        oldestPendingAgeSeconds,
    };
}
export function loadWebhookForDelivery(id) {
    return getWebhook(id);
}
export function buildWebhookHeaders(delivery, secret, payloadBody) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers = {
        'content-type': 'application/json',
        'x-webhook-event': delivery.event,
        'x-webhook-delivery-id': delivery.id,
        'x-webhook-webhook-id': delivery.webhookId,
        'x-webhook-attempt': String(delivery.attemptCount),
        'x-webhook-timestamp': timestamp,
    };
    if (secret) {
        headers['x-webhook-signature'] = computeSignature(secret, timestamp, payloadBody);
    }
    return headers;
}
export function getWebhookDefaultSecret() {
    return config.webhooks.defaultSecret;
}
/** Força inicialização do DB e timer de cleanup — chamar no boot antes do worker. */
export function initWebhooksService() {
    getDb();
    scheduleCleanupTimer();
}
