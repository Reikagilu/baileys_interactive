import { config } from '../config.js';
import { validateOutboundUrl } from '../utils/url-security.js';
import {
  buildWebhookHeaders,
  claimDueDeliveries,
  getWebhookDefaultSecret,
  loadWebhookForDelivery,
  markDeliveryAttemptStart,
  markDeliveryFailed,
  markDeliveryRetry,
  markDeliverySuccess,
  purgeDeadLetterDeliveries,
} from '../services/webhooks.js';
import { randomUUID } from 'node:crypto';

let processing = false;
const workerId = `worker-${randomUUID()}`;
let lastPurgeAt = 0;

async function processBatch(): Promise<void> {
  if (processing) return;
  processing = true;

  try {
    const batch = claimDueDeliveries(config.webhooks.workerBatchSize, workerId, config.webhooks.workerLockMs);
    for (const delivery of batch) {
      const webhook = loadWebhookForDelivery(delivery.webhookId);
      if (!webhook || !webhook.enabled) {
        markDeliveryFailed(delivery.id, 'webhook_not_available', null);
        continue;
      }

      const urlValidation = validateOutboundUrl(webhook.url, {
        allowPrivateNetwork: config.security.allowPrivateNetworkWebhooks,
      });
      if (!urlValidation.ok) {
        markDeliveryFailed(delivery.id, `webhook_url_blocked:${urlValidation.error ?? 'invalid_url'}`, null);
        continue;
      }

      const attemptCount = delivery.attemptCount + 1;
      markDeliveryAttemptStart(delivery.id, attemptCount);

      const payloadBody = JSON.stringify(delivery.payload);
      const secret = webhook.secret || getWebhookDefaultSecret();
      const headers = buildWebhookHeaders({ ...delivery, attemptCount }, secret, payloadBody);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.webhooks.requestTimeoutMs);

      try {
        const response = await fetch(urlValidation.normalizedUrl ?? webhook.url, {
          method: 'POST',
          headers,
          body: payloadBody,
          signal: controller.signal,
        });

        if (response.status >= 200 && response.status < 300) {
          markDeliverySuccess(delivery.id, response.status);
          continue;
        }

        const reason = `http_${response.status}`;
        if (attemptCount >= delivery.maxAttempts) {
          markDeliveryFailed(delivery.id, reason, response.status);
        } else {
          markDeliveryRetry(delivery.id, reason, response.status, attemptCount);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (attemptCount >= delivery.maxAttempts) {
          markDeliveryFailed(delivery.id, reason, null);
        } else {
          markDeliveryRetry(delivery.id, reason, null, attemptCount);
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    const now = Date.now();
    if (now - lastPurgeAt >= config.webhooks.purgeIntervalMs) {
      const purged = purgeDeadLetterDeliveries(config.webhooks.dlqRetentionMs);
      if (purged > 0) {
        console.log(`[webhook-worker] dlq_purged=${purged}`);
      }
      lastPurgeAt = now;
    }
  } finally {
    processing = false;
  }
}

setInterval(() => {
  processBatch().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[webhook-worker] batch_failed: ${message}`);
  });
}, config.webhooks.workerPollMs);

console.log(
  `[webhook-worker] started id=${workerId} poll=${config.webhooks.workerPollMs}ms batch=${config.webhooks.workerBatchSize} lock=${config.webhooks.workerLockMs}ms`
);
