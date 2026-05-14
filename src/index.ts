import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import swaggerUiDist from 'swagger-ui-dist';
// These routers still live as the real implementation under dist/routes.
// Importing them directly here keeps `tsx src/index.ts` and future builds using
// the working handlers instead of the stub files that remain in src/routes.
import instancesRouter from '../dist/routes/instances.js';
import messagesRouter from '../dist/routes/messages.js';
import webhooksRouter from '../dist/routes/webhooks.js';
import chatsRouter from '../dist/routes/chats.js';
import opsRouter from '../dist/routes/ops.js';
import integrationsRouter from './routes/integrations.js';
import { openApiSpec } from './docs/openapi.js';
import { renderSwaggerUiHtml } from './docs/swagger-ui.js';
import { requestContext } from './middleware/request-context.js';
import { sendError } from './utils/api-response.js';
import { getAllInstances, getInstance, getInstanceChatMediaBinary, reconnectPreviouslyActiveInstances, disconnectInstance } from './services/whatsapp.js';
import { getWebhookMetrics } from './services/webhooks.js';
import { requireApiKey } from './middleware/api-auth.js';
import { normalizeInstanceName } from './utils/helpers.js';
import { verifyMediaUrlToken } from './utils/media-signature.js';
import { log } from './utils/logger.js';
import { parseChatwootWebhook, type ChatwootWebhookPayload, invalidateConversationCache, autoCreateChatwootInbox, syncHistoryToChatwoot, normalizeChatwootWebhookSlug } from './services/chatwoot-bridge.js';
import { getSyncProgress, requestSyncCancel, isMessageSynced, isSyncRunning } from './services/chatwoot-sync-store.js';
import { getInstanceIntegrations, findInstanceByWebhookSlug } from './services/integrations.js';
import { isChatwootOriginated } from './services/chatwoot-tracking.js';
import { startMessageCleanupJob, stopMessageCleanupJob } from './services/message-store.js';

function extractChatwootSourceIds(payload: ChatwootWebhookPayload): string[] {
  const attrs = payload.content_attributes ?? {};
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) candidates.add(trimmed);
  };

  add(payload.source_id);
  add(attrs['source_id']);
  add(attrs['whatsapp_message_id']);

  if (Array.isArray(payload.conversation?.messages) && payload.id != null) {
    const current = payload.conversation.messages.find((message) => String(message?.id ?? '') === String(payload.id));
    add(current?.source_id);
  }

  return [...candidates];
}

async function dispatchChatwootActionToWhatsApp(
  instance: string,
  integrationCfg: ReturnType<typeof getInstanceIntegrations>['chatwoot'],
  action: NonNullable<ReturnType<typeof parseChatwootWebhook>>,
): Promise<{ ok: boolean; error?: string }> {
  const { jid, text, attachments, replyToId, agentName } = action;
  const signedAgentName = integrationCfg.signMessages ? agentName : undefined;
  const resolveMediaUrl = (mediaUrl: string): string => {
    const trimmed = String(mediaUrl || '').trim();
    if (!trimmed) return trimmed;
    if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:')) return trimmed;
    if (trimmed.startsWith('/') && integrationCfg.baseUrl) {
      return `${String(integrationCfg.baseUrl).replace(/\/$/, '')}${trimmed}`;
    }
    return trimmed;
  };

  if (attachments && attachments.length > 0) {
    for (let i = 0; i < attachments.length; i++) {
      const attachment = attachments[i];
      const send = await sendInstanceMediaMessage(instance, jid, {
        mediaUrl: resolveMediaUrl(attachment.mediaUrl),
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        caption: i === 0 ? text || undefined : undefined,
        replyToId,
        agentName: signedAgentName,
        signDelimiter: integrationCfg.signDelimiter,
      });
      if (!send.ok) return { ok: false, error: send.error || 'failed_to_send_media' };
    }
    return { ok: true };
  }

  if (text) {
    const send = await sendInstanceTextMessage(instance, jid, text, {
      replyToId,
      agentName: signedAgentName,
      signDelimiter: integrationCfg.signDelimiter,
    });
    if (!send.ok) return { ok: false, error: send.error || 'failed_to_send_text' };
  }

  return { ok: true };
}
import { sendInstanceTextMessage, sendInstanceMediaMessage } from './services/whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const swaggerAssetsDir = swaggerUiDist.getAbsoluteFSPath();
const hasConfiguredApiKeys = Boolean(config.apiKey.trim() || config.apiKeysJson.trim());

if (process.env.NODE_ENV === 'production' && !hasConfiguredApiKeys) {
  throw new Error('API key configuration is required in production. Set API_KEY or API_KEYS_JSON.');
}

if (!hasConfiguredApiKeys) {
  log.security.warn('API auth DESABILITADA — configure API_KEY ou API_KEYS_JSON para proteger a API.');
}

if (!config.security.chatwootWebhookSecret.trim()) {
  log.security.warn(
    'CHATWOOT_WEBHOOK_SECRET não configurado — endpoint /chatwoot/webhook aceita requests sem autenticação.'
  );
}

const app = express();

app.disable('x-powered-by');
app.set('etag', false);
app.set('trust proxy', config.security.trustProxy);

type RateEntry = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateEntry>();

function clientIp(req: express.Request): string {
  if (config.security.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function isValidChatwootWebhookSecret(req: express.Request): boolean {
  const expected = config.security.chatwootWebhookSecret.trim();
  if (!expected) return true;
  const headerSecret = String(req.header('x-chatwoot-secret') ?? req.header('x-webhook-secret') ?? '').trim();
  const querySecret = String(req.query.secret ?? '').trim();
  const authSecret = String(req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  const provided = headerSecret || querySecret || authSecret;
  return provided ? safeEqual(provided, expected) : false;
}

function rateLimit(scope: string, max: number, windowMs: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${scope}:${clientIp(req)}`;
    const now = Date.now();
    if (rateBuckets.size > 5000) {
      for (const [bucketKey, entry] of rateBuckets) {
        if (entry.resetAt <= now) rateBuckets.delete(bucketKey);
      }
    }
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return sendError(res, 429, 'rate_limited');
    }
    bucket.count += 1;
    return next();
  };
}

const docsAuth = hasConfiguredApiKeys && !config.security.publicDocsEnabled
  ? requireApiKey(['ops:read'])
  : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
const metricsAuth = hasConfiguredApiKeys && !config.security.publicMetricsEnabled
  ? requireApiKey(['ops:read'])
  : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
const readyAuth = hasConfiguredApiKeys && !config.security.publicReadyEnabled
  ? requireApiKey(['ops:read'])
  : (_req: express.Request, _res: express.Response, next: express.NextFunction) => next();
const webhookLimiter = rateLimit('chatwoot-webhook', config.security.webhookRateLimitMax, config.security.webhookRateLimitWindowMs);
const apiLimiter = rateLimit('api', config.security.apiRateLimitMax, config.security.apiRateLimitWindowMs);

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');
  if (config.security.hstsEnabled) {
    res.setHeader('Strict-Transport-Security', `max-age=${config.security.hstsMaxAgeSeconds}; includeSubDomains`);
  }
  next();
});

app.use((req, res, next) => {
  if (req.path === '/docs' || req.path.startsWith('/docs-assets')) return next();
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' data: blob: https:",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
    ].join('; ')
  );
  next();
});

app.use(requestContext);
app.use(express.json({ limit: '2mb' }));
app.use('/v1', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Beyound', requestId: res.locals?.requestId });
});

app.get('/ready', readyAuth, (_req, res) => {
  const instances = getAllInstances();
  const connectedInstances = instances.filter((instance) => instance.status === 'connected').length;
  res.json({ ok: true, service: 'Beyound', requestId: res.locals?.requestId, connectedInstances, totalInstances: instances.length });
});

app.get('/metrics', metricsAuth, (_req, res) => {
  const webhook = getWebhookMetrics();
  const lines = [
    '# HELP webhook_webhooks_total Total number of webhooks',
    '# TYPE webhook_webhooks_total gauge',
    `webhook_webhooks_total ${webhook.webhooksTotal}`,
    '# HELP webhook_webhooks_enabled Number of enabled webhooks',
    '# TYPE webhook_webhooks_enabled gauge',
    `webhook_webhooks_enabled ${webhook.webhooksEnabled}`,
    '# HELP webhook_deliveries_total Total webhook deliveries by status',
    '# TYPE webhook_deliveries_total gauge',
    `webhook_deliveries_total{status="pending"} ${webhook.deliveriesPending}`,
    `webhook_deliveries_total{status="processing"} ${webhook.deliveriesProcessing}`,
    `webhook_deliveries_total{status="delivered"} ${webhook.deliveriesDelivered}`,
    `webhook_deliveries_total{status="failed"} ${webhook.deliveriesFailed}`,
    '# HELP webhook_oldest_pending_age_seconds Age in seconds of oldest pending/processing delivery',
    '# TYPE webhook_oldest_pending_age_seconds gauge',
    `webhook_oldest_pending_age_seconds ${webhook.oldestPendingAgeSeconds}`,
  ];

  res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(`${lines.join('\n')}\n`);
});

app.get('/openapi.json', docsAuth, (_req, res) => {
  res.json(openApiSpec);
});

app.use('/docs-assets', docsAuth, express.static(swaggerAssetsDir));

app.get('/docs', docsAuth, (_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(renderSwaggerUiHtml('/openapi.json'));
});

app.get('/v1/media/:instance/:mediaId', (req, res) => {
  const instance = normalizeInstanceName(req.params.instance);
  const mediaId = String(req.params.mediaId ?? '').trim();
  if (!instance || !mediaId) {
    return sendError(res, 400, 'invalid_media_request');
  }

  const verification = verifyMediaUrlToken(
    config.media.signedUrlSecret,
    instance,
    mediaId,
    req.query.exp,
    req.query.sig
  );
  if (!verification.ok) {
    const verErr = (verification as { ok: false; error: string }).error;
    return sendError(res, verErr === 'expired_token' ? 410 : 401, verErr);
  }

  const media = getInstanceChatMediaBinary(instance, mediaId);
  if (!media.ok || !media.bytes || !media.mimeType) {
    return sendError(res, 404, 'media_not_found');
  }

  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('Content-Type', media.mimeType);
  return res.status(200).send(media.bytes);
});

// ─── Chatwoot webhook por slug: compatível com Evolution API (/chatwoot/webhook/:slug) ─
// URL format: http://host/chatwoot/webhook/ScheerAdv
app.post('/chatwoot/webhook/:slug', webhookLimiter, async (req, res) => {
  const slug = normalizeChatwootWebhookSlug(req.params.slug);
  if (!slug) {
    return res.status(400).json({ ok: false, error: 'invalid_slug' });
  }
  if (!req.is('application/json')) {
    return res.status(415).json({ ok: false, error: 'invalid_content_type' });
  }
  if (!isValidChatwootWebhookSecret(req)) {
    return res.status(401).json({ ok: false, error: 'invalid_webhook_secret' });
  }

  // Resolve slug → instance name
  const instance = findInstanceByWebhookSlug(slug);
  if (!instance) {
    // Return 200 anyway to avoid Chatwoot retries for unconfigured slugs
    return res.status(200).json({ ok: true, note: 'slug_not_mapped' });
  }

  let integrationCfg;
  try {
    const integrations = getInstanceIntegrations(instance);
    integrationCfg = integrations.chatwoot;
  } catch {
    return res.status(503).json({ ok: false, error: 'failed_to_load_integration' });
  }

  if (!integrationCfg.enabled) return res.status(200).json({ ok: true, ignored: true, reason: 'integration_disabled' });

  const body = (req.body ?? {}) as ChatwootWebhookPayload;
  const action = parseChatwootWebhook(body);
  if (!action) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Se a mensagem tem source_id (WhatsApp message ID), significa que veio do
  // WhatsApp e foi espelhada por nós no Chatwoot. O Chatwoot dispara o webhook
  // de volta — mas NÃO devemos reenviar ao WhatsApp (seria duplicação).
  const sourceIds = extractChatwootSourceIds(body);
  if (sourceIds.some((sourceId) => isChatwootOriginated(sourceId) || isMessageSynced(instance, sourceId))) {
    return res.status(200).json({ ok: true, ignored: true, reason: 'whatsapp_originated' });
  }

  try {
    const result = await dispatchChatwootActionToWhatsApp(instance, integrationCfg, action);
    if (!result.ok) {
      return res.status(503).json({ ok: false, error: result.error || 'whatsapp_dispatch_failed' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    log.chatwoot.child(instance).error('chatwoot-webhook-slug dispatch_error', err);
    return res.status(503).json({ ok: false, error: 'whatsapp_dispatch_failed' });
  }
});

// ─── Chatwoot webhook: sem API key (Chatwoot não suporta custom headers no webhook) ───
app.post('/v1/integrations/:instance/chatwoot/webhook', webhookLimiter, async (req, res) => {
  const instance = normalizeInstanceName(req.params.instance);
  if (!instance) {
    return res.status(400).json({ ok: false, error: 'invalid_instance_name' });
  }
  if (!req.is('application/json')) {
    return res.status(415).json({ ok: false, error: 'invalid_content_type' });
  }
  if (!isValidChatwootWebhookSecret(req)) {
    return res.status(401).json({ ok: false, error: 'invalid_webhook_secret' });
  }

  // Validate integration is enabled for this instance
  let integrationCfg;
  try {
    const integrations = getInstanceIntegrations(instance);
    integrationCfg = integrations.chatwoot;
  } catch {
    return res.status(503).json({ ok: false, error: 'failed_to_load_integration' });
  }

  if (!integrationCfg.enabled) return res.status(200).json({ ok: true, ignored: true, reason: 'integration_disabled' });

  const body = (req.body ?? {}) as ChatwootWebhookPayload;
  const action = parseChatwootWebhook(body);
  if (!action) {
    return res.status(200).json({ ok: true, ignored: true });
  }

  // Se a mensagem tem source_id (WhatsApp message ID), significa que veio do
  // WhatsApp e foi espelhada por nós no Chatwoot. O Chatwoot dispara o webhook
  // de volta — mas NÃO devemos reenviar ao WhatsApp (seria duplicação).
  const sourceIds = extractChatwootSourceIds(body);
  if (sourceIds.some((sourceId) => isChatwootOriginated(sourceId) || isMessageSynced(instance, sourceId))) {
    return res.status(200).json({ ok: true, ignored: true, reason: 'whatsapp_originated' });
  }

  try {
    const result = await dispatchChatwootActionToWhatsApp(instance, integrationCfg, action);
    if (!result.ok) {
      return res.status(503).json({ ok: false, error: result.error || 'whatsapp_dispatch_failed' });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    log.chatwoot.child(instance).error('chatwoot-webhook dispatch_error', err);
    return res.status(503).json({ ok: false, error: 'whatsapp_dispatch_failed' });
  }
});

// ─── Chatwoot cache invalidation: protegido por API key ───────────────────────
app.post('/v1/integrations/:instance/chatwoot/invalidate-cache', requireApiKey(['integrations:*']), (req, res) => {
  const instance = normalizeInstanceName(req.params.instance);
  if (!instance) {
    return res.status(400).json({ ok: false, error: 'invalid_instance_name' });
  }
  invalidateConversationCache(instance);
  return res.json({ ok: true, invalidated: true });
});

// ─── Force Auto Create: cria inbox no Chatwoot manualmente (com API key) ─────
app.post('/v1/integrations/:instance/chatwoot/autocreate', requireApiKey(['integrations:*']), async (req, res) => {
  const instance = normalizeInstanceName(req.params.instance);
  if (!instance) {
    return res.status(400).json({ ok: false, error: 'invalid_instance_name' });
  }
  try {
    const result = await autoCreateChatwootInbox(instance, undefined, true);
    return res.json({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: msg });
  }
});

app.post('/v1/integrations/:instance/chatwoot/sync-history', requireApiKey(['integrations:*']), async (req, res) => {
  const instance = normalizeInstanceName(req.params.instance);
  if (!instance) {
    return res.status(400).json({ ok: false, error: 'invalid_instance_name' });
  }
  const { jid, limit } = req.body as { jid?: string; limit?: number };
  const limitPerChat = typeof limit === 'number' && limit > 0 ? Math.min(limit, 2000) : 200;

  if (isSyncRunning(instance)) {
    return res.status(409).json({ ok: false, error: 'sync_already_running' });
  }

  const integrationCfg = getInstanceIntegrations(instance).chatwoot;
  if (!integrationCfg.enabled || !integrationCfg.baseUrl || !integrationCfg.accountId || !integrationCfg.apiAccessToken) {
    return res.status(400).json({ ok: false, error: 'chatwoot_not_configured' });
  }
  if (integrationCfg.importMessages === false) {
    return res.status(400).json({ ok: false, error: 'chatwoot_import_messages_disabled' });
  }
  if (getInstance(instance)?.status !== 'connected') {
    return res.status(409).json({ ok: false, error: 'instance_not_connected' });
  }

  // Run in background and return immediately so UI can poll /sync-status
  void (async () => {
    try {
      await syncHistoryToChatwoot(instance, jid ?? undefined, limitPerChat, 'manual');
    } catch (err) {
      log.chatwoot.child(instance).error('sync-history manual_sync_error', err);
    }
  })();
  return res.json({ ok: true, started: true, message: 'Sync started in background — poll /sync-status for progress' });
});

app.get('/v1/integrations/:instance/chatwoot/sync-status', requireApiKey(['integrations:*']), (req, res) => {
  const instance = normalizeInstanceName(req.params.instance);
  if (!instance) {
    return res.status(400).json({ ok: false, error: 'invalid_instance_name' });
  }
  const progress = getSyncProgress(instance);
  return res.json({ ok: true, progress });
});

app.post('/v1/integrations/:instance/chatwoot/sync-cancel', requireApiKey(['integrations:*']), (req, res) => {
  const instance = normalizeInstanceName(req.params.instance);
  if (!instance) {
    return res.status(400).json({ ok: false, error: 'invalid_instance_name' });
  }
  const cancelled = requestSyncCancel(instance);
  return res.json({ ok: true, cancelled });
});

// API key só nas rotas /v1 (a interface em / carrega sem key)
app.use('/v1/instances', apiLimiter, requireApiKey(['instances:*']), instancesRouter);
app.use('/v1/messages', apiLimiter, requireApiKey(['messages:send']), messagesRouter);
app.use('/v1/webhooks', apiLimiter, requireApiKey(['webhooks:*']), webhooksRouter);
app.use('/v1/chats', apiLimiter, requireApiKey(['chats:*']), chatsRouter);
app.use('/v1/ops', apiLimiter, requireApiKey(['ops:read']), opsRouter);
app.use('/v1/integrations', apiLimiter, requireApiKey(['integrations:*']), integrationsRouter);

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, {
  dotfiles: 'ignore',
  index: false,
  setHeaders: (res, filePath) => {
    if (/\.html?$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
  },
}));
app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    return sendError(res, 400, 'invalid_json');
  }
  const message = err instanceof Error ? err.message : 'unexpected_error';
  return sendError(res, 500, 'internal_server_error', message);
});

const httpServer = app.listen(config.port, () => {
  log.app.success(`API pronta  →  http://localhost:${config.port}`);
  log.app.info(`Interface   →  http://localhost:${config.port}`);
  if (hasConfiguredApiKeys) {
    log.app.info('API auth ativa — envie o header: x-api-key');
  }

  if (config.webhooks.embeddedWorkerEnabled) {
    void import('./workers/webhook-delivery-worker.js')
      .then(() => {
        log.webhook.success('Worker de webhooks iniciado no processo da API (embedded_worker=true)');
      })
      .catch((error) => {
        log.webhook.error('Falha ao iniciar worker de webhooks embutido', error);
      });
  }

  void reconnectPreviouslyActiveInstances(config.authFolder)
    .then((summary) => {
      if (summary.attempted === 0) {
        log.whatsapp.info('startup_autoconnect — nenhuma instância para restaurar');
        return;
      }
      log.whatsapp.info(
        `startup_autoconnect  attempted=${summary.attempted}  started=${summary.started}  failed=${summary.failed.length}`
      );
      if (summary.failed.length > 0) {
        log.whatsapp.error(`Instâncias que falharam no autoconectar: ${summary.failed.join(', ')}`);
      }
    })
    .catch((error) => {
      log.whatsapp.error('Erro crítico no startup_autoconnect', error);
    });

  // Inicia job de cleanup de mensagens antigas (TTL)
  startMessageCleanupJob();
});

// ---------------------------------------------------------------------------
// Graceful shutdown — SIGTERM (docker stop) e SIGINT (Ctrl+C)
// ---------------------------------------------------------------------------
async function gracefulShutdown(signal: string): Promise<void> {
  log.app.info(`${signal} recebido — iniciando graceful shutdown`);

  // 1. Para de aceitar novas conexões HTTP
  httpServer.close(() => {
    log.app.info('Servidor HTTP fechado');
  });

  // 2. Para job de cleanup de mensagens
  stopMessageCleanupJob();

  // 3. Desconecta instâncias WhatsApp graciosamente (persiste estado)
  const instances = getAllInstances();
  if (instances.length > 0) {
    log.whatsapp.info(`Desconectando ${instances.length} instância(s)...`);
    for (const ctx of instances) {
      try {
        disconnectInstance(ctx.name, { keepAutostart: true });
      } catch (err) {
        log.whatsapp.warn(`Erro ao desconectar instância ${ctx.name}: ${err}`);
      }
    }
  }

  // 4. Aguarda um breve período para operações em voo finalizarem
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));
  log.app.info('Shutdown concluído');
  process.exit(0);
}

let _shuttingDown = false;
function onSignal(signal: string): void {
  if (_shuttingDown) return;
  _shuttingDown = true;
  gracefulShutdown(signal).catch((err) => {
    log.app.error('Erro durante graceful shutdown', err);
    process.exit(1);
  });
}

process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));
