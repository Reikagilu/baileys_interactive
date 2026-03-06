import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { listRecentAuditEvents } from '../services/audit-log.js';
import { getWebhookMetrics } from '../services/webhooks.js';
import { getAllInstances } from '../services/whatsapp.js';
import { sendOk } from '../utils/api-response.js';

const router = Router();

router.get('/alerts', (_req: Request, res: Response) => {
  const webhook = getWebhookMetrics();
  const instances = getAllInstances();
  const connected = instances.filter((instance) => instance.status === 'connected').length;

  const alerts: Array<Record<string, unknown>> = [];

  if (webhook.deliveriesPending > config.alerts.maxPendingDeliveries) {
    alerts.push({
      id: 'webhook.pending.high',
      severity: 'high',
      metric: 'webhook.deliveriesPending',
      value: webhook.deliveriesPending,
      threshold: config.alerts.maxPendingDeliveries,
      message: 'Pending webhook deliveries exceed threshold.',
      recommendation: 'Scale workers and verify target endpoints latency.',
    });
  }

  if (webhook.deliveriesFailed > config.alerts.maxFailedDeliveries) {
    alerts.push({
      id: 'webhook.failed.high',
      severity: 'high',
      metric: 'webhook.deliveriesFailed',
      value: webhook.deliveriesFailed,
      threshold: config.alerts.maxFailedDeliveries,
      message: 'Failed webhook deliveries (DLQ) exceed threshold.',
      recommendation: 'Inspect DLQ endpoint and retry after fixing receiver issues.',
    });
  }

  if (webhook.oldestPendingAgeSeconds > config.alerts.maxOldestPendingAgeSeconds) {
    alerts.push({
      id: 'webhook.pending.age.high',
      severity: 'medium',
      metric: 'webhook.oldestPendingAgeSeconds',
      value: webhook.oldestPendingAgeSeconds,
      threshold: config.alerts.maxOldestPendingAgeSeconds,
      message: 'Oldest pending delivery age is above threshold.',
      recommendation: 'Check worker health, lock contention, and queue throughput.',
    });
  }

  if (connected < config.alerts.minConnectedInstances) {
    alerts.push({
      id: 'instances.connected.low',
      severity: 'medium',
      metric: 'instances.connected',
      value: connected,
      threshold: config.alerts.minConnectedInstances,
      message: 'Connected instances are below minimum expected level.',
      recommendation: 'Review instance sessions and reconnection strategy.',
    });
  }

  return sendOk(res, {
    status: alerts.length ? 'degraded' : 'healthy',
    alerts,
    snapshot: {
      connectedInstances: connected,
      totalInstances: instances.length,
      webhook,
    },
  });
});

router.get('/audit', (req: Request, res: Response) => {
  const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
  return sendOk(res, {
    events: listRecentAuditEvents(limit),
  });
});

export default router;
