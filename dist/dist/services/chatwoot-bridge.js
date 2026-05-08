/**
 * Chatwoot Bridge Service
 *
 * Handles bidirectional integration between WhatsApp (Baileys) and Chatwoot.
 *
 * WhatsApp → Chatwoot:
 *   1. Find or create contact in Chatwoot
 *   2. Find or create conversation (inbox + contact)
 *   3. Send message with source_id = WhatsApp message ID (deduplication)
 *
 * Chatwoot → WhatsApp:
 *   POST /v1/integrations/:instance/chatwoot/webhook receives Chatwoot events
 *   and dispatches messages to WhatsApp via sendMessage
 */
import { getInstanceIntegrations } from './integrations.js';
const REQUEST_TIMEOUT_MS = 10_000;
async function cwFetch(cfg, method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const url = `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}${path}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'api_access_token': cfg.apiAccessToken,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Chatwoot HTTP ${res.status}: ${text}`);
        }
        return (await res.json());
    }
    finally {
        clearTimeout(t);
    }
}
/**
 * Search contact by phone number (E.164 format) or by identifier (JID).
 * Uses /contacts/filter for phone, /contacts/search for groups.
 */
async function findContactByPhone(cfg, phone) {
    try {
        const payload = {
            payload: [
                {
                    attribute_key: 'phone_number',
                    filter_operator: 'equal_to',
                    values: [phone.replace('+', '')],
                    query_operator: null,
                },
            ],
        };
        const res = await cwFetch(cfg, 'POST', '/contacts/filter', payload);
        return res.payload?.[0] ?? null;
    }
    catch {
        return null;
    }
}
async function findContactByIdentifier(cfg, identifier) {
    try {
        const res = await cwFetch(cfg, 'GET', `/contacts/search?q=${encodeURIComponent(identifier)}&page=1`);
        return res.payload?.find((c) => c.identifier === identifier) ?? null;
    }
    catch {
        return null;
    }
}
async function createContact(cfg, inboxId, params) {
    try {
        const data = {
            inbox_id: inboxId,
            name: params.name,
            identifier: params.identifier,
        };
        if (!params.isGroup && params.phoneNumber) {
            data['phone_number'] = `+${params.phoneNumber}`;
        }
        if (params.avatarUrl) {
            data['avatar_url'] = params.avatarUrl;
        }
        const res = await cwFetch(cfg, 'POST', '/contacts', data);
        // Chatwoot returns { payload: { contact: {...} } } on create
        const contact = res.id
            ? res
            : res.payload?.contact ?? null;
        return contact;
    }
    catch (err) {
        // 422 = already exists — fall back to search
        if (String(err).includes('422')) {
            return findContactByIdentifier(cfg, params.identifier);
        }
        return null;
    }
}
async function getOrCreateContact(cfg, inboxId, params) {
    if (params.isGroup) {
        const existing = await findContactByIdentifier(cfg, params.jid);
        if (existing)
            return existing;
        return createContact(cfg, inboxId, {
            name: params.name,
            identifier: params.jid,
            isGroup: true,
            avatarUrl: params.avatarUrl,
        });
    }
    const existing = (await findContactByPhone(cfg, `+${params.phoneNumber}`)) ??
        (await findContactByIdentifier(cfg, params.jid));
    if (existing)
        return existing;
    return createContact(cfg, inboxId, {
        phoneNumber: params.phoneNumber,
        name: params.name,
        identifier: params.jid,
        isGroup: false,
        avatarUrl: params.avatarUrl,
    });
}
/** Cache: instanceName → CwInbox */
const inboxCache = new Map();
async function getInbox(instanceName, cfg, nameInbox) {
    const cached = inboxCache.get(instanceName);
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000)
        return cached.inbox;
    try {
        const res = await cwFetch(cfg, 'GET', '/inboxes');
        const inbox = res.payload?.find((i) => i.name === nameInbox) ?? null;
        if (inbox)
            inboxCache.set(instanceName, { inbox, ts: Date.now() });
        return inbox;
    }
    catch {
        return null;
    }
}
/** Cache: instanceName:jid → conversationId */
const convCache = new Map();
async function getOrCreateConversation(instanceName, cfg, accountId, inboxId, contactId, opts) {
    const cacheKey = `${instanceName}:${contactId}`;
    const cached = convCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000)
        return cached.id;
    try {
        // List existing conversations for this contact
        const convList = await cwFetch(cfg, 'GET', `/contacts/${contactId}/conversations`);
        const existing = convList.payload?.filter((c) => c.inbox_id === inboxId) ?? [];
        let conv;
        if (opts.reopenConversation) {
            conv = existing[0]; // pick most recent regardless of status
        }
        else {
            conv = existing.find((c) => c.status !== 'resolved');
        }
        if (conv) {
            // Reopen if resolved/pending and flag is set
            if (opts.reopenConversation && conv.status !== 'open') {
                await cwFetch(cfg, 'PATCH', `/conversations/${conv.id}/toggle_status`, {
                    status: opts.conversationPending ? 'pending' : 'open',
                }).catch(() => { });
            }
            convCache.set(cacheKey, { id: conv.id, ts: Date.now() });
            return conv.id;
        }
        // Create new conversation
        const data = {
            contact_id: String(contactId),
            inbox_id: String(inboxId),
        };
        if (opts.conversationPending) {
            data['status'] = 'pending';
        }
        const created = await cwFetch(cfg, 'POST', '/conversations', data);
        convCache.set(cacheKey, { id: created.id, ts: Date.now() });
        return created.id;
    }
    catch (err) {
        console.error('[chatwoot-bridge] getOrCreateConversation error', err);
        return null;
    }
}
// ─── Message helpers ──────────────────────────────────────────────────────────
async function sendMessageToChatwoot(cfg, conversationId, params) {
    await cwFetch(cfg, 'POST', `/conversations/${conversationId}/messages`, {
        content: params.content || '',
        message_type: params.messageType,
        private: false,
        source_id: params.sourceId,
        attachments: params.attachments,
    });
}
/**
 * Called for every messages.upsert event (normalized messages list).
 * Dispatches each message to Chatwoot if integration is enabled.
 */
export async function dispatchToChatwoot(instanceName, messages) {
    let cfg;
    try {
        const integrations = await getInstanceIntegrations(instanceName);
        cfg = integrations.chatwoot;
    }
    catch {
        return;
    }
    if (!cfg.enabled || !cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken || !cfg.inboxId) {
        return;
    }
    const cwCfg = {
        baseUrl: cfg.baseUrl,
        accountId: cfg.accountId,
        apiAccessToken: cfg.apiAccessToken,
    };
    const inbox = await getInbox(instanceName, cwCfg, cfg.nameInbox || 'WhatsApp');
    if (!inbox) {
        console.warn(`[chatwoot-bridge][${instanceName}] inbox "${cfg.nameInbox}" not found`);
        return;
    }
    for (const msg of messages) {
        try {
            await dispatchSingleMessage(instanceName, cwCfg, cfg, inbox, msg);
        }
        catch (err) {
            console.error(`[chatwoot-bridge][${instanceName}] dispatch error for ${msg.key?.id}`, err);
        }
    }
}
async function dispatchSingleMessage(instanceName, cwCfg, cfg, inbox, msg) {
    const { key, pushName, text, media, sender } = msg;
    if (!key?.remoteJid || !key?.id)
        return;
    const remoteJid = key.remoteJid;
    // Skip broadcast status messages
    if (remoteJid === 'status@broadcast')
        return;
    // Skip JIDs in ignoreJids list
    if (cfg.ignoreJids?.includes(remoteJid))
        return;
    const isGroup = remoteJid.endsWith('@g.us');
    const isFromMe = key.fromMe;
    // Determine phone number (digits only) and name for contact
    const phoneNumber = isGroup
        ? (key.participant ?? '').split('@')[0]
        : remoteJid.split('@')[0];
    const contactJid = isGroup ? (key.participant ?? remoteJid) : remoteJid;
    const contactName = sender?.name || pushName || phoneNumber || contactJid.split('@')[0];
    // Get or create contact
    const contact = await getOrCreateContact(cwCfg, inbox.id, {
        phoneNumber,
        name: contactName,
        jid: contactJid,
        isGroup,
    });
    if (!contact) {
        console.warn(`[chatwoot-bridge][${instanceName}] could not get/create contact for ${contactJid}`);
        return;
    }
    // Get or create conversation
    const convId = await getOrCreateConversation(instanceName, cwCfg, cfg.accountId, inbox.id, contact.id, {
        conversationPending: cfg.conversationPending ?? false,
        reopenConversation: cfg.reopenConversation !== false,
    });
    if (!convId) {
        console.warn(`[chatwoot-bridge][${instanceName}] could not get/create conversation for ${remoteJid}`);
        return;
    }
    // Build message content
    let content = text ?? '';
    // Sign message with agent name if enabled
    if (cfg.signMessages && isFromMe) {
        const delimiter = cfg.signDelimiter ?? '\n';
        const agentName = cfg.nameInbox || instanceName;
        content = `*${agentName}*${delimiter}${content}`;
    }
    // Build attachments from media base64
    let attachments;
    if (media?.base64 && media.kind !== 'text') {
        const filename = media.fileName || `${media.kind}_${key.id}.${(media.mimeType ?? '').split('/')[1] ?? 'bin'}`;
        attachments = [
            {
                content: media.base64.replace(/^data:[^;]+;base64,/, ''),
                encoding: 'base64',
                filename,
                mime_type: media.mimeType,
            },
        ];
        // Use caption as content if text is empty
        if (!content && media.caption) {
            content = media.caption;
        }
    }
    const messageType = isFromMe ? 'outgoing' : 'incoming';
    await sendMessageToChatwoot(cwCfg, convId, {
        content,
        messageType,
        sourceId: key.id, // deduplication: Chatwoot ignores duplicates with same source_id
        attachments,
    });
}
/**
 * Process a Chatwoot webhook event.
 * Returns the JID to send to and the text, or null if not actionable.
 */
export function parseChatwootWebhook(payload) {
    // Only handle new outgoing agent messages (not private notes, not bot messages)
    if (payload.event !== 'message_created')
        return null;
    if (payload.message_type !== 'outgoing')
        return null;
    if (payload.private)
        return null;
    // Skip messages from contact themselves (would cause a loop)
    if (payload.sender?.type === 'contact')
        return null;
    const identifier = payload.conversation?.meta?.sender?.identifier;
    const phone = payload.conversation?.meta?.sender?.phone_number;
    // Resolve JID: identifier is the WhatsApp JID we stored
    let jid = identifier?.includes('@') ? identifier : null;
    if (!jid && phone) {
        // phone_number is +5511... — strip + and add @s.whatsapp.net
        jid = `${phone.replace(/^\+/, '')}@s.whatsapp.net`;
    }
    if (!jid)
        return null;
    const text = payload.content ?? '';
    // Check for attachment
    const firstAttachment = payload.attachments?.[0];
    if (firstAttachment?.data_url) {
        return {
            jid,
            text,
            mediaUrl: firstAttachment.data_url,
            fileName: firstAttachment.file_name,
        };
    }
    return { jid, text };
}
// ─── Conversation cache invalidation ─────────────────────────────────────────
export function invalidateConversationCache(instanceName) {
    for (const key of convCache.keys()) {
        if (key.startsWith(`${instanceName}:`)) {
            convCache.delete(key);
        }
    }
    inboxCache.delete(instanceName);
}
//# sourceMappingURL=chatwoot-bridge.js.map