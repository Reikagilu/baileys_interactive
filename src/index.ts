import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import swaggerUiDist from 'swagger-ui-dist';
import instancesRouter from './routes/instances.js';
import messagesRouter from './routes/messages.js';
import webhooksRouter from './routes/webhooks.js';
import chatsRouter from './routes/chats.js';
import opsRouter from './routes/ops.js';
import integrationsRouter from './routes/integrations.js';
import { openApiSpec } from './docs/openapi.js';
import { renderSwaggerUiHtml } from './docs/swagger-ui.js';
import { requestContext } from './middleware/request-context.js';
import { sendError } from './utils/api-response.js';
import { getAllInstances, getInstanceChatMediaBinary, reconnectPreviouslyActiveInstances } from './services/whatsapp.js';
import { getWebhookMetrics } from './services/webhooks.js';
import { requireApiKey } from './middleware/api-auth.js';
import { normalizeInstanceName } from './utils/helpers.js';
import { verifyMediaUrlToken } from './utils/media-signature.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const swaggerAssetsDir = swaggerUiDist.getAbsoluteFSPath();
const hasConfiguredApiKeys = Boolean(config.apiKey.trim() || config.apiKeysJson.trim());

if (process.env.NODE_ENV === 'production' && !hasConfiguredApiKeys) {
  throw new Error('API key configuration is required in production. Set API_KEY or API_KEYS_JSON.');
}

if (!hasConfiguredApiKeys) {
  console.warn('[security] API auth disabled: configure API_KEY or API_KEYS_JSON.');
}

const app = express();

app.set('etag', false);

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

app.get('/ready', (_req, res) => {
  const instances = getAllInstances();
  const connectedInstances = instances.filter((instance) => instance.status === 'connected').length;
  res.json({ ok: true, service: 'Beyound', requestId: res.locals?.requestId, connectedInstances, totalInstances: instances.length });
});

app.get('/metrics', (_req, res) => {
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

app.get('/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

app.use('/docs-assets', express.static(swaggerAssetsDir));

app.get('/docs', (_req, res) => {
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
    return sendError(res, verification.error === 'expired_token' ? 410 : 401, verification.error);
  }

  const media = getInstanceChatMediaBinary(instance, mediaId);
  if (!media.ok || !media.bytes || !media.mimeType) {
    return sendError(res, 404, 'media_not_found');
  }

  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('Content-Type', media.mimeType);
  return res.status(200).send(media.bytes);
});

// API key só nas rotas /v1 (a interface em / carrega sem key)
app.use('/v1/instances', requireApiKey(['instances:*']), instancesRouter);
app.use('/v1/messages', requireApiKey(['messages:send']), messagesRouter);
app.use('/v1/webhooks', requireApiKey(['webhooks:*']), webhooksRouter);
app.use('/v1/chats', requireApiKey(['chats:*']), chatsRouter);
app.use('/v1/ops', requireApiKey(['ops:read']), opsRouter);
app.use('/v1/integrations', requireApiKey(['integrations:*']), integrationsRouter);

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    return sendError(res, 400, 'invalid_json');
  }
  const message = err instanceof Error ? err.message : 'unexpected_error';
  return sendError(res, 500, 'internal_server_error', message);
});

app.listen(config.port, () => {
  console.log(`[Beyound] API rodando em http://localhost:${config.port}`);
  console.log(`[Beyound] Interface: http://localhost:${config.port}`);
  console.log('[Beyound] API auth ativa. Use header: x-api-key');

  if (config.webhooks.embeddedWorkerEnabled) {
    void import('./workers/webhook-delivery-worker.js')
      .then(() => {
        console.log('[webhook-worker] embedded_worker_enabled=true (running in API process)');
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[webhook-worker] embedded_worker_failed ${message}`);
      });
  }

  void reconnectPreviouslyActiveInstances(config.authFolder)
    .then((summary) => {
      if (summary.attempted === 0) {
        console.log('[whatsapp] startup_autoconnect nenhum para restaurar');
        return;
      }
      console.log(
        `[whatsapp] startup_autoconnect attempted=${summary.attempted} started=${summary.started} failed=${summary.failed.length}`
      );
      if (summary.failed.length > 0) {
        console.log(`[whatsapp] startup_autoconnect_failed ${summary.failed.join(', ')}`);
      }
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[whatsapp] startup_autoconnect_error ${message}`);
    });
});
