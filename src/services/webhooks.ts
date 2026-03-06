import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

export type WebhookEventName =
  | 'connection.update'
  | 'messages.upsert'
  | 'messages.update'
  | 'message-receipt.update'
  | 'chats.update'
  | 'groups.update';

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  events: WebhookEventName[];
  instance?: string;
  enabled: boolean;
  secret?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  webhookName: string;
  webhookUrl: string;
  event: WebhookEventName;
  instance?: string;
  status: 'pending' | 'processing' | 'delivered' | 'failed';
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastAttemptAt?: number;
  deliveredAt?: number;
  lastError?: string;
  responseStatus?: number;
  lockOwner?: string;
  lockExpiresAt?: number;
  payload: unknown;
  createdAt: number;
  updatedAt: number;
}

const allowedEventSet = new Set<WebhookEventName>([
  'connection.update',
  'messages.upsert',
  'messages.update',
  'message-receipt.update',
  'chats.update',
  'groups.update',
]);

const db = openDatabase(config.webhooks.dbPath);
setupSchemaWithRetry();

function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
}

function isDatabaseLockedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('database is locked');
}

function setupSchemaWithRetry(): void {
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      setupSchema();
      return;
    } catch (error) {
      if (!isDatabaseLockedError(error) || attempt === maxAttempts) {
        throw error;
      }
      sleepSync(100 * attempt);
    }
  }
}

function openDatabase(dbPath: string): DatabaseSync {
  const resolved = path.resolve(process.cwd(), dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const database = new DatabaseSync(resolved);
  database.exec('PRAGMA busy_timeout = 5000;');
  try {
    database.exec('PRAGMA journal_mode = WAL;');
  } catch {
    // in highly concurrent start scenarios this can be temporarily locked
  }
  try {
    database.exec('PRAGMA synchronous = NORMAL;');
  } catch {
    // optional performance pragma
  }
  return database;
}

function setupSchema(): void {
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

  ensureColumn('webhook_deliveries', 'lock_owner', 'TEXT');
  ensureColumn('webhook_deliveries', 'lock_expires_at', 'INTEGER');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled);
    CREATE INDEX IF NOT EXISTS idx_deliveries_status_due ON webhook_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_created ON webhook_deliveries(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deliveries_lock ON webhook_deliveries(lock_owner, lock_expires_at);
  `);
}

function ensureColumn(tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<Record<string, unknown>>;
  if (columns.some((column) => String(column.name) === columnName)) {
    return;
  }

  try {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes('duplicate column name')) {
      return;
    }
    throw error;
  }
}

function parseEvents(raw: string): WebhookEventName[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeWebhookEvents(parsed);
  } catch {
    return [];
  }
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toWebhook(row: Record<string, unknown>): WebhookConfig {
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

function toDelivery(row: Record<string, unknown>): WebhookDelivery {
  return {
    id: String(row.id),
    webhookId: String(row.webhook_id),
    webhookName: String(row.webhook_name),
    webhookUrl: String(row.webhook_url),
    event: String(row.event) as WebhookEventName,
    instance: row.instance == null ? undefined : String(row.instance),
    status: String(row.status) as WebhookDelivery['status'],
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

function toEventEnvelope(event: WebhookEventName, payload: unknown, instance?: string): Record<string, unknown> {
  return {
    id: randomUUID(),
    event,
    instance: instance || null,
    emittedAt: new Date().toISOString(),
    payload,
  };
}

function computeRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  const delay = config.webhooks.retryBaseDelayMs * 2 ** exponent;
  return Math.min(config.webhooks.retryMaxDelayMs, delay);
}

function computeSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function cleanupDeliveryHistory(): void {
  const countRow = db.prepare('SELECT COUNT(*) AS c FROM webhook_deliveries').get() as Record<string, unknown>;
  const total = Number(countRow.c ?? 0);
  const overBy = total - config.webhooks.maxDeliveryHistory;
  if (overBy <= 0) return;

  db.prepare(
    `DELETE FROM webhook_deliveries
     WHERE id IN (
       SELECT id FROM webhook_deliveries
       WHERE status NOT IN ('pending', 'processing')
       ORDER BY created_at ASC
       LIMIT ?
     )`
  ).run(overBy);
}

export function normalizeWebhookEvents(events: unknown): WebhookEventName[] {
  if (!Array.isArray(events)) return [];
  const normalized = events
    .map((eventName) => String(eventName || '').trim() as WebhookEventName)
    .filter((eventName) => allowedEventSet.has(eventName));
  return Array.from(new Set(normalized));
}

export function createWebhook(input: {
  name: string;
  url: string;
  events: unknown;
  instance?: string;
  enabled?: boolean;
  secret?: string;
}): WebhookConfig {
  const now = Date.now();
  const id = randomUUID();
  const events = normalizeWebhookEvents(input.events);

  db.prepare(
    `INSERT INTO webhooks (id, name, url, events, instance, enabled, secret, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.name,
    input.url,
    JSON.stringify(events),
    input.instance ?? null,
    input.enabled ?? true ? 1 : 0,
    input.secret ?? null,
    now,
    now
  );

  return {
    id,
    name: input.name,
    url: input.url,
    events,
    instance: input.instance,
    enabled: input.enabled ?? true,
    secret: input.secret,
    createdAt: now,
    updatedAt: now,
  };
}

export function listWebhooks(): WebhookConfig[] {
  const rows = db.prepare('SELECT * FROM webhooks ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(toWebhook);
}

export function getWebhook(id: string): WebhookConfig | null {
  const row = db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? toWebhook(row) : null;
}

export function updateWebhook(
  id: string,
  update: Partial<Pick<WebhookConfig, 'name' | 'url' | 'instance' | 'enabled' | 'secret'>> & { events?: unknown }
): WebhookConfig | null {
  const current = getWebhook(id);
  if (!current) return null;

  const now = Date.now();
  const next: WebhookConfig = {
    ...current,
    name: update.name ?? current.name,
    url: update.url ?? current.url,
    instance: update.instance ?? current.instance,
    enabled: update.enabled ?? current.enabled,
    secret: update.secret ?? current.secret,
    events: update.events !== undefined ? normalizeWebhookEvents(update.events) : current.events,
    updatedAt: now,
  };

  db.prepare(
    `UPDATE webhooks
     SET name = ?, url = ?, events = ?, instance = ?, enabled = ?, secret = ?, updated_at = ?
     WHERE id = ?`
  ).run(next.name, next.url, JSON.stringify(next.events), next.instance ?? null, next.enabled ? 1 : 0, next.secret ?? null, now, id);

  return next;
}

export function deleteWebhook(id: string): boolean {
  const result = db.prepare('DELETE FROM webhooks WHERE id = ?').run(id);
  return Number(result.changes ?? 0) > 0;
}

export function listSupportedWebhookEvents(): WebhookEventName[] {
  return [...allowedEventSet.values()];
}

function selectEligibleWebhooks(event: WebhookEventName, instance?: string): WebhookConfig[] {
  const eventMatcher = `%"${event}"%`;

  if (instance) {
    const rows = db
      .prepare(
        `SELECT * FROM webhooks
         WHERE enabled = 1
           AND events LIKE ?
           AND (instance IS NULL OR instance = ?)
         ORDER BY created_at DESC`
      )
      .all(eventMatcher, instance) as Record<string, unknown>[];
    return rows.map(toWebhook);
  }

  const rows = db
    .prepare(
      `SELECT * FROM webhooks
       WHERE enabled = 1
         AND events LIKE ?
         AND instance IS NULL
       ORDER BY created_at DESC`
    )
    .all(eventMatcher) as Record<string, unknown>[];
  return rows.map(toWebhook);
}

function enqueueDelivery(webhook: WebhookConfig, event: WebhookEventName, payload: unknown, instance?: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO webhook_deliveries (
      id, webhook_id, webhook_name, webhook_url, event, instance, status, attempt_count,
      max_attempts, next_attempt_at, payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    webhook.id,
    webhook.name,
    webhook.url,
    event,
    instance ?? null,
    'pending',
    0,
    config.webhooks.maxAttempts,
    now,
    JSON.stringify(toEventEnvelope(event, payload, instance)),
    now,
    now
  );
}

export function emitWebhookEvent(event: WebhookEventName, payload: unknown, instance?: string): { queued: number } {
  const hooks = selectEligibleWebhooks(event, instance);

  for (const webhook of hooks) {
    enqueueDelivery(webhook, event, payload, instance);
  }

  cleanupDeliveryHistory();
  return { queued: hooks.length };
}

export function enqueueWebhookTestDelivery(
  webhookId: string,
  event: WebhookEventName,
  payload: unknown
): { queued: number; reason?: 'webhook_not_found' | 'webhook_disabled' } {
  const webhook = getWebhook(webhookId);
  if (!webhook) {
    return { queued: 0, reason: 'webhook_not_found' };
  }
  if (!webhook.enabled) {
    return { queued: 0, reason: 'webhook_disabled' };
  }

  enqueueDelivery(webhook, event, payload, webhook.instance);
  cleanupDeliveryHistory();
  return { queued: 1 };
}

export function listWebhookDeliveries(filters?: {
  webhookId?: string;
  status?: 'pending' | 'processing' | 'delivered' | 'failed';
  limit?: number;
}): WebhookDelivery[] {
  const conditions: string[] = [];
  const params: Array<string> = [];

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
  const rows = db
    .prepare(`SELECT * FROM webhook_deliveries ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, limit) as Record<string, unknown>[];

  return rows.map(toDelivery);
}

export function listDeadLetterDeliveries(limit = 100): WebhookDelivery[] {
  return listWebhookDeliveries({ status: 'failed', limit });
}

export function purgeDeadLetterDeliveries(olderThanMs: number): number {
  const cutoff = Date.now() - Math.max(olderThanMs, 0);
  const result = db.prepare("DELETE FROM webhook_deliveries WHERE status = 'failed' AND updated_at < ?").run(cutoff);
  return Number(result.changes ?? 0);
}

export function getWebhookDelivery(id: string): WebhookDelivery | null {
  const row = db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? toDelivery(row) : null;
}

export function retryWebhookDelivery(id: string): WebhookDelivery | null {
  const delivery = getWebhookDelivery(id);
  if (!delivery) return null;
  const maxAttempts = delivery.attemptCount >= delivery.maxAttempts ? delivery.attemptCount + 1 : delivery.maxAttempts;
  const now = Date.now();

  db.prepare(
    `UPDATE webhook_deliveries
     SET status = 'pending',
         lock_owner = NULL,
         lock_expires_at = NULL,
         max_attempts = ?,
         next_attempt_at = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(maxAttempts, now, now, id);

  return getWebhookDelivery(id);
}

export function claimDueDeliveries(batchSize: number, workerId: string, lockMs: number): WebhookDelivery[] {
  const now = Date.now();
  const lockExpiresAt = now + Math.max(lockMs, 1000);

  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = db
      .prepare(
        `SELECT id FROM webhook_deliveries
         WHERE (
            status = 'pending'
            OR (status = 'processing' AND COALESCE(lock_expires_at, 0) <= ?)
         )
         AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC
         LIMIT ?`
      )
      .all(now, now, batchSize) as Array<{ id: string }>;

    if (!rows.length) {
      db.exec('COMMIT');
      return [];
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');

    db.prepare(
      `UPDATE webhook_deliveries
       SET status = 'processing',
           lock_owner = ?,
           lock_expires_at = ?,
           updated_at = ?
       WHERE id IN (${placeholders})`
    ).run(workerId, lockExpiresAt, now, ...ids);

    const claimedRows = db
      .prepare(`SELECT * FROM webhook_deliveries WHERE id IN (${placeholders}) ORDER BY next_attempt_at ASC`)
      .all(...ids) as Record<string, unknown>[];

    db.exec('COMMIT');
    return claimedRows.map(toDelivery);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function markDeliveryAttemptStart(id: string, attemptCount: number): void {
  const now = Date.now();
  db.prepare('UPDATE webhook_deliveries SET attempt_count = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?').run(attemptCount, now, now, id);
}

export function markDeliverySuccess(id: string, responseStatus: number): void {
  const now = Date.now();
  db.prepare(
    `UPDATE webhook_deliveries
     SET status = 'delivered', response_status = ?, delivered_at = ?, updated_at = ?
         , lock_owner = NULL, lock_expires_at = NULL
     WHERE id = ?`
  ).run(responseStatus, now, now, id);
}

export function markDeliveryRetry(id: string, lastError: string, responseStatus: number | null, attemptCount: number): void {
  const nextAttemptAt = Date.now() + computeRetryDelayMs(attemptCount);
  const now = Date.now();
  db.prepare(
    `UPDATE webhook_deliveries
     SET status = 'pending',
         last_error = ?,
         response_status = ?,
         lock_owner = NULL,
         lock_expires_at = NULL,
         next_attempt_at = ?,
         updated_at = ?
     WHERE id = ?`
  ).run(lastError, responseStatus, nextAttemptAt, now, id);
}

export function markDeliveryFailed(id: string, lastError: string, responseStatus: number | null): void {
  const now = Date.now();
  db.prepare(
    `UPDATE webhook_deliveries
     SET status = 'failed',
         last_error = ?,
         response_status = ?,
         lock_owner = NULL,
         lock_expires_at = NULL,
         updated_at = ?
     WHERE id = ?`
  ).run(lastError, responseStatus, now, id);
}

export function getWebhookMetrics(): {
  webhooksTotal: number;
  webhooksEnabled: number;
  deliveriesPending: number;
  deliveriesProcessing: number;
  deliveriesDelivered: number;
  deliveriesFailed: number;
  deliveriesTotal: number;
  oldestPendingAgeSeconds: number;
} {
  const hooksRow = db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled FROM webhooks').get() as Record<string, unknown>;
  const statusRows = db.prepare('SELECT status, COUNT(*) AS count FROM webhook_deliveries GROUP BY status').all() as Array<Record<string, unknown>>;
  const oldestPendingRow = db
    .prepare("SELECT created_at FROM webhook_deliveries WHERE status IN ('pending','processing') ORDER BY created_at ASC LIMIT 1")
    .get() as Record<string, unknown> | undefined;

  const counts = {
    pending: 0,
    processing: 0,
    delivered: 0,
    failed: 0,
  };

  for (const row of statusRows) {
    const status = String(row.status);
    const count = Number(row.count ?? 0);
    if (status === 'pending') counts.pending = count;
    if (status === 'processing') counts.processing = count;
    if (status === 'delivered') counts.delivered = count;
    if (status === 'failed') counts.failed = count;
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

export function loadWebhookForDelivery(id: string): WebhookConfig | null {
  return getWebhook(id);
}

export function buildWebhookHeaders(delivery: WebhookDelivery, secret: string, payloadBody: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers: Record<string, string> = {
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

export function getWebhookDefaultSecret(): string {
  return config.webhooks.defaultSecret;
}
