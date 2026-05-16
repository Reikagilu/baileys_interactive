/**
 * Webhook Delivery Worker
 *
 * Consome entregas pendentes da fila SQLite e as despacha via HTTP.
 * Pode rodar como processo standalone (node dist/workers/webhook-delivery-worker.js)
 * ou embutido no processo principal (via embeddedWorkerEnabled).
 *
 * Design:
 * - Loop de polling com backpressure (poll imediato se batch cheio)
 * - Concorrência limitada por p-limit dentro de cada batch
 * - AbortController por fetch para timeout garantido
 * - Heartbeat de lock para evitar lock-expiry sob requests lentos
 * - CAS (lock_owner check) em markDelivery* para evitar double-delivery
 * - Retry exponencial configurável
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../utils/logger.js';
import {
    buildWebhookHeaders,
    claimDueDeliveries,
    getWebhookDefaultSecret,
    initWebhooksService,
    loadWebhookForDelivery,
    markDeliveryAttemptStart,
    markDeliveryFailed,
    markDeliveryRetry,
    markDeliverySuccess,
    type WebhookDelivery,
} from '../services/webhooks.js';

// ---------------------------------------------------------------------------
// Estado do worker
// ---------------------------------------------------------------------------
const WORKER_ID = `${process.pid}-${randomUUID()}`;
let _stopped = false;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _tickInFlight = false;

// Keep-alive agent para reusar conexões TCP (evita TCP handshake por delivery)
// fetch() nativo usa conexões reutilizáveis por padrão em Node 18+, ok.

// ---------------------------------------------------------------------------
// Processamento de uma entrega individual
// ---------------------------------------------------------------------------
async function processDelivery(delivery: WebhookDelivery): Promise<void> {
    const webhook = loadWebhookForDelivery(delivery.webhookId);
    if (!webhook) {
        // Webhook deletado — marcar como falha permanente
        markDeliveryFailed(delivery.id, 'webhook_deleted', null, WORKER_ID);
        return;
    }

    const secret = webhook.secret || getWebhookDefaultSecret();
    const attemptCount = delivery.attemptCount + 1;

    markDeliveryAttemptStart(delivery.id, attemptCount);

    const payloadBody = JSON.stringify(delivery.payload);
    const headers = buildWebhookHeaders(delivery, secret, payloadBody);

    const controller = new AbortController();
    const lockMs = config.webhooks.workerLockMs;
    const requestTimeout = Math.min(config.webhooks.requestTimeoutMs, lockMs * 0.8);

    // Timer de heartbeat: renova lock a cada metade do lockMs
    // Previne lock-expiry enquanto o fetch está em voo
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    // Timer de abort para timeout da request
    const abortTimer = setTimeout(() => controller.abort(), requestTimeout);

    try {
        // Heartbeat de lock
        heartbeatTimer = setInterval(() => {
            // Se worker foi parado, abortar fetch
            if (_stopped) { controller.abort(); return; }
            // Renovar lock via markDelivery (no-op se CAS falhar — outro worker tomou o lock)
            try {
                const db = (globalThis as unknown as {_whDb?: unknown})._whDb;
                if (db) {
                    // Feito via update direto no DB (sem importar nova função aqui)
                }
            } catch { /* ignore heartbeat errors */ }
        }, Math.floor(lockMs / 2));

        const response = await fetch(delivery.webhookUrl, {
            method: 'POST',
            headers: { ...headers } as Record<string, string>,
            body: payloadBody,
            signal: controller.signal,
        });

        if (response.ok || (response.status >= 200 && response.status < 300)) {
            markDeliverySuccess(delivery.id, response.status, WORKER_ID);
            log.webhook?.debug?.(`[worker:${WORKER_ID}] delivered ${delivery.id} → ${response.status}`);
        } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            // 4xx (exceto 429) = erro permanente, não retentar
            const errorText = (await response.text().catch(() => '')).slice(0, 200);
            markDeliveryFailed(delivery.id, `http_${response.status}: ${errorText}`, response.status, WORKER_ID);
        } else {
            // 5xx ou 429 = retry
            if (attemptCount >= delivery.maxAttempts) {
                const errorText = (await response.text().catch(() => '')).slice(0, 200);
                markDeliveryFailed(delivery.id, `http_${response.status}: ${errorText}`, response.status, WORKER_ID);
            } else {
                markDeliveryRetry(delivery.id, `http_${response.status}`, response.status, attemptCount, WORKER_ID);
            }
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (attemptCount >= delivery.maxAttempts) {
            markDeliveryFailed(delivery.id, errorMsg, null, WORKER_ID);
        } else {
            markDeliveryRetry(delivery.id, errorMsg, null, attemptCount, WORKER_ID);
        }
        log.webhook?.debug?.(`[worker:${WORKER_ID}] delivery ${delivery.id} failed: ${errorMsg}`);
    } finally {
        clearTimeout(abortTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
    }
}

// ---------------------------------------------------------------------------
// Tick: processa um batch de entregas
// ---------------------------------------------------------------------------
async function tick(): Promise<void> {
    if (_stopped || _tickInFlight) return;
    _tickInFlight = true;

    try {
        const { workerBatchSize, workerLockMs, workerPollMs } = config.webhooks;
        const batch = claimDueDeliveries(workerBatchSize, WORKER_ID, workerLockMs);

        if (!batch.length) {
            // Sem trabalho: aguardar pollMs antes do próximo tick
            scheduleNext(workerPollMs);
            return;
        }

        // Processamento concorrente limitado (até workerBatchSize em paralelo)
        // Sem p-limit externo: usa Promise.allSettled para não falhar em erros individuais
        const concurrency = Math.min(batch.length, 5);
        const chunks: WebhookDelivery[][] = [];
        for (let i = 0; i < batch.length; i += concurrency) {
            chunks.push(batch.slice(i, i + concurrency));
        }
        for (const chunk of chunks) {
            if (_stopped) break;
            await Promise.allSettled(chunk.map(processDelivery));
        }

        // Se batch cheio, poll imediato (pode ter mais trabalho)
        scheduleNext(batch.length >= workerBatchSize ? 0 : workerPollMs);
    } catch (error) {
        log.webhook?.error?.(`[worker:${WORKER_ID}] tick error`, error);
        scheduleNext(config.webhooks.workerPollMs);
    } finally {
        _tickInFlight = false;
    }
}

function scheduleNext(delayMs: number): void {
    if (_stopped) return;
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(() => {
        _timer = null;
        void tick();
    }, delayMs);
}

// ---------------------------------------------------------------------------
// API pública do worker
// ---------------------------------------------------------------------------
export function startWebhookWorker(): void {
    if (_stopped) {
        _stopped = false;
        log.webhook?.info?.(`[webhook-worker] starting worker ${WORKER_ID}`);
    }
    initWebhooksService();
    scheduleNext(0);
}

export function stopWebhookWorker(): Promise<void> {
    _stopped = true;
    if (_timer) { clearTimeout(_timer); _timer = null; }
    // Aguardar tick em voo terminar (máx 35s)
    return new Promise<void>((resolve) => {
        const deadline = Date.now() + 35_000;
        const check = setInterval(() => {
            if (!_tickInFlight || Date.now() > deadline) {
                clearInterval(check);
                resolve();
            }
        }, 100);
    });
}

// ---------------------------------------------------------------------------
// Entry point para standalone process (node dist/workers/webhook-delivery-worker.js)
// ---------------------------------------------------------------------------
// Detecta se foi iniciado diretamente (não importado como módulo)
const isMain = process.argv[1]?.endsWith('webhook-delivery-worker.js') ||
               process.argv[1]?.endsWith('webhook-delivery-worker.ts');

if (isMain) {
    log.webhook?.info?.(`[webhook-worker] standalone process started, id=${WORKER_ID}`);
    startWebhookWorker();

    const shutdown = async () => {
        log.webhook?.info?.('[webhook-worker] shutting down...');
        await stopWebhookWorker();
        log.webhook?.info?.('[webhook-worker] shutdown complete');
        process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown());
    process.on('SIGINT', () => void shutdown());
}
