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
import { listChats, listMessages, getChatTitle } from './message-store.js';
import { isChatwootOriginated } from './chatwoot-tracking.js';
import { isMessageSynced, markMessageSynced, startSyncProgress, updateSyncProgress, finishSyncProgress, isSyncCancelled, isSyncRunning, } from './chatwoot-sync-store.js';
/**
 * Formats a raw digit string (e.g. "5511972798737") into a human-readable
 * phone number like "+55 11 97279 8737".
 * Falls back to "+{digits}" if it doesn't match known patterns.
 */
function formatPhoneDisplay(digits) {
    // Brazilian numbers: 55 + 2-digit DDD + 8-9 digit number
    const br = digits.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
    if (br)
        return `+55 ${br[1]} ${br[2]} ${br[3]}`;
    // Generic: country code (1-3 digits) + rest
    if (digits.length >= 10)
        return `+${digits}`;
    return digits;
}
// Cache de subjects de grupos: instance:jid → { subject, expires }
const groupSubjectCache = new Map();
const GROUP_SUBJECT_CACHE_MS = 10 * 60 * 1000; // 10 minutos
async function resolveGroupSubject(instanceName, groupJid) {
    const cacheKey = `${instanceName}:${groupJid}`;
    const cached = groupSubjectCache.get(cacheKey);
    if (cached && cached.expires > Date.now())
        return cached.subject;
    // 1) Tenta pelo socket Baileys (mais confiável). Dynamic import evita circular dependency.
    try {
        const wa = await import('./whatsapp.js');
        const ctx = wa.getInstance(instanceName);
        if (ctx?.sock?.groupMetadata) {
            const meta = await ctx.sock.groupMetadata(groupJid);
            const subject = (meta?.subject || '').trim();
            if (subject) {
                groupSubjectCache.set(cacheKey, { subject, expires: Date.now() + GROUP_SUBJECT_CACHE_MS });
                return subject;
            }
        }
    }
    catch (err) {
        // Silenciar — pode falhar se não for membro do grupo, etc.
    }
    // 2) Fallback: SQLite (chat_meta.title)
    const stored = getChatTitle(instanceName, groupJid);
    if (stored) {
        groupSubjectCache.set(cacheKey, { subject: stored, expires: Date.now() + GROUP_SUBJECT_CACHE_MS });
        return stored;
    }
    return null;
}
// Resolve the saved contact name from multiple sources in order of trust:
//   1) Baileys store (the WhatsApp address book — has the user's saved name)
//   2) SQLite chat_meta.title (persisted pushName from previous messages)
//   3) Provided fallback (sender.name / pushName from the message itself)
// Names equal to the phone number / JID are considered weak and ignored
// (so we don't end up with "+55 11 9XXXX-XXXX - 5511XXXXXXXXX").
async function resolveContactName(instanceName, jid, fallback) {
    const number = jid.split('@')[0];
    // Helper: validate that the candidate name is meaningful
    const isUsableName = (name) => {
        if (typeof name !== 'string')
            return false;
        const trimmed = name.trim();
        if (!trimmed)
            return false;
        if (trimmed === number)
            return false;
        if (trimmed === jid)
            return false;
        // pure phone-like strings: digits, +, -, spaces, parens
        if (/^[\d+\-\s()]+$/.test(trimmed))
            return false;
        return true;
    };
    // 1) Baileys store — the actual WhatsApp address book
    try {
        const wa = await import('./whatsapp.js');
        const ctx = wa.getInstance(instanceName);
        const contact = ctx?.sock?.store?.contacts?.[jid];
        if (contact) {
            // Order: saved name (verifiedName / name) > push name (notify)
            const candidate = contact.verifiedName || contact.name || contact.notify;
            if (isUsableName(candidate))
                return candidate.trim();
        }
    }
    catch (_) {
        // ignore — store may not be available
    }
    // 2) SQLite chat_meta.title (persisted from previous messages' pushName)
    const stored = getChatTitle(instanceName, jid);
    if (isUsableName(stored))
        return stored.trim();
    // 3) Provided fallback (current message's pushName / sender.name)
    if (isUsableName(fallback))
        return fallback.trim();
    return null;
}
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
        // Use filter API for exact identifier match
        const payload = {
            payload: [
                {
                    attribute_key: 'identifier',
                    filter_operator: 'equal_to',
                    values: [identifier],
                    query_operator: null,
                },
            ],
        };
        const res = await cwFetch(cfg, 'POST', '/contacts/filter', payload);
        return res.payload?.[0] ?? null;
    }
    catch {
        // Fallback: search API (less precise but better than nothing)
        try {
            const res = await cwFetch(cfg, 'GET', `/contacts/search?q=${encodeURIComponent(identifier)}&page=1`);
            return res.payload?.find((c) => c.identifier === identifier) ?? null;
        }
        catch {
            return null;
        }
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
async function updateContactName(cfg, contactId, newName) {
    try {
        await cwFetch(cfg, 'PATCH', `/contacts/${contactId}`, { name: newName });
    }
    catch {
        // não-fatal
    }
}
/**
 * Considera o nome "fraco" se for vazio, igual ao número, JID ou tiver formato de telefone puro.
 * Útil para detectar contatos que precisam ter nome atualizado quando descobrimos o pushName real.
 */
function isWeakName(name, phoneNumber, jid) {
    if (!name)
        return true;
    const trimmed = name.trim();
    if (!trimmed)
        return true;
    if (trimmed === phoneNumber)
        return true;
    if (trimmed === `+${phoneNumber}`)
        return true;
    if (trimmed === jid)
        return true;
    if (trimmed === jid.split('@')[0])
        return true;
    // Apenas dígitos, +, traços e espaços = nome fraco (telefone)
    if (/^[\d+\-\s()]+$/.test(trimmed))
        return true;
    return false;
}
async function getOrCreateContact(cfg, inboxId, params) {
    // Always search by identifier (JID) first — most reliable for deduplication
    const byIdentifier = await findContactByIdentifier(cfg, params.jid);
    if (byIdentifier) {
        // Se o nome atual é fraco e o novo é forte, atualiza
        if (isWeakName(byIdentifier.name, params.phoneNumber, params.jid) && !isWeakName(params.name, params.phoneNumber, params.jid)) {
            await updateContactName(cfg, byIdentifier.id, params.name);
            byIdentifier.name = params.name;
        }
        return byIdentifier;
    }
    // For individuals with a valid phone number, also search by phone
    if (!params.isGroup && params.phoneNumber) {
        const byPhone = await findContactByPhone(cfg, `+${params.phoneNumber}`);
        if (byPhone) {
            if (isWeakName(byPhone.name, params.phoneNumber, params.jid) && !isWeakName(params.name, params.phoneNumber, params.jid)) {
                await updateContactName(cfg, byPhone.id, params.name);
                byPhone.name = params.name;
            }
            return byPhone;
        }
    }
    // Create new contact
    return createContact(cfg, inboxId, {
        phoneNumber: params.isGroup ? undefined : params.phoneNumber,
        name: params.name,
        identifier: params.jid,
        isGroup: params.isGroup,
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
/** Cache: instanceName:conversationJid → conversationId
 * For groups: key = instanceName:groupJid (one conversation per group)
 * For individuals: key = instanceName:contactJid
 */
const convCache = new Map();
async function getOrCreateConversation(instanceName, cfg, inboxId, contactId, conversationJid, // group JID for groups, contact JID for individuals
opts) {
    // Cache key uses the JID of the conversation entity (group or individual)
    const cacheKey = `${instanceName}:${conversationJid}`;
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
                await cwFetch(cfg, 'POST', `/conversations/${conv.id}/toggle_status`, {
                    status: opts.conversationPending ? 'pending' : 'open',
                }).catch(() => { });
            }
            convCache.set(cacheKey, { id: conv.id, ts: Date.now() });
            return conv.id;
        }
        // Create new conversation — use JID as source_id for deduplication
        const data = {
            contact_id: contactId,
            inbox_id: inboxId,
            source_id: conversationJid,
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
        private: params.isPrivate ?? false,
        source_id: params.sourceId,
        attachments: params.attachments,
    });
}
async function loadHydratedChatMessages(instanceName, jid) {
    try {
        const whatsapp = await import('./whatsapp.js');
        if (typeof whatsapp.getInstanceChatMessagesWithMedia !== 'function') {
            return new Map();
        }
        const hydrated = await whatsapp.getInstanceChatMessagesWithMedia(instanceName, jid);
        const map = new Map();
        for (const item of hydrated) {
            let media = item.media
                ? {
                    kind: item.media.kind || 'media',
                    mimeType: item.media.mimeType,
                    fileName: item.media.fileName,
                    caption: item.media.caption,
                    base64: item.media.base64,
                    url: item.media.url,
                }
                : undefined;
            if (media && !media.base64 && item.media?.mediaId && typeof whatsapp.getInstanceChatMediaBinary === 'function') {
                const bin = whatsapp.getInstanceChatMediaBinary(instanceName, item.media.mediaId);
                if (bin.ok && bin.bytes) {
                    media = {
                        ...media,
                        mimeType: media.mimeType || bin.mimeType,
                        base64: bin.bytes.toString('base64'),
                    };
                }
            }
            map.set(item.id, {
                media,
                sender: item.senderNumber ? { number: item.senderNumber, name: item.senderName } : undefined,
                pushName: item.senderName,
                participant: item.senderNumber && jid.endsWith('@g.us')
                    ? `${String(item.senderNumber).replace(/[^0-9]/g, '')}@s.whatsapp.net`
                    : undefined,
            });
        }
        return map;
    }
    catch {
        return new Map();
    }
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
        console.log(`[chatwoot-bridge][${instanceName}] dispatch skipped: enabled=${cfg.enabled} baseUrl=${!!cfg.baseUrl} accountId=${!!cfg.accountId} token=${!!cfg.apiAccessToken} inboxId="${cfg.inboxId}" msgs=${messages.length}`);
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
            const msgId = msg.key?.id;
            if (msgId && isMessageSynced(instanceName, msgId)) {
                continue;
            }
            const result = await dispatchSingleMessage(instanceName, cwCfg, cfg, inbox, msg);
            if (msgId && !result.skipped && result.conversationId) {
                markMessageSynced(instanceName, msgId, result.conversationId);
            }
        }
        catch (err) {
            console.error(`[chatwoot-bridge][${instanceName}] dispatch error for ${msg.key?.id}`, err);
        }
    }
}
/**
 * Extract the best text content from a normalized message.
 * Falls back through: text → media.caption → type label
 */
function extractContent(msg) {
    // If text is a real message (not a placeholder like '[audio]')
    const t = msg.text;
    if (t && !t.startsWith('['))
        return t;
    // Try media caption
    if (msg.media?.caption)
        return msg.media.caption;
    // Fall back to type-based label (preserving placeholder for non-text types)
    if (msg.media?.kind && msg.media.kind !== 'text') {
        return t ?? `[${msg.media.kind}]`;
    }
    // Try raw message fields as last resort
    const raw = msg.message;
    if (raw) {
        if (typeof raw.conversation === 'string' && raw.conversation)
            return raw.conversation;
        const ext = raw.extendedTextMessage;
        if (ext?.text)
            return ext.text;
        const img = raw.imageMessage;
        if (img?.caption)
            return img.caption;
        const vid = raw.videoMessage;
        if (vid?.caption)
            return vid.caption;
        if (raw.audioMessage)
            return '[audio]';
        if (raw.stickerMessage)
            return '[sticker]';
        if (raw.documentMessage) {
            const doc = raw.documentMessage;
            return doc?.fileName ? `[document: ${doc.fileName}]` : '[document]';
        }
        if (raw.locationMessage)
            return '[location]';
        if (raw.contactMessage)
            return '[contact]';
    }
    return t ?? '[message]';
}
async function dispatchSingleMessage(instanceName, cwCfg, cfg, inbox, msg, options = {}) {
    const { key, pushName, media, sender } = msg;
    if (!key?.remoteJid || !key?.id)
        return { skipped: true };
    if (isMessageSynced(instanceName, key.id))
        return { skipped: true };
    const remoteJid = key.remoteJid;
    // Skip broadcast/status messages
    if (remoteJid === 'status@broadcast')
        return { skipped: true };
    // Skip JIDs in ignoreJids list
    if (cfg.ignoreJids?.includes(remoteJid))
        return { skipped: true };
    // Skip messages sent by the system itself (Chatwoot → WhatsApp replies).
    // These are tracked via markChatwootOriginated (chatwoot-tracking.ts) to prevent infinite loops.
    if (key.fromMe && isChatwootOriginated(key.id)) {
        return { skipped: true };
    }
    // Skip protocol/system messages (historySyncNotification, ephemeral settings, etc.).
    // Note: whatsapp.ts already pre-filters these before calling dispatchToChatwoot,
    // but keep this as a defensive check for syncHistoryToChatwoot path.
    const rawMsg = msg.message;
    if (rawMsg?.protocolMessage || rawMsg?.senderKeyDistributionMessage || rawMsg?.reactionMessage) {
        return { skipped: true };
    }
    // Skip messages with no meaningful content (unknown type with no text or media)
    const msgType = msg.messageType ?? msg.message_type ?? '';
    const hasContent = (msg.text && !msg.text.startsWith('[')) || msg.media?.caption || msg.media?.base64;
    const isGroup = remoteJid.endsWith('@g.us');
    const isFromMe = key.fromMe;
    if (msgType === 'unknown' && !hasContent && !rawMsg)
        return { skipped: true };
    // ── Contact resolution ──
    // For groups: contact is the SENDER (participant), conversation is the GROUP
    // For individuals: contact is the remote JID (or own number for outgoing)
    //
    // For outgoing messages (fromMe=true) in individual chats:
    //   - contact = the OTHER person (remoteJid)
    //   - message_type = outgoing
    //
    // For outgoing messages in groups:
    //   - contact = the GROUP (remoteJid) as a group contact
    //   - sender label shown in message content prefix
    let contactJid;
    let phoneNumber;
    let contactName;
    let conversationJid; // key for conversation cache and source_id
    // For groups: name/number of whoever actually sent the message (for content prefix)
    let senderLabel;
    // Flag importContacts: quando true, prioriza nomes reais (pushName/subject); quando false, usa o número/JID puro.
    const useRealNames = cfg.importContacts !== false;
    if (isGroup) {
        // Group: one conversation per group, contact = the group itself
        conversationJid = remoteJid;
        contactJid = remoteJid;
        phoneNumber = ''; // groups have no phone number
        // Resolver o nome REAL do grupo (subject) via socket Baileys ou chat_meta
        let groupSubject = null;
        if (useRealNames) {
            groupSubject = await resolveGroupSubject(instanceName, remoteJid);
        }
        // pushName em mensagens de grupo é o nome do REMETENTE, NÃO do grupo — ignorar para o título.
        contactName = groupSubject || (useRealNames ? remoteJid.split('@')[0] : remoteJid.split('@')[0]);
        // Identify the actual sender for message prefix (sempre, mesmo se importContacts=false — é só prefixo)
        {
            const participant = isFromMe
                ? '' // own messages in groups: no sender prefix needed (shown as outgoing)
                : (key.participant ?? '');
            if (participant) {
                const participantNumber = participant.split('@')[0];
                const formattedPhone = formatPhoneDisplay(participantNumber);
                // Resolve nome real do contato pelo Baileys store > SQLite > pushName atual.
                // Nomes "fracos" (igual ao número/JID) são filtrados por resolveContactName.
                const participantName = useRealNames
                    ? await resolveContactName(instanceName, participant, sender?.name || pushName)
                    : null;
                // Format: "+55 11 97279 8737 - Nome" or just the formatted number
                senderLabel = participantName
                    ? `${formattedPhone} - ${participantName}`
                    : formattedPhone;
            }
        }
    }
    else {
        // Individual: conversation is with the remote JID
        conversationJid = remoteJid;
        contactJid = remoteJid;
        phoneNumber = remoteJid.split('@')[0];
        if (useRealNames) {
            // Prioridade: chat_meta.title (pushName persistido em mensagens anteriores) > sender.name > pushName atual > número
            const storedTitle = getChatTitle(instanceName, remoteJid);
            contactName = storedTitle || sender?.name || pushName || phoneNumber;
        }
        else {
            // importContacts=false: usar somente número
            contactName = phoneNumber;
        }
    }
    // Get or create contact (for groups: the group or sender; for individuals: the other party)
    const contact = await getOrCreateContact(cwCfg, inbox.id, {
        phoneNumber,
        name: contactName,
        jid: contactJid,
        isGroup,
    });
    if (!contact) {
        console.warn(`[chatwoot-bridge][${instanceName}] could not get/create contact for ${contactJid}`);
        return { skipped: true };
    }
    // Get or create conversation — keyed by conversationJid (group or individual)
    const convId = await getOrCreateConversation(instanceName, cwCfg, inbox.id, contact.id, conversationJid, {
        conversationPending: cfg.conversationPending ?? false,
        reopenConversation: cfg.reopenConversation !== false,
    });
    if (!convId) {
        console.warn(`[chatwoot-bridge][${instanceName}] could not get/create conversation for ${remoteJid}`);
        return { skipped: true };
    }
    // Build message content
    let content = extractContent(msg);
    // Strip placeholder content like "[image]", "[audio]" etc — they should not appear
    // alongside the actual attachment in Chatwoot (the attachment itself is enough).
    if (content && /^\[[a-z]+(?:[:\s].*)?\]$/i.test(content.trim())) {
        content = '';
    }
    // Build attachments from media base64
    let attachments;
    if (media?.base64 && media.kind !== 'text') {
        const ext = (media.mimeType ?? '').split('/')[1] ?? 'bin';
        const filename = media.fileName || `${media.kind}_${key.id}.${ext}`;
        attachments = [
            {
                content: media.base64.replace(/^data:[^;]+;base64,/, ''),
                encoding: 'base64',
                filename,
                mime_type: media.mimeType,
            },
        ];
    }
    // For group messages from others, prefix with sender label on its own line(s)
    // so agents know who said what. Format inspired by the screenshots:
    //   **+55 11 97279 8737 - Dra Letícia Floriano Palacios:**
    //
    //   <message body>
    // The prefix is also added when there is only an attachment (no text).
    if (isGroup && !isFromMe && senderLabel) {
        const header = `**${senderLabel}:**`;
        content = content ? `${header}\n\n${content}` : header;
    }
    // Sign outgoing messages with agent name if enabled
    if (cfg.signMessages && isFromMe) {
        const delimiter = cfg.signDelimiter ?? '\n';
        const agentName = cfg.nameInbox || instanceName;
        if (content) {
            content = `*${agentName}*${delimiter}${content}`;
        }
        else if (attachments && attachments.length > 0) {
            // sign even when only attachment is present
            content = `*${agentName}*`;
        }
    }
    const messageType = isFromMe ? 'outgoing' : 'incoming';
    await sendMessageToChatwoot(cwCfg, convId, {
        content,
        messageType,
        sourceId: key.id,
        // Historical messages are sent as private notes so Chatwoot does NOT
        // fire outbound webhooks back to WhatsApp (prevents infinite loop)
        isPrivate: options.isHistorical ?? false,
        attachments,
    });
    return { skipped: false, conversationId: convId };
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
    const senderInfo = payload.sender;
    const agentName = [
        senderInfo?.available_name,
        senderInfo?.display_name,
        senderInfo?.name,
        senderInfo?.full_name,
    ].find((value) => typeof value === 'string' && value.trim())?.trim();
    const attrs = payload.content_attributes ?? {};
    const directReplySource = [
        attrs['in_reply_to_external_id'],
        attrs['reply_to_external_id'],
        attrs['quoted_external_id'],
        attrs['source_id'],
    ].find((value) => typeof value === 'string' && value.trim());
    const internalReplyId = [
        attrs['in_reply_to'],
        attrs['in_reply_to_id'],
        attrs['reply_to'],
        attrs['reply_to_id'],
        attrs['quoted_message_id'],
    ].find((value) => typeof value === 'string' || typeof value === 'number');
    let replyToId = directReplySource?.trim();
    if (!replyToId && internalReplyId != null && Array.isArray(payload.conversation?.messages)) {
        const target = payload.conversation.messages.find((message) => String(message.id ?? '') === String(internalReplyId));
        if (target?.source_id && String(target.source_id).trim()) {
            replyToId = String(target.source_id).trim();
        }
    }
    // Check for attachment
    const firstAttachment = payload.attachments?.[0];
    if (firstAttachment?.data_url) {
        return {
            jid,
            text,
            mediaUrl: firstAttachment.data_url,
            fileName: firstAttachment.file_name,
            replyToId,
            agentName,
        };
    }
    return { jid, text, replyToId, agentName };
}
// ─── Auto Create: create inbox in Chatwoot when instance connects ─────────────
/**
 * Called when a WhatsApp instance connects (connection = 'open') and autoCreate = true.
 * Creates an API inbox in Chatwoot with the configured nameInbox, then saves the inboxId back.
 * Also updates webhookSlug to the instanceName if not already set.
 */
export async function autoCreateChatwootInbox(instanceName, linkedNumber = null, force = false) {
    let cfg;
    try {
        const integrations = getInstanceIntegrations(instanceName);
        cfg = integrations.chatwoot;
    }
    catch {
        return { ok: false, error: 'failed_to_load_config' };
    }
    if (!cfg.enabled)
        return { ok: false, error: 'integration_disabled' };
    if (!force && !cfg.autoCreate)
        return { ok: false, error: 'autocreate_not_enabled' };
    if (!cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken) {
        console.warn(`[chatwoot-bridge][${instanceName}] autoCreate: missing config`);
        return { ok: false, error: 'missing_chatwoot_config' };
    }
    const cwCfg = {
        baseUrl: cfg.baseUrl,
        accountId: cfg.accountId,
        apiAccessToken: cfg.apiAccessToken,
    };
    const inboxName = cfg.nameInbox || instanceName;
    try {
        // Check if inbox already exists
        const inboxesRes = await cwFetch(cwCfg, 'GET', '/inboxes');
        const existing = inboxesRes.payload?.find((i) => i.name === inboxName);
        let inbox;
        if (existing) {
            inbox = existing;
            console.log(`[chatwoot-bridge][${instanceName}] autoCreate: inbox "${inboxName}" already exists (id=${inbox.id})`);
        }
        else {
            // Create API inbox
            const created = await cwFetch(cwCfg, 'POST', '/inboxes', {
                name: inboxName,
                channel: {
                    type: 'api',
                    webhook_url: '', // will be updated below
                },
            });
            inbox = { id: created.id, name: created.name };
            console.log(`[chatwoot-bridge][${instanceName}] autoCreate: created inbox "${inboxName}" id=${inbox.id}`);
        }
        // Determine webhook slug: use existing or default to instanceName
        const slug = cfg.webhookSlug?.trim() || instanceName;
        // Patch inbox webhook_url with our endpoint
        // We need the origin from config — use baseUrl of the local server
        // The webhook URL is built from process.env or a default
        const serverOrigin = process.env.SERVER_URL?.replace(/\/$/, '') ?? `http://localhost:${process.env.PORT ?? '8787'}`;
        const webhookUrl = `${serverOrigin}/chatwoot/webhook/${encodeURIComponent(slug)}`;
        try {
            await cwFetch(cwCfg, 'PATCH', `/inboxes/${inbox.id}`, {
                channel: { webhook_url: webhookUrl },
            });
            console.log(`[chatwoot-bridge][${instanceName}] autoCreate: set inbox webhook_url = ${webhookUrl}`);
        }
        catch (err) {
            // Non-fatal: log but continue
            console.warn(`[chatwoot-bridge][${instanceName}] autoCreate: could not patch webhook_url`, err);
        }
        // Save inboxId and webhookSlug back to config
        const { updateChatwootConfig } = await import('./integrations.js');
        updateChatwootConfig(instanceName, {
            inboxId: String(inbox.id),
            webhookSlug: slug,
        });
        // Update inbox cache
        inboxCache.set(instanceName, { inbox, ts: Date.now() });
        return { ok: true, inboxId: inbox.id, inboxName: inbox.name, webhookUrl };
    }
    catch (err) {
        console.error(`[chatwoot-bridge][${instanceName}] autoCreate error`, err);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
// ─── History sync ─────────────────────────────────────────────────────────────
/**
 * Syncs stored messages from SQLite to Chatwoot.
 * @param instanceName - WhatsApp instance name
 * @param jid - Optional: sync only this JID. If omitted, syncs all chats.
 * @param limitPerChat - Max messages per chat (default 200)
 */
export async function syncHistoryToChatwoot(instanceName, jid, limitPerChat = 200, trigger = 'manual') {
    // Reject concurrent runs
    if (isSyncRunning(instanceName)) {
        return { ok: false, synced: 0, errors: 0, error: 'A sync is already running for this instance' };
    }
    let cfg;
    try {
        const integrations = await getInstanceIntegrations(instanceName);
        cfg = integrations.chatwoot;
    }
    catch (e) {
        return { ok: false, synced: 0, errors: 0, error: 'Failed to load integrations' };
    }
    if (!cfg.enabled || !cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken || !cfg.inboxId) {
        return { ok: false, synced: 0, errors: 0, error: 'Chatwoot not configured or disabled' };
    }
    // Respeita a flag Import Messages — se desativada, sync de histórico é bloqueado
    if (cfg.importMessages === false) {
        return { ok: false, synced: 0, errors: 0, error: 'Import Messages disabled — enable it in the Chatwoot settings to sync history' };
    }
    const cwCfg = {
        baseUrl: cfg.baseUrl,
        accountId: cfg.accountId,
        apiAccessToken: cfg.apiAccessToken,
    };
    const inbox = await getInbox(instanceName, cwCfg, cfg.nameInbox || 'WhatsApp');
    if (!inbox) {
        return { ok: false, synced: 0, errors: 0, error: `Inbox "${cfg.nameInbox}" not found` };
    }
    // Calculate afterTs from daysLimitImportMessages (0 = no limit)
    const days = cfg.daysLimitImportMessages ?? 7;
    const afterTs = days > 0
        ? Date.now() - days * 24 * 60 * 60 * 1000
        : undefined;
    // Use a modified cfg with signMessages=false for historical messages
    // (they are real past messages, not agent replies — signing would corrupt content)
    const historyCfg = { ...cfg, signMessages: false };
    // Determine which chats to sync
    let chats;
    if (jid) {
        chats = [{ jid }];
    }
    else {
        chats = listChats(instanceName);
    }
    // Initialize progress
    startSyncProgress(instanceName, trigger, days);
    updateSyncProgress(instanceName, { totalChats: chats.length });
    let synced = 0;
    let errors = 0;
    let skipped = 0;
    let cancelled = false;
    try {
        for (let i = 0; i < chats.length; i++) {
            // Check cancellation between chats
            if (isSyncCancelled(instanceName)) {
                cancelled = true;
                break;
            }
            const chat = chats[i];
            const hydratedById = await loadHydratedChatMessages(instanceName, chat.jid);
            // Pass afterTs to filter messages by date
            const messages = listMessages(instanceName, chat.jid, limitPerChat, afterTs);
            // Update progress with current chat info
            const chatTitle = chat.title || getChatTitle(instanceName, chat.jid);
            updateSyncProgress(instanceName, {
                currentChatJid: chat.jid,
                currentChatTitle: chatTitle,
                processedChats: i,
                totalMessages: messages.length,
            });
            if (messages.length === 0) {
                updateSyncProgress(instanceName, { processedChats: i + 1 });
                continue;
            }
            // Already sorted ASC by ts from SQLite, but ensure it
            messages.sort((a, b) => a.timestamp - b.timestamp);
            for (const stored of messages) {
                // Check cancellation inside inner loop too
                if (isSyncCancelled(instanceName)) {
                    cancelled = true;
                    break;
                }
                // Skip messages with no meaningful content
                if (!stored.text && !stored.media)
                    continue;
                // Skip messages already synced (deduplication via SQLite tracking)
                if (isMessageSynced(instanceName, stored.id)) {
                    skipped++;
                    updateSyncProgress(instanceName, { skippedMessages: skipped });
                    continue;
                }
                // Build a minimal NormalizedMessage from stored data
                const participantJid = chat.jid.endsWith('@g.us') && !stored.fromMe && stored.senderNumber
                    ? `${stored.senderNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`
                    : undefined;
                const hydrated = hydratedById.get(stored.id);
                const hydratedParticipant = hydrated?.participant;
                const hydratedMedia = hydrated?.media;
                const hydratedSender = hydrated?.sender;
                const hydratedPushName = typeof hydrated?.pushName === 'string' ? hydrated.pushName : undefined;
                const normalized = {
                    key: {
                        remoteJid: chat.jid,
                        fromMe: stored.fromMe,
                        id: stored.id,
                        participant: hydratedParticipant || participantJid,
                    },
                    pushName: hydratedPushName || stored.senderName || undefined,
                    text: stored.text || undefined,
                    messageType: typeof hydratedMedia?.kind === 'string'
                        ? hydratedMedia.kind
                        : typeof stored.media?.kind === 'string'
                            ? stored.media.kind
                            : (stored.media ? 'media' : 'text'),
                    sender: hydratedSender || (stored.senderNumber
                        ? { number: stored.senderNumber, name: stored.senderName ?? undefined }
                        : undefined),
                    timestamp: stored.timestamp,
                    media: hydratedMedia || stored.media,
                    message: undefined,
                };
                try {
                    const result = await dispatchSingleMessage(instanceName, cwCfg, historyCfg, inbox, normalized, { isHistorical: true });
                    if (!result.skipped && result.conversationId) {
                        // Mark as synced ONLY when actually delivered to Chatwoot
                        markMessageSynced(instanceName, stored.id, result.conversationId);
                        synced++;
                        updateSyncProgress(instanceName, { syncedMessages: synced });
                    }
                    else {
                        // Dispatch returned skipped (filtered by content/system check)
                        skipped++;
                        updateSyncProgress(instanceName, { skippedMessages: skipped });
                    }
                }
                catch (err) {
                    errors++;
                    updateSyncProgress(instanceName, {
                        errorCount: errors,
                        lastError: err.message,
                    });
                    console.error(`[chatwoot-bridge][${instanceName}] sync-history error for ${stored.id}`, err.message);
                }
                // Delay to avoid rate-limiting Chatwoot (100ms between messages)
                await new Promise(r => setTimeout(r, 100));
            }
            updateSyncProgress(instanceName, { processedChats: i + 1 });
            if (cancelled)
                break;
        }
    }
    catch (err) {
        finishSyncProgress(instanceName, 'failed', err.message);
        console.error(`[chatwoot-bridge][${instanceName}] sync-history fatal:`, err.message);
        return { ok: false, synced, errors, skipped, error: err.message };
    }
    if (cancelled) {
        finishSyncProgress(instanceName, 'cancelled');
        console.log(`[chatwoot-bridge][${instanceName}] sync-history cancelled: synced=${synced} errors=${errors} skipped=${skipped} days=${days}`);
        return { ok: true, synced, errors, skipped, cancelled: true };
    }
    finishSyncProgress(instanceName, 'completed');
    console.log(`[chatwoot-bridge][${instanceName}] sync-history done: synced=${synced} errors=${errors} skipped=${skipped} days=${days} trigger=${trigger}`);
    return { ok: true, synced, errors, skipped };
}
//# sourceMappingURL=chatwoot-bridge.js.map