import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import {
  createWebhook,
  deleteWebhook,
  enqueueWebhookTestDelivery,
  getWebhook,
  getWebhookDelivery,
  listSupportedWebhookEvents,
  listWebhookDeliveries,
  listWebhooks,
  listDeadLetterDeliveries,
  purgeDeadLetterDeliveries,
  normalizeWebhookEvents,
  retryWebhookDelivery,
  updateWebhook,
} from '../services/webhooks.js';
import { sendError, sendOk } from '../utils/api-response.js';
import { writeAuditEvent } from '../services/audit-log.js';
import { validateOutboundUrl } from '../utils/url-security.js';

const router = Router();

router.get('/events', (_req: Request, res: Response) => {
  return sendOk(res, { events: listSupportedWebhookEvents() });
});

router.get('/', (_req: Request, res: Response) => {
  return sendOk(res, { webhooks: listWebhooks() });
});

router.get('/deliveries', (req: Request, res: Response) => {
  const statusRaw = String(req.query.status ?? '').trim();
  const webhookIdRaw = String(req.query.webhookId ?? '').trim();
  const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);

  const status =
    statusRaw === 'pending' || statusRaw === 'processing' || statusRaw === 'delivered' || statusRaw === 'failed'
      ? statusRaw
      : undefined;
  const webhookId = webhookIdRaw || undefined;
  const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

  return sendOk(res, {
    deliveries: listWebhookDeliveries({ status, webhookId, limit }),
  });
});

router.get('/dlq', (req: Request, res: Response) => {
  const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
  return sendOk(res, {
    deliveries: listDeadLetterDeliveries(limit),
  });
});

router.post('/dlq/purge', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { olderThanMs?: number };
  const olderThanMs = Number.isFinite(body.olderThanMs) ? Number(body.olderThanMs) : undefined;
  const purged = purgeDeadLetterDeliveries(olderThanMs ?? 0);
  writeAuditEvent(req, res, {
    action: 'webhooks.dlq.purge',
    details: { olderThanMs: olderThanMs ?? 0, purged },
  });
  return sendOk(res, { purged, olderThanMs: olderThanMs ?? 0 });
});

router.post('/', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    name?: string;
    url?: string;
    events?: unknown;
    instance?: string;
    enabled?: boolean;
    secret?: string;
  };

  const name = String(body.name ?? '').trim();
  const urlRaw = String(body.url ?? '').trim();
  const validation = validateOutboundUrl(urlRaw, {
    allowPrivateNetwork: config.security.allowPrivateNetworkWebhooks,
  });
  if (!name || !urlRaw) {
    return sendError(res, 400, 'missing_name_or_url', 'Provide both name and url.');
  }
  if (!validation.ok) {
    return sendError(res, 400, 'invalid_url', 'Webhook URL blocked by security policy.', {
      reason: validation.error,
      details: validation.details,
    });
  }
  const url = validation.normalizedUrl ?? urlRaw;

  const events = normalizeWebhookEvents(body.events);
  if (!events.length) {
    return sendError(res, 400, 'missing_events', 'Provide at least one supported event.');
  }

  const webhook = createWebhook({
    name,
    url,
    events,
    instance: body.instance,
    enabled: body.enabled,
    secret: body.secret,
  });

  writeAuditEvent(req, res, {
    action: 'webhooks.create',
    target: webhook.id,
    details: { events: webhook.events, instance: webhook.instance ?? null },
  });

  return sendOk(res, { webhook }, 201);
});

router.patch('/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const body = (req.body ?? {}) as {
    name?: string;
    url?: string;
    events?: unknown;
    instance?: string;
    enabled?: boolean;
    secret?: string;
  };

  if (body.url !== undefined) {
    const urlRaw = String(body.url).trim();
    const validation = validateOutboundUrl(urlRaw, {
      allowPrivateNetwork: config.security.allowPrivateNetworkWebhooks,
    });
    if (!validation.ok) {
      return sendError(res, 400, 'invalid_url', 'Webhook URL blocked by security policy.', {
        reason: validation.error,
        details: validation.details,
      });
    }
    body.url = validation.normalizedUrl ?? urlRaw;
  }

  if (body.events !== undefined) {
    const events = normalizeWebhookEvents(body.events);
    if (!events.length) {
      return sendError(res, 400, 'missing_events', 'Provide at least one supported event.');
    }
    body.events = events;
  }

  const webhook = updateWebhook(id, body);
  if (!webhook) {
    return sendError(res, 404, 'webhook_not_found');
  }

  writeAuditEvent(req, res, {
    action: 'webhooks.update',
    target: id,
    details: { updatedFields: Object.keys(body) },
  });

  return sendOk(res, { webhook });
});

router.delete('/:id', (req: Request, res: Response) => {
  const deleted = deleteWebhook(req.params.id);
  if (!deleted) {
    return sendError(res, 404, 'webhook_not_found');
  }
  writeAuditEvent(req, res, {
    action: 'webhooks.delete',
    target: req.params.id,
  });
  return sendOk(res, { deleted: true });
});

router.get('/:id/deliveries', (req: Request, res: Response) => {
  const webhook = getWebhook(req.params.id);
  if (!webhook) {
    return sendError(res, 404, 'webhook_not_found');
  }
  return sendOk(res, {
    webhook,
    deliveries: listWebhookDeliveries({ webhookId: webhook.id, limit: 100 }),
  });
});

router.post('/deliveries/:deliveryId/retry', (req: Request, res: Response) => {
  const delivery = retryWebhookDelivery(req.params.deliveryId);
  if (!delivery) {
    return sendError(res, 404, 'delivery_not_found');
  }
  writeAuditEvent(req, res, {
    action: 'webhooks.delivery.retry',
    target: req.params.deliveryId,
    details: { webhookId: delivery.webhookId },
  });

  return sendOk(res, { delivery });
});

router.get('/deliveries/:deliveryId', (req: Request, res: Response) => {
  const delivery = getWebhookDelivery(req.params.deliveryId);
  if (!delivery) {
    return sendError(res, 404, 'delivery_not_found');
  }
  return sendOk(res, { delivery });
});

router.post('/:id/test', (req: Request, res: Response) => {
  const webhook = getWebhook(req.params.id);
  if (!webhook) {
    return sendError(res, 404, 'webhook_not_found');
  }

  if (!webhook.enabled) {
    return sendError(res, 400, 'webhook_disabled', 'Enable webhook before running test.');
  }

  const body = (req.body ?? {}) as { event?: string; data?: unknown };
  const supportedEvents = listSupportedWebhookEvents();
  const requestedEvent = String(body.event ?? '').trim();
  const event = (supportedEvents.includes(requestedEvent as (typeof supportedEvents)[number])
    ? requestedEvent
    : webhook.events[0] || 'connection.update') as (typeof supportedEvents)[number];

  const payload = {
    source: 'manual_test',
    webhookId: webhook.id,
    webhookName: webhook.name,
    data: body.data ?? req.body ?? {},
  };

  const queued = enqueueWebhookTestDelivery(webhook.id, event, payload);
  if (queued.queued === 0) {
    const reason = queued.reason === 'webhook_disabled' ? 'webhook_disabled' : 'webhook_not_found';
    return sendError(res, 400, reason, 'Unable to queue webhook test delivery.');
  }

  writeAuditEvent(req, res, {
    action: 'webhooks.test.enqueue',
    target: webhook.id,
    details: { queued: queued.queued, event },
  });

  return sendOk(res, {
    queued: queued.queued,
    webhookId: webhook.id,
    event,
  });
});

export default router;
