import { Router } from 'express';
import { normalizeInstanceName } from '../utils/helpers.js';
import { sendError, sendOk } from '../utils/api-response.js';
import { writeAuditEvent } from '../services/audit-log.js';
import { config } from '../config.js';
import { validateOutboundUrl } from '../utils/url-security.js';
import { getInstanceIntegrations, listIntegrationInstances, testChatwoot, testN8n, updateChatwootConfig, updateN8nConfig, } from '../services/integrations.js';
import { parseChatwootWebhook, invalidateConversationCache, } from '../services/chatwoot-bridge.js';
import { sendInstanceTextMessage, sendInstanceMediaMessage, } from '../services/whatsapp.js';
const router = Router();
function getInstanceParam(req, res) {
    const instance = normalizeInstanceName(req.params.instance);
    if (!instance) {
        sendError(res, 400, 'invalid_instance_name');
        return null;
    }
    return instance;
}
router.get('/', (_req, res) => {
    return sendOk(res, { items: listIntegrationInstances() });
});
router.get('/:instance', (req, res) => {
    const instance = getInstanceParam(req, res);
    if (!instance)
        return;
    return sendOk(res, { integration: getInstanceIntegrations(instance) });
});
router.patch('/:instance/chatwoot', (req, res) => {
    const instance = getInstanceParam(req, res);
    if (!instance)
        return;
    const body = (req.body ?? {});
    const baseUrlRaw = body.baseUrl !== undefined ? String(body.baseUrl).trim() : undefined;
    let baseUrl = baseUrlRaw;
    if (baseUrlRaw) {
        const validation = validateOutboundUrl(baseUrlRaw, {
            allowPrivateNetwork: config.security.allowPrivateNetworkIntegrations,
        });
        if (!validation.ok) {
            return sendError(res, 400, 'invalid_chatwoot_base_url', 'Chatwoot base URL blocked by security policy.', {
                reason: validation.error,
                details: validation.details,
            });
        }
        baseUrl = validation.normalizedUrl;
    }
    // Normalize ignoreJids: accept array or newline/comma-separated string
    let ignoreJids;
    if (body.ignoreJids !== undefined) {
        if (Array.isArray(body.ignoreJids)) {
            ignoreJids = body.ignoreJids.map((j) => String(j).trim()).filter(Boolean);
        }
        else if (typeof body.ignoreJids === 'string') {
            ignoreJids = body.ignoreJids
                .split(/[\n,;]+/)
                .map((j) => j.trim())
                .filter(Boolean);
        }
    }
    const integration = updateChatwootConfig(instance, {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        baseUrl,
        accountId: body.accountId !== undefined ? String(body.accountId).trim() : undefined,
        inboxId: body.inboxId !== undefined ? String(body.inboxId).trim() : undefined,
        apiAccessToken: body.apiAccessToken !== undefined ? String(body.apiAccessToken).trim() : undefined,
        nameInbox: body.nameInbox !== undefined ? String(body.nameInbox).trim() : undefined,
        signMessages: typeof body.signMessages === 'boolean' ? body.signMessages : undefined,
        signDelimiter: body.signDelimiter !== undefined ? String(body.signDelimiter) : undefined,
        organization: body.organization !== undefined ? String(body.organization).trim() : undefined,
        logoUrl: body.logoUrl !== undefined ? String(body.logoUrl).trim() : undefined,
        conversationPending: typeof body.conversationPending === 'boolean' ? body.conversationPending : undefined,
        reopenConversation: typeof body.reopenConversation === 'boolean' ? body.reopenConversation : undefined,
        importContacts: typeof body.importContacts === 'boolean' ? body.importContacts : undefined,
        importMessages: typeof body.importMessages === 'boolean' ? body.importMessages : undefined,
        daysLimitImportMessages: body.daysLimitImportMessages !== undefined ? Number(body.daysLimitImportMessages) : undefined,
        ignoreJids,
        autoCreate: typeof body.autoCreate === 'boolean' ? body.autoCreate : undefined,
    });
    // Note: history sync now happens ONLY on connection=open (see whatsapp.ts) or via manual button.
    // Removed auto-sync on save to avoid re-syncing every time other flags toggle.
    writeAuditEvent(req, res, {
        action: 'integrations.chatwoot.update',
        target: instance,
        details: {
            enabled: integration.chatwoot.enabled,
            hasToken: Boolean(integration.chatwoot.apiAccessToken),
        },
    });
    return sendOk(res, { integration });
});
router.patch('/:instance/n8n', (req, res) => {
    const instance = getInstanceParam(req, res);
    if (!instance)
        return;
    const body = (req.body ?? {});
    const webhookUrlRaw = body.webhookUrl !== undefined ? String(body.webhookUrl).trim() : undefined;
    let webhookUrl = webhookUrlRaw;
    if (webhookUrlRaw) {
        const validation = validateOutboundUrl(webhookUrlRaw, {
            allowPrivateNetwork: config.security.allowPrivateNetworkIntegrations,
        });
        if (!validation.ok) {
            return sendError(res, 400, 'invalid_n8n_webhook_url', 'n8n webhook URL blocked by security policy.', {
                reason: validation.error,
                details: validation.details,
            });
        }
        webhookUrl = validation.normalizedUrl;
    }
    const integration = updateN8nConfig(instance, {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        webhookUrl,
        authHeaderName: body.authHeaderName !== undefined ? String(body.authHeaderName).trim() : undefined,
        authHeaderValue: body.authHeaderValue !== undefined ? String(body.authHeaderValue).trim() : undefined,
    });
    writeAuditEvent(req, res, {
        action: 'integrations.n8n.update',
        target: instance,
        details: {
            enabled: integration.n8n.enabled,
            hasAuthHeader: Boolean(integration.n8n.authHeaderName && integration.n8n.authHeaderValue),
        },
    });
    return sendOk(res, { integration });
});
router.post('/:instance/chatwoot/test', async (req, res) => {
    const instance = getInstanceParam(req, res);
    if (!instance)
        return;
    const result = await testChatwoot(instance);
    writeAuditEvent(req, res, {
        action: 'integrations.chatwoot.test',
        target: instance,
        outcome: result.ok ? 'success' : 'failure',
        details: { status: result.status ?? null, error: result.error ?? null },
    });
    if (!result.ok) {
        if (result.error === 'chatwoot_not_configured') {
            return sendError(res, 400, result.error);
        }
        if (result.error === 'chatwoot_url_blocked') {
            return sendError(res, 400, result.error, 'Chatwoot URL blocked by security policy.');
        }
        if (typeof result.status === 'number') {
            return sendError(res, 502, 'chatwoot_test_failed', result.error, { status: result.status });
        }
        return sendError(res, 502, 'chatwoot_test_failed', result.error);
    }
    return sendOk(res, { tested: true, status: result.status ?? 200 });
});
router.post('/:instance/n8n/test', async (req, res) => {
    const instance = getInstanceParam(req, res);
    if (!instance)
        return;
    const result = await testN8n(instance);
    writeAuditEvent(req, res, {
        action: 'integrations.n8n.test',
        target: instance,
        outcome: result.ok ? 'success' : 'failure',
        details: { status: result.status ?? null, error: result.error ?? null },
    });
    if (!result.ok) {
        if (result.error === 'n8n_not_configured') {
            return sendError(res, 400, result.error);
        }
        if (result.error === 'n8n_url_blocked') {
            return sendError(res, 400, result.error, 'n8n URL blocked by security policy.');
        }
        if (typeof result.status === 'number') {
            return sendError(res, 502, 'n8n_test_failed', result.error, { status: result.status });
        }
        return sendError(res, 502, 'n8n_test_failed', result.error);
    }
    return sendOk(res, { tested: true, status: result.status ?? 200 });
});
/**
 * POST /v1/integrations/:instance/chatwoot/webhook
 *
 * Receives Chatwoot webhook events and dispatches outgoing agent messages
 * back to WhatsApp. Configure this URL in Chatwoot under Settings → Integrations → Webhooks.
 *
 * This endpoint does NOT require API key authentication so Chatwoot can reach it directly.
 * Security: We validate that the instance has Chatwoot enabled before processing.
 */
router.post('/:instance/chatwoot/webhook', async (req, res) => {
    const instance = getInstanceParam(req, res);
    if (!instance)
        return;
    const body = (req.body ?? {});
    // Quick ack to Chatwoot — must respond fast to avoid retries
    res.status(200).json({ ok: true });
    // Validate integration is configured and enabled
    let integrationCfg;
    try {
        const integrations = getInstanceIntegrations(instance);
        integrationCfg = integrations.chatwoot;
    }
    catch {
        return;
    }
    if (!integrationCfg.enabled)
        return;
    // Parse the webhook payload
    const action = parseChatwootWebhook(body);
    if (!action)
        return;
    const { jid, text, mediaUrl, mimeType, fileName, replyToId, agentName } = action;
    try {
        if (mediaUrl) {
            await sendInstanceMediaMessage(instance, jid, {
                mediaUrl,
                mimeType,
                fileName,
                caption: text || undefined,
                replyToId,
                agentName: integrationCfg.signMessages ? agentName : undefined,
                signDelimiter: integrationCfg.signDelimiter,
            });
        }
        else if (text) {
            await sendInstanceTextMessage(instance, jid, text, {
                replyToId,
                agentName: integrationCfg.signMessages ? agentName : undefined,
                signDelimiter: integrationCfg.signDelimiter,
            });
        }
    }
    catch (err) {
        console.error(`[chatwoot-webhook][${instance}] dispatch error`, err);
    }
});
/**
 * POST /v1/integrations/:instance/chatwoot/invalidate-cache
 *
 * Clears the in-memory conversation/inbox cache for this instance.
 * Useful after changing inbox configuration.
 */
router.post('/:instance/chatwoot/invalidate-cache', (req, res) => {
    const instance = getInstanceParam(req, res);
    if (!instance)
        return;
    invalidateConversationCache(instance);
    return sendOk(res, { invalidated: true });
});
export default router;
//# sourceMappingURL=integrations.js.map