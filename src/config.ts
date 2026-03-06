import dotenv from 'dotenv';

dotenv.config();

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNumber(value: string | undefined, fallback: number, min?: number): number {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (typeof min === 'number' && parsed < min) return min;
  return parsed;
}

export const config = {
  port: parseInt(process.env.PORT ?? '8787', 10),
  apiKey: process.env.API_KEY ?? '',
  apiKeysJson: process.env.API_KEYS_JSON ?? '',
  authFolder: process.env.AUTH_FOLDER ?? 'auth',
  audit: {
    logPath: process.env.AUDIT_LOG_PATH ?? 'data/audit.log',
    maxInMemoryEvents: parseNumber(process.env.AUDIT_MAX_IN_MEMORY_EVENTS, 500, 10),
  },
  alerts: {
    maxPendingDeliveries: parseNumber(process.env.ALERT_MAX_PENDING_DELIVERIES, 1000, 1),
    maxFailedDeliveries: parseNumber(process.env.ALERT_MAX_FAILED_DELIVERIES, 200, 1),
    maxOldestPendingAgeSeconds: parseNumber(process.env.ALERT_MAX_OLDEST_PENDING_AGE_SECONDS, 300, 1),
    minConnectedInstances: parseNumber(process.env.ALERT_MIN_CONNECTED_INSTANCES, 1, 0),
  },
  logging: {
    requestLogsEnabled: parseBoolean(process.env.REQUEST_LOGS_ENABLED, true),
  },
  security: {
    allowPrivateNetworkWebhooks: parseBoolean(process.env.ALLOW_PRIVATE_NETWORK_WEBHOOKS, false),
    allowPrivateNetworkIntegrations: parseBoolean(process.env.ALLOW_PRIVATE_NETWORK_INTEGRATIONS, false),
  },
  pairing: {
    enabled: parseBoolean(process.env.PAIRING_CODE_ENABLED, true),
    defaultCountryCode: (process.env.PAIRING_DEFAULT_COUNTRY_CODE ?? '55').replace(/\D/g, ''),
    forceFreshSession: parseBoolean(process.env.PAIRING_FORCE_FRESH_SESSION, false),
  },
  integrations: {
    dbPath: process.env.INTEGRATIONS_DB_PATH ?? 'data/integrations.sqlite',
    requestTimeoutMs: parseNumber(process.env.INTEGRATIONS_REQUEST_TIMEOUT_MS, 8000, 1000),
  },
  webhooks: {
    dbPath: process.env.WEBHOOK_DB_PATH ?? 'data/webhooks.sqlite',
    maxAttempts: parseNumber(process.env.WEBHOOK_MAX_ATTEMPTS, 5, 1),
    retryBaseDelayMs: parseNumber(process.env.WEBHOOK_RETRY_BASE_DELAY_MS, 2000, 250),
    retryMaxDelayMs: parseNumber(process.env.WEBHOOK_RETRY_MAX_DELAY_MS, 30000, 500),
    requestTimeoutMs: parseNumber(process.env.WEBHOOK_REQUEST_TIMEOUT_MS, 8000, 1000),
    maxDeliveryHistory: parseNumber(process.env.WEBHOOK_MAX_DELIVERY_HISTORY, 5000, 100),
    defaultSecret: process.env.WEBHOOK_DEFAULT_SECRET ?? '',
    workerPollMs: parseNumber(process.env.WEBHOOK_WORKER_POLL_MS, 500, 100),
    workerBatchSize: parseNumber(process.env.WEBHOOK_WORKER_BATCH_SIZE, 25, 1),
    workerLockMs: parseNumber(process.env.WEBHOOK_WORKER_LOCK_MS, 30000, 1000),
    embeddedWorkerEnabled: parseBoolean(process.env.WEBHOOK_EMBEDDED_WORKER_ENABLED, true),
    dlqRetentionMs: parseNumber(process.env.WEBHOOK_DLQ_RETENTION_MS, 7 * 24 * 60 * 60 * 1000, 60 * 1000),
    purgeIntervalMs: parseNumber(process.env.WEBHOOK_PURGE_INTERVAL_MS, 60000, 1000),
  },
  idempotency: {
    enabled: parseBoolean(process.env.IDEMPOTENCY_ENABLED, true),
    ttlMs: parseNumber(process.env.IDEMPOTENCY_TTL_MS, 10 * 60 * 1000, 1000),
    maxEntries: parseNumber(process.env.IDEMPOTENCY_MAX_ENTRIES, 5000, 100),
  },
  limits: {
    maxButtons: 3,
    maxCarouselCards: 10,
    maxListSections: 10,
    maxListRowsPerSection: 10,
    maxPollOptions: 12,
  },
} as const;

export type Config = typeof config;
