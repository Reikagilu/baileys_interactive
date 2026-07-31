import dotenv from 'dotenv';
import { parseConfiguredWaWebVersion } from './utils/wa-web-version.js';

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
  /** URL pública deste servidor (usada para gerar URLs de webhook e mídia). */
  serverUrl: (process.env.SERVER_URL ?? '').replace(/\/$/, ''),
  apiKey: process.env.API_KEY ?? '',
  apiKeysJson: process.env.API_KEYS_JSON ?? '',
  authFolder: process.env.AUTH_FOLDER ?? 'auth',
  whatsapp: {
    // Nunca apague a auth automaticamente por heurística, a menos que seja
    // explicitamente habilitado. Isso evita logout por falso positivo em
    // estados transitórios/corrupção parcial de arquivos.
    autoResetCorruptAuth: parseBoolean(process.env.WHATSAPP_AUTO_RESET_CORRUPT_AUTH, false),
    // Empty means online discovery; an explicit value pins every new socket.
    webVersion: parseConfiguredWaWebVersion(process.env.WHATSAPP_WEB_VERSION),
  },
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
    trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
    hstsEnabled: parseBoolean(process.env.HSTS_ENABLED, false),
    hstsMaxAgeSeconds: parseNumber(process.env.HSTS_MAX_AGE_SECONDS, 15552000, 0),
    allowPrivateNetworkWebhooks: parseBoolean(process.env.ALLOW_PRIVATE_NETWORK_WEBHOOKS, false),
    allowPrivateNetworkIntegrations: parseBoolean(process.env.ALLOW_PRIVATE_NETWORK_INTEGRATIONS, false),
    chatwootWebhookSecret: process.env.CHATWOOT_WEBHOOK_SECRET ?? '',
    apiRateLimitWindowMs: parseNumber(process.env.API_RATE_LIMIT_WINDOW_MS, 60_000, 1000),
    apiRateLimitMax: parseNumber(process.env.API_RATE_LIMIT_MAX, 1200, 1),
    webhookRateLimitWindowMs: parseNumber(process.env.WEBHOOK_RATE_LIMIT_WINDOW_MS, 60_000, 1000),
    webhookRateLimitMax: parseNumber(process.env.WEBHOOK_RATE_LIMIT_MAX, 240, 1),
    publicDocsEnabled: parseBoolean(process.env.PUBLIC_DOCS_ENABLED, false),
    publicMetricsEnabled: parseBoolean(process.env.PUBLIC_METRICS_ENABLED, false),
    publicReadyEnabled: parseBoolean(process.env.PUBLIC_READY_ENABLED, false),
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
  messages: {
    dbPath: process.env.MESSAGES_DB_PATH ?? 'data/messages.sqlite',
    maxPerChat: parseNumber(process.env.MESSAGES_MAX_PER_CHAT, 2000, 100),
    // TTL para mensagens do histórico (padrão: 30 dias). Após este período,
    // mensagens antigas são automaticamente excluídas para liberar espaço.
    // Use 0 para desabilitar (nunca expira).
    historyTtlDays: parseNumber(process.env.MESSAGES_HISTORY_TTL_DAYS, 30, 0),
    // Intervalo de cleanup (padrão: a cada 6 horas)
    cleanupIntervalMs: parseNumber(process.env.MESSAGES_CLEANUP_INTERVAL_MS, 6 * 60 * 60 * 1000, 60 * 60 * 1000),
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
    includeIncomingMediaBase64: parseBoolean(
      process.env.WEBHOOK_INCLUDE_INCOMING_MEDIA_BASE64 ?? process.env.WEBHOOK_INCLUDE_INCOMING_AUDIO_BASE64,
      false
    ),
    includeIncomingVideoBase64: parseBoolean(process.env.WEBHOOK_INCLUDE_INCOMING_VIDEO_BASE64, false),
    incomingMediaBase64MaxBytes: parseNumber(
      process.env.WEBHOOK_INCOMING_MEDIA_BASE64_MAX_BYTES ?? process.env.WEBHOOK_INCOMING_AUDIO_BASE64_MAX_BYTES,
      2 * 1024 * 1024,
      1024
    ),
    incomingVideoBase64MaxBytes: parseNumber(process.env.WEBHOOK_INCOMING_VIDEO_BASE64_MAX_BYTES, 5 * 1024 * 1024, 1024),
  },
  idempotency: {
    enabled: parseBoolean(process.env.IDEMPOTENCY_ENABLED, true),
    ttlMs: parseNumber(process.env.IDEMPOTENCY_TTL_MS, 10 * 60 * 1000, 1000),
    maxEntries: parseNumber(process.env.IDEMPOTENCY_MAX_ENTRIES, 5000, 100),
  },
  media: {
    signedUrlSecret: process.env.MEDIA_SIGNED_URL_SECRET ?? process.env.API_KEY ?? 'change-me-in-production',
    signedUrlTtlSeconds: parseNumber(process.env.MEDIA_SIGNED_URL_TTL_SECONDS, 3600, 60),
  },
  chatwoot: {
    /**
     * Limite máximo de bytes para baixar uma mídia recebida do WhatsApp
     * e encaminhá-la ao Chatwoot. Default 25MB cobre vídeos e áudios
     * típicos do WhatsApp. Mídias acima desse limite são puladas e o
     * Chatwoot recebe apenas o texto/legenda (se houver).
     */
    mediaMaxBytes: parseNumber(process.env.CHATWOOT_MEDIA_MAX_BYTES, 25 * 1024 * 1024, 1024),
    /** Timeout HTTP para requests ao Chatwoot (uploads podem demorar). */
    requestTimeoutMs: parseNumber(process.env.CHATWOOT_REQUEST_TIMEOUT_MS, 30_000, 1000),
    /** Retries para falhas transitórias como timeout/429/5xx. */
    requestRetries: parseNumber(process.env.CHATWOOT_REQUEST_RETRIES, 2, 0),
    /** Pausa entre retries ao Chatwoot. */
    requestRetryDelayMs: parseNumber(process.env.CHATWOOT_REQUEST_RETRY_DELAY_MS, 1500, 0),
    /** Atraso entre mensagens durante sync de histórico (anti-overload). */
    syncMessageDelayMs: parseNumber(process.env.CHATWOOT_SYNC_MSG_DELAY_MS, 250, 0),
    /** A cada N mensagens o sync faz uma pausa maior para aliviar I/O. */
    syncBatchSize: parseNumber(process.env.CHATWOOT_SYNC_BATCH_SIZE, 50, 1),
    /** Duração da pausa entre batches. */
    syncBatchPauseMs: parseNumber(process.env.CHATWOOT_SYNC_BATCH_PAUSE_MS, 1000, 0),
  },
  limits: {
    maxButtons: 3,
    maxCarouselCards: 10,
    maxListSections: 10,
    maxListRowsPerSection: 10,
    maxPollOptions: 12,
    chatInlineMediaMaxBytes: parseNumber(process.env.CHAT_INLINE_MEDIA_MAX_BYTES, 1536 * 1024, 1024),
    chatVideoMaxBytes: parseNumber(process.env.CHAT_VIDEO_MAX_BYTES, 8 * 1024 * 1024, 1024),
    chatMediaRetentionMs: parseNumber(
      process.env.CHAT_MEDIA_RETENTION_MS ?? process.env.CHAT_MEDIA_TTL_MS,
      90 * 24 * 60 * 60 * 1000,
      60 * 1000
    ),
  },
} as const;

export type Config = typeof config;
