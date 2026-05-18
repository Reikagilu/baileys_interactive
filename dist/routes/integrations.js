import { Router } from 'express';
import { normalizeInstanceName } from '../utils/helpers.js';
import { sendError, sendOk } from '../utils/api-response.js';
import { writeAuditEvent } from '../services/audit-log.js';
import { config } from '../config.js';
import { validateOutboundUrl } from '../utils/url-security.js';
import { getInstanceIntegrations, listIntegrationInstances, redactIntegrations, testChatwoot, testN8n, updateChatwootConfig, updateN8nConfig, } from '../services/integrations.js';
import { updateInstanceGeneral } from '../services/instance-config.js';
import { syncContactNamesToChatwoot, buildChatwootWebhookUrl, normalizeChatwootWebhookSlug, invalidateConversationCache, } from '../services/chatwoot-bridge.js';
const router = Router();
const NUMERIC_ID_PATTERN = /^\d{1,20}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
function isOptionalNumericId(value) {
    if (value === undefined)
        return true;
    const s = String(value).trim();
    if (s === '')
        return true; // string vazia = limpar o campo (aceita)
    return NUMERIC_ID_PATTERN.test(s);
}
function isOptionalMaxLength(value, max) {
    if (value === undefined)
        return true;
    return String(value).trim().length <= max;
}
function buildWebhookPayload(instance, integration = getInstanceIntegrations(instance)) {
    const slug = integration.chatwoot.webhookSlug?.trim() || instance;
    // Mascara tokens sensíveis antes de retornar ao cliente. getInstanceIntegrations
    // retorna os tokens em texto claro (necessário para uso interno). redactIntegrations
    // substitui apiAccessToken e authHeaderValue por '***'.
    return {
        integration: redactIntegrations(integration),
        chatwootWebhookUrl: buildChatwootWebhookUrl(slug),
    };
}
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
    return sendOk(res, buildWebhookPayload(instance));
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
    if (body.webhookSlug !== undefined) {
        const normalizedSlug = normalizeChatwootWebhookSlug(body.webhookSlug);
        if (!normalizedSlug) {
            return sendError(res, 400, 'invalid_chatwoot_webhook_slug');
        }
    }
    if (!isOptionalNumericId(body.accountId)) {
        return sendError(res, 400, 'invalid_chatwoot_account_id');
    }
    if (!isOptionalNumericId(body.inboxId)) {
        return sendError(res, 400, 'invalid_chatwoot_inbox_id');
    }
    if (!isOptionalMaxLength(body.apiAccessToken, 2048)) {
        return sendError(res, 400, 'invalid_chatwoot_token_length');
    }
    if (!isOptionalMaxLength(body.nameInbox, 120)) {
        return sendError(res, 400, 'invalid_chatwoot_name_inbox');
    }
    if (!isOptionalMaxLength(body.organization, 160)) {
        return sendError(res, 400, 'invalid_chatwoot_organization');
    }
    if (!isOptionalMaxLength(body.signDelimiter, 16)) {
        return sendError(res, 400, 'invalid_chatwoot_sign_delimiter');
    }
    if (body.daysLimitImportMessages !== undefined) {
        const days = Number(body.daysLimitImportMessages);
        // 0 = no limit (sync all history), 1–365 = limit to N days
        if (!Number.isFinite(days) || days < 0 || days > 365) {
            return sendError(res, 400, 'invalid_chatwoot_days_limit');
        }
    }
    if (ignoreJids && (ignoreJids.length > 500 || ignoreJids.some((jid) => jid.length > 160))) {
        return sendError(res, 400, 'invalid_chatwoot_ignore_jids');
    }
    const integration = updateChatwootConfig(instance, {
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        baseUrl,
        accountId: body.accountId !== undefined ? String(body.accountId).trim() : undefined,
        inboxId: body.inboxId !== undefined ? String(body.inboxId).trim() : undefined,
        apiAccessToken: body.apiAccessToken !== undefined ? String(body.apiAccessToken).trim() : undefined,
        nameInbox: body.nameInbox !== undefined ? String(body.nameInbox).trim() : undefined,
        webhookSlug: body.webhookSlug !== undefined ? normalizeChatwootWebhookSlug(body.webhookSlug) : undefined,
        signMessages: typeof body.signMessages === 'boolean' ? body.signMessages : undefined,
        signDelimiter: body.signDelimiter !== undefined ? String(body.signDelimiter) : undefined,
        organization: body.organization !== undefined ? String(body.organization).trim() : undefined,
        logoUrl: body.logoUrl !== undefined ? String(body.logoUrl).trim() : undefined,
        conversationPending: typeof body.conversationPending === 'boolean' ? body.conversationPending : undefined,
        reopenConversation: typeof body.reopenConversation === 'boolean' ? body.reopenConversation : undefined,
        // @deprecated — `importContacts` migrou para GeneralConfig. Mantemos aqui
        // por compat retroativa: a leitura efetiva acontece em getInstanceGeneral().
        // Quando o cliente envia, espelhamos no General logo abaixo.
        importContacts: typeof body.importContacts === 'boolean' ? body.importContacts : undefined,
        importMessages: typeof body.importMessages === 'boolean' ? body.importMessages : undefined,
        daysLimitImportMessages: body.daysLimitImportMessages !== undefined ? Number(body.daysLimitImportMessages) : undefined,
        ignoreJids,
        autoCreate: typeof body.autoCreate === 'boolean' ? body.autoCreate : undefined,
    });
    // Espelhar importContacts no GeneralConfig para clients legados que ainda
    // mandam o campo pelo endpoint da integração. Quando a UI nova for adotada,
    // ela usará PATCH /settings/general diretamente e esta linha vira no-op.
    if (typeof body.importContacts === 'boolean') {
        try {
            updateInstanceGeneral(instance, { importContacts: body.importContacts });
        }
        catch {
            /* best-effort — não falhar o request inteiro */
        }
    }
    invalidateConversationCache(instance);
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
    return sendOk(res, buildWebhookPayload(instance, integration));
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
    if (body.authHeaderName !== undefined) {
        const headerName = String(body.authHeaderName).trim();
        if (headerName && !HEADER_NAME_PATTERN.test(headerName)) {
            return sendError(res, 400, 'invalid_n8n_auth_header_name');
        }
    }
    if (!isOptionalMaxLength(body.authHeaderValue, 1024)) {
        return sendError(res, 400, 'invalid_n8n_auth_header_value');
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
    return sendOk(res, buildWebhookPayload(instance, integration));
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
router.post('/:instance/chatwoot/sync-contact-names', async (req, res) => {
    const instance = getInstanceParam(req, res);
    if (!instance)
        return;
    const result = await syncContactNamesToChatwoot(instance);
    writeAuditEvent(req, res, {
        action: 'integrations.chatwoot.sync_contact_names',
        target: instance,
        outcome: result.ok ? 'success' : 'failure',
        details: result,
    });
    if (!result.ok) {
        return sendError(res, 400, result.error || 'chatwoot_sync_contact_names_failed');
    }
    return sendOk(res, { result });
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
export default router;
