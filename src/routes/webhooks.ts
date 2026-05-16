import { Router } from 'express';
import { config } from '../config.js';
import { writeAuditEvent } from '../services/audit-log.js';
import {
    createWebhook,
    deleteWebhook,
    enqueueWebhookTestDelivery,
    getWebhook,
    getWebhookDelivery,
    listDeadLetterDeliveries,
    listSupportedWebhookEvents,
    listWebhookDeliveries,
    listWebhooks,
    normalizeWebhookEvents,
    purgeDeadLetterDeliveries,
    retryWebhookDelivery,
    updateWebhook,
} from '../services/webhooks.js';
import { sendError, sendOk } from '../utils/api-response.js';
import { validateOutboundUrl } from '../utils/url-security.js';

const router = Router();

const MAX_LIST_LIMIT = 500;

router.get('/events', (_req, res) => sendOk(res, { events: listSupportedWebhookEvents() }));

router.get('/', (_req, res) => sendOk(res, { webhooks: listWebhooks() }));

router.get('/deliveries', (req, res) => {
    const statusRaw = String(req.query.status ?? '').trim();
    const webhookIdRaw = String(req.query.webhookId ?? '').trim();
    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const validStatuses = ['pending', 'processing', 'delivered', 'failed'] as const;
    const status = validStatuses.includes(statusRaw as (typeof validStatuses)[number]) ? statusRaw as (typeof validStatuses)[number] : undefined;
    const webhookId = webhookIdRaw || undefined;
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIST_LIMIT) : 100;
    return sendOk(res, { deliveries: listWebhookDeliveries({ status, webhookId, limit }) });
});

router.get('/dlq', (req, res) => {
    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIST_LIMIT) : 100;
    return sendOk(res, { deliveries: listDeadLetterDeliveries(limit) });
});

router.post('/dlq/purge', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // Exigir olderThanMs explícito para evitar purge acidental de toda DLQ
    if (body.olderThanMs === undefined || !Number.isFinite(Number(body.olderThanMs))) {
        return sendError(res, 400, 'missing_older_than_ms', 'Provide olderThanMs (milliseconds) to purge entries older than that threshold.');
    }
    const olderThanMs = Math.max(0, Number(body.olderThanMs));
    const purged = purgeDeadLetterDeliveries(olderThanMs);
    writeAuditEvent(req, res, { action: 'webhooks.dlq.purge', details: { olderThanMs, purged } });
    return sendOk(res, { purged, olderThanMs });
});

router.post('/', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? '').trim().slice(0, 200);
    const urlRaw = String(body.url ?? '').trim();

    if (!name || !urlRaw) {
        return sendError(res, 400, 'missing_name_or_url', 'Provide both name and url.');
    }

    const validation = validateOutboundUrl(urlRaw, {
        allowPrivateNetwork: config.security.allowPrivateNetworkWebhooks,
    });
    if (!validation.ok) {
        return sendError(res, 400, 'invalid_url', 'Webhook URL blocked by security policy.', {
            reason: validation.error,
            details: validation.details,
        });
    }

    const url = validation.normalizedUrl ?? urlRaw;
    const events = normalizeWebhookEvents(Array.isArray(body.events) ? body.events : []);
    if (!events.length) {
        return sendError(res, 400, 'missing_events', 'Provide at least one supported event.');
    }

    const webhook = createWebhook({
        name, url, events,
        instance: typeof body.instance === 'string' ? body.instance : undefined,
        enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
        secret: typeof body.secret === 'string' ? body.secret.slice(0, 256) : undefined,
    });

    writeAuditEvent(req, res, {
        action: 'webhooks.create',
        target: webhook.id,
        details: { events: webhook.events, instance: webhook.instance ?? null },
    });
    return sendOk(res, { webhook }, 201);
});

router.patch('/:id', (req, res) => {
    const { id } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Construir patch explícito (evita mass-assignment)
    const patch: Parameters<typeof updateWebhook>[1] = {};

    if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 200);

    if (body.url !== undefined) {
        const urlRaw = String(body.url).trim();
        const validation = validateOutboundUrl(urlRaw, {
            allowPrivateNetwork: config.security.allowPrivateNetworkWebhooks,
        });
        if (!validation.ok) {
            return sendError(res, 400, 'invalid_url', 'Webhook URL blocked by security policy.', {
                reason: validation.error,
            });
        }
        patch.url = validation.normalizedUrl ?? urlRaw;
    }

    if (body.events !== undefined) {
        const events = normalizeWebhookEvents(Array.isArray(body.events) ? body.events : []);
        if (!events.length) {
            return sendError(res, 400, 'missing_events', 'Provide at least one supported event.');
        }
        patch.events = events;
    }

    if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
    // Usar 'in' para detectar remoção explícita (null) de instance/secret
    if ('instance' in body) patch.instance = body.instance != null ? String(body.instance).trim() : undefined;
    if ('secret' in body) patch.secret = body.secret != null ? String(body.secret).slice(0, 256) : undefined;

    const webhook = updateWebhook(id, patch);
    if (!webhook) return sendError(res, 404, 'webhook_not_found');

    writeAuditEvent(req, res, {
        action: 'webhooks.update',
        target: id,
        details: { updatedFields: Object.keys(patch) },
    });
    return sendOk(res, { webhook });
});

router.delete('/:id', (req, res) => {
    const deleted = deleteWebhook(req.params.id);
    if (!deleted) return sendError(res, 404, 'webhook_not_found');
    writeAuditEvent(req, res, { action: 'webhooks.delete', target: req.params.id });
    return sendOk(res, { deleted: true });
});

router.get('/:id/deliveries', (req, res) => {
    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIST_LIMIT) : 100;
    const webhook = getWebhook(req.params.id);
    if (!webhook) return sendError(res, 404, 'webhook_not_found');
    return sendOk(res, { webhook, deliveries: listWebhookDeliveries({ webhookId: webhook.id, limit }) });
});

router.post('/deliveries/:deliveryId/retry', (req, res) => {
    const delivery = retryWebhookDelivery(req.params.deliveryId);
    if (!delivery) return sendError(res, 404, 'delivery_not_found');
    writeAuditEvent(req, res, {
        action: 'webhooks.delivery.retry',
        target: req.params.deliveryId,
        details: { webhookId: delivery.webhookId },
    });
    return sendOk(res, { delivery });
});

router.get('/deliveries/:deliveryId', (req, res) => {
    const delivery = getWebhookDelivery(req.params.deliveryId);
    if (!delivery) return sendError(res, 404, 'delivery_not_found');
    return sendOk(res, { delivery });
});

router.post('/:id/test', (req, res) => {
    const webhook = getWebhook(req.params.id);
    if (!webhook) return sendError(res, 404, 'webhook_not_found');
    if (!webhook.enabled) return sendError(res, 400, 'webhook_disabled', 'Enable webhook before running test.');

    const body = (req.body ?? {}) as Record<string, unknown>;
    const supportedEvents = listSupportedWebhookEvents();
    const requestedEvent = String(body.event ?? '').trim();
    const event = supportedEvents.includes(requestedEvent)
        ? requestedEvent
        : (webhook.events[0] || 'connection.update');

    // Apenas aceitar body.data; nunca usar req.body inteiro como fallback (evita amplification)
    const payload = {
        source: 'manual_test',
        webhookId: webhook.id,
        webhookName: webhook.name,
        // body.data com limite de tamanho
        data: body.data !== undefined ? body.data : {},
    };

    const queued = enqueueWebhookTestDelivery(webhook.id, event, payload);
    if (queued.queued === 0) {
        return sendError(res, 400, queued.reason === 'webhook_disabled' ? 'webhook_disabled' : 'webhook_not_found');
    }

    writeAuditEvent(req, res, {
        action: 'webhooks.test.enqueue',
        target: webhook.id,
        details: { queued: queued.queued, event },
    });
    return sendOk(res, { queued: queued.queued, webhookId: webhook.id, event });
});

export default router;
