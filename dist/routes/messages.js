import { Router } from 'express';
import { config } from '../config.js';
import { getInstance, sendInstanceMediaMessage } from '../services/whatsapp.js';
import { emitWebhookEvent } from '../services/webhooks.js';
import { getIdempotentResult, storeIdempotentResult, acquireIdempotencyLock, releaseIdempotencyLock, } from '../services/idempotency.js';
import { emitInstanceEvent } from '../services/instance-config.js';
import { toJid, isUrl, normalizeInstanceName } from '../utils/helpers.js';
import { sendError, sendOk } from '../utils/api-response.js';
const router = Router();
const MIN_TYPING_MS = 300;
const MAX_TYPING_MS = 10000;
const AUTO_TYPING_BASE_MS = 700;
const AUTO_TYPING_PER_CHAR_MS = 45;
const AUTO_TYPING_JITTER_MIN_MS = -250;
const AUTO_TYPING_JITTER_MAX_MS = 350;
function parseTypingMs(raw) {
    if (raw === undefined || raw === null || raw === '')
        return null;
    const value = Number(raw);
    if (!Number.isFinite(value))
        return null;
    const rounded = Math.round(value);
    if (rounded <= 0)
        return null;
    return Math.max(MIN_TYPING_MS, Math.min(MAX_TYPING_MS, rounded));
}
function parseTypingMode(raw) {
    if (raw === undefined || raw === null || raw === '')
        return null;
    const normalized = String(raw).trim().toLowerCase();
    if (normalized === 'auto')
        return 'auto';
    if (normalized === 'manual')
        return 'manual';
    return null;
}
function randomIntBetween(min, max) {
    const floorMin = Math.ceil(min);
    const floorMax = Math.floor(max);
    return Math.floor(Math.random() * (floorMax - floorMin + 1)) + floorMin;
}
function computeAutoTypingMs(seedText) {
    const jitter = randomIntBetween(AUTO_TYPING_JITTER_MIN_MS, AUTO_TYPING_JITTER_MAX_MS);
    const raw = AUTO_TYPING_BASE_MS + seedText.length * AUTO_TYPING_PER_CHAR_MS + jitter;
    return Math.max(MIN_TYPING_MS, Math.min(MAX_TYPING_MS, raw));
}
function extractTypingSeed(body, content) {
    const bodyText = String((body.text ?? body.caption ?? body.name) ?? '').trim();
    if (bodyText)
        return bodyText;
    if (content && typeof content === 'object') {
        const candidate = content;
        const text = String((candidate.text ?? candidate.caption) ?? '').trim();
        if (text)
            return text;
        const poll = candidate.poll;
        if (poll && typeof poll === 'object') {
            const pollName = String(poll.name ?? '').trim();
            if (pollName)
                return pollName;
        }
    }
    return '';
}
function resolveTypingMs(body, content, explicitTypingMs) {
    const manualTyping = explicitTypingMs ?? parseTypingMs(body.typingMs);
    if (manualTyping)
        return manualTyping;
    const mode = parseTypingMode(body.typingMode);
    if (mode !== 'auto')
        return null;
    const seedText = extractTypingSeed(body, content);
    return computeAutoTypingMs(seedText);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function sendMessageWithTyping(ctx, jid, content, typingMs) {
    if (ctx && typingMs && typeof ctx.sock.sendPresenceUpdate === 'function') {
        const HEARTBEAT_MS = 8000;
        try {
            await ctx.sock.presenceSubscribe?.(jid);
        }
        catch {
            // ignore subscribe failures
        }
        let remaining = typingMs;
        while (remaining > 0) {
            try {
                await ctx.sock.sendPresenceUpdate('composing', jid);
            }
            catch {
                // ignore presence failures
            }
            const chunk = Math.min(remaining, HEARTBEAT_MS);
            await sleep(chunk);
            remaining -= chunk;
        }
    }
    const sent = await ctx?.sock.sendMessage(jid, content);
    if (ctx && typingMs && typeof ctx.sock.sendPresenceUpdate === 'function') {
        try {
            await ctx.sock.sendPresenceUpdate('paused', jid);
        }
        catch {
            // ignore presence failures
        }
    }
    return sent;
}
function validateInstance(instanceName, res) {
    const ctx = getInstance(instanceName);
    if (!ctx) {
        sendError(res, 404, 'instance_not_found');
        return null;
    }
    if (ctx.status !== 'connected') {
        sendError(res, 409, 'instance_not_connected', 'Instance must be connected.', { status: ctx.status });
        return null;
    }
    return ctx;
}
function resolveInstanceName(rawInstance, res) {
    const instance = normalizeInstanceName(rawInstance, 'main');
    if (!instance) {
        sendError(res, 400, 'invalid_instance_name');
        return null;
    }
    return instance;
}
function parseMenuOptions(rawOptions) {
    if (!Array.isArray(rawOptions))
        return [];
    const options = [];
    rawOptions.forEach((option, index) => {
        if (typeof option === 'string') {
            const text = option.trim();
            if (!text)
                return;
            options.push({ id: String(index + 1), text });
            return;
        }
        if (!option || typeof option !== 'object')
            return;
        const entry = option;
        const text = String((entry.text ?? entry.title) ?? '').trim();
        if (!text)
            return;
        const id = String((entry.id ?? index + 1)).trim() || String(index + 1);
        const description = String(entry.description ?? '').trim();
        options.push({ id, text, ...(description ? { description } : {}) });
    });
    return options;
}
function parseInteractiveCtas(rawCtas) {
    if (!Array.isArray(rawCtas))
        return [];
    const ctas = [];
    rawCtas.forEach((cta, index) => {
        if (!cta || typeof cta !== 'object')
            return;
        const entry = cta;
        const text = String((entry.text ?? entry.label) ?? '').trim();
        if (!text)
            return;
        const type = String(entry.type ?? 'reply').trim().toLowerCase();
        if (type === 'url') {
            const url = String(entry.url ?? '').trim();
            if (!isUrl(url))
                return;
            ctas.push({ type: 'url', text, url });
            return;
        }
        if (type === 'copy') {
            const copyCode = String((entry.copy_code ?? entry.copyCode) ?? '').trim();
            if (!copyCode)
                return;
            ctas.push({ type: 'copy', text, copy_code: copyCode });
            return;
        }
        if (type === 'call') {
            const phoneNumber = String((entry.phone_number ?? entry.phoneNumber) ?? '').trim();
            if (!phoneNumber)
                return;
            ctas.push({ type: 'call', text, phone_number: phoneNumber });
            return;
        }
        const id = String(entry.id ?? `reply_${index + 1}`).trim() || `reply_${index + 1}`;
        ctas.push({ type: 'reply', text, id });
    });
    return ctas;
}
async function sendBasicMessage(req, res, contentFactory, validationError) {
    const body = (req.body ?? {});
    const instance = resolveInstanceName(body.instance, res);
    if (!instance)
        return;
    const to = String(body.to ?? '').trim();
    const jid = toJid(to);
    if (!jid) {
        sendError(res, 400, 'invalid_phone');
        return;
    }
    const ctx = validateInstance(instance, res);
    if (!ctx)
        return;
    const idempotencyKey = String(req.header('idempotency-key') ?? req.header('x-idempotency-key') ?? '').trim();
    const idempotencyScope = `${req.path}|${instance}|${jid}`;
    if (idempotencyKey) {
        const cached = getIdempotentResult(idempotencyKey, idempotencyScope);
        if (cached) {
            sendOk(res, {
                ...(cached.result ?? {}),
                idempotency: { key: idempotencyKey, replayed: true },
            });
            return;
        }
        // Adquire o lock antes de processar — previne race condition check-and-set.
        // Se outro request com a mesma chave está em voo, rejeita com 409.
        if (!acquireIdempotencyLock(idempotencyKey, idempotencyScope)) {
            sendError(res, 409, 'idempotency_request_in_progress', 'Outro request com a mesma idempotency-key está sendo processado.');
            return;
        }
    }
    let sent;
    try {
        const content = contentFactory(body);
        if (!content) {
            sendError(res, 400, validationError);
            return;
        }
        const typingMs = resolveTypingMs(body, content);
        // Timeout de 60s para evitar que sendMessage trave indefinidamente.
        const sendTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('send_timeout')), 60_000));
        try {
            sent = await Promise.race([sendMessageWithTyping(ctx, jid, content, typingMs), sendTimeout]);
        }
        catch (sendErr) {
            const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
            sendError(res, 500, errMsg === 'send_timeout' ? 'send_timeout' : 'send_failed', errMsg);
            return;
        }
        const sentKey = sent?.key;
        const resultPayload = {
            instance,
            to: jid,
            messageId: sentKey?.id,
            typingMs: typingMs ?? 0,
            idempotency: { key: idempotencyKey || null, replayed: false },
        };
        if (idempotencyKey) {
            storeIdempotentResult(idempotencyKey, idempotencyScope, resultPayload);
        }
        emitWebhookEvent('messages.upsert', { source: 'api', direction: 'outbound', instance, to: jid, messageId: sentKey?.id, content }, instance);
        void emitInstanceEvent(instance, 'SEND_MESSAGE', {
            to: jid,
            messageId: sentKey?.id,
            content,
        });
        sendOk(res, resultPayload);
    }
    catch (err) {
        sendError(res, 500, 'send_failed', err instanceof Error ? err.message : String(err));
    }
    finally {
        if (idempotencyKey) {
            releaseIdempotencyLock(idempotencyKey, idempotencyScope);
        }
    }
}
router.post('/text', (req, res) => sendBasicMessage(req, res, (body) => {
    const text = String(body.text ?? '').trim().slice(0, 65536); // limite WhatsApp: ~64k chars
    if (!text)
        return null;
    return { text };
}, 'missing_text'));
router.post('/location', (req, res) => sendBasicMessage(req, res, (body) => {
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    const name = String(body.name ?? '').trim();
    const address = String(body.address ?? '').trim();
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        return null;
    const location = { degreesLatitude: latitude, degreesLongitude: longitude };
    if (name)
        location.name = name;
    if (address)
        location.address = address;
    return { location };
}, 'invalid_location_payload'));
router.post('/contact', (req, res) => sendBasicMessage(req, res, (body) => {
    // Sanitizar displayName: remover chars de controle (newline, CR, tab) que permitem vCard injection
    const displayName = String((body.displayName ?? body.name) ?? '')
        .trim()
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .slice(0, 100);
    const contactNumber = String((body.phoneNumber ?? body.number) ?? '').trim();
    const normalized = contactNumber.replace(/\D/g, '');
    if (!displayName || normalized.length < 10)
        return null;
    return {
        contacts: {
            displayName,
            contacts: [
                {
                    displayName,
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${displayName}\nTEL;type=CELL;type=VOICE;waid=${normalized}:${normalized}\nEND:VCARD`,
                },
            ],
        },
    };
}, 'invalid_contact_payload'));
router.post('/reaction', (req, res) => sendBasicMessage(req, res, (body) => {
    const messageId = String(body.messageId ?? '').trim();
    const reaction = String((body.reaction ?? body.text) ?? '').trim();
    if (!messageId)
        return null;
    const to = String(body.to ?? '').trim();
    const remoteJid = toJid(to);
    if (!remoteJid)
        return null;
    return {
        react: {
            text: reaction,
            key: {
                id: messageId,
                remoteJid,
                fromMe: Boolean(body.fromMe),
            },
        },
    };
}, 'invalid_reaction_payload'));
// POST /v1/messages/media
//
// Delega para `sendInstanceMediaMessage`, que baixa a URL em Buffer antes de
// enviar via Baileys. Enviar `{ url }` direto ao Baileys é problemático:
// servidores externos podem exigir cookies/headers que o Baileys não replica,
// e o WhatsApp acaba recebendo um arquivo vazio/corrompido. O download local
// também valida SSRF (`validateOutboundUrl`) e respeita o limite de 32MB.
router.post('/media', async (req, res) => {
    const body = (req.body ?? {});
    const instance = resolveInstanceName(body.instance, res);
    if (!instance)
        return;
    const to = String(body.to ?? '').trim();
    const jid = toJid(to);
    if (!jid)
        return void sendError(res, 400, 'invalid_phone');
    const ctx = validateInstance(instance, res);
    if (!ctx)
        return;
    const mediaType = String(body.mediaType ?? '').trim().toLowerCase();
    const mediaUrl = String(body.mediaUrl ?? '').trim();
    const caption = String(body.caption ?? '').trim();
    const fileName = String(body.fileName ?? '').trim();
    const mimetypeRaw = String(body.mimetype ?? '').trim();
    if (!mediaType || !mediaUrl || !isUrl(mediaUrl)) {
        return void sendError(res, 400, 'invalid_media_payload');
    }
    // Mapeia tipo declarado pelo cliente para um mimeType-base. Se o cliente
    // forneceu `mimetype` explicitamente, ele tem prioridade — caso contrário,
    // `sendInstanceMediaMessage` infere a partir do Content-Type da resposta.
    const MIME_FALLBACK = {
        image: 'image/jpeg',
        video: 'video/mp4',
        audio: body.ptt ? 'audio/ogg; codecs=opus' : 'audio/mpeg',
        document: 'application/octet-stream',
        sticker: 'image/webp',
    };
    const allowedTypes = ['image', 'video', 'audio', 'document', 'sticker'];
    if (!allowedTypes.includes(mediaType)) {
        return void sendError(res, 400, 'invalid_media_payload');
    }
    const mimeType = mimetypeRaw || MIME_FALLBACK[mediaType];
    const idempotencyKey = String(req.header('idempotency-key') ?? req.header('x-idempotency-key') ?? '').trim();
    const idempotencyScope = `${req.path}|${instance}|${jid}`;
    if (idempotencyKey) {
        const cached = getIdempotentResult(idempotencyKey, idempotencyScope);
        if (cached) {
            return void sendOk(res, {
                ...(cached.result ?? {}),
                idempotency: { key: idempotencyKey, replayed: true },
            });
        }
        if (!acquireIdempotencyLock(idempotencyKey, idempotencyScope)) {
            return void sendError(res, 409, 'idempotency_request_in_progress', 'Outro request com a mesma idempotency-key está sendo processado.');
        }
    }
    try {
        // Timeout de 90s — downloads de mídia maior podem demorar mais que 60s.
        const sendTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('send_timeout')), 90_000));
        let result;
        try {
            result = await Promise.race([
                sendInstanceMediaMessage(instance, jid, {
                    mediaUrl,
                    mimeType,
                    fileName: fileName || undefined,
                    caption: caption || undefined,
                    replyToId: body.replyToId ? String(body.replyToId) : undefined,
                    // Propaga flag explícita de nota de voz. Caller assume
                    // responsabilidade: o backend força mime audio/ogg;codecs=opus.
                    ptt: body.ptt === true,
                }),
                sendTimeout,
            ]);
        }
        catch (sendErr) {
            const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
            return void sendError(res, 500, errMsg === 'send_timeout' ? 'send_timeout' : 'send_failed', errMsg);
        }
        if (!result || !result.ok) {
            return void sendError(res, 502, 'send_failed', result?.error || 'failed_to_send_media');
        }
        const resultPayload = {
            instance,
            to: jid,
            messageId: result.id,
            mediaType,
            idempotency: { key: idempotencyKey || null, replayed: false },
        };
        if (idempotencyKey) {
            storeIdempotentResult(idempotencyKey, idempotencyScope, resultPayload);
        }
        emitWebhookEvent('messages.upsert', {
            source: 'api',
            direction: 'outbound',
            instance,
            to: jid,
            messageId: result.id,
            content: { mediaType, mediaUrl, caption, fileName, mimetype: mimeType, ptt: Boolean(body.ptt) },
        }, instance);
        void emitInstanceEvent(instance, 'SEND_MESSAGE', {
            to: jid,
            messageId: result.id,
            content: { mediaType, mediaUrl, caption, fileName, mimetype: mimeType, ptt: Boolean(body.ptt) },
        });
        return void sendOk(res, resultPayload);
    }
    catch (err) {
        return void sendError(res, 500, 'send_failed', err instanceof Error ? err.message : String(err));
    }
    finally {
        if (idempotencyKey) {
            releaseIdempotencyLock(idempotencyKey, idempotencyScope);
        }
    }
});
// Tipos de mensagem permitidos no /forward — apenas campos de conteúdo legítimos do Baileys.
const FORWARD_ALLOWED_KEYS = new Set([
    'text', 'image', 'video', 'audio', 'document', 'sticker',
    'location', 'contacts', 'react', 'poll', 'caption', 'mimetype', 'fileName', 'url',
    'ptt', 'viewOnce', 'footer', 'title',
]);
router.post('/forward', (req, res) => sendBasicMessage(req, res, (body) => {
    const text = String(body.text ?? '').trim();
    const forwardedContent = body.message;
    if (forwardedContent && typeof forwardedContent === 'object') {
        // Filtra apenas chaves permitidas para evitar injeção de campos de protocolo arbitrários.
        const safe = {};
        for (const [k, v] of Object.entries(forwardedContent)) {
            if (FORWARD_ALLOWED_KEYS.has(k))
                safe[k] = v;
        }
        if (Object.keys(safe).length > 0)
            return safe;
    }
    if (text)
        return { text };
    return null;
}, 'missing_message_or_text'));
/**
 * POST /v1/messages/send_menu
 */
router.post('/send_menu', async (req, res) => {
    const body = (req.body ?? {});
    const instance = resolveInstanceName(body.instance, res);
    if (!instance)
        return;
    const jid = toJid(String(body.to ?? ''));
    if (!jid)
        return void sendError(res, 400, 'invalid_phone');
    const options = parseMenuOptions(body.options);
    if (!body.text || options.length === 0) {
        return void sendError(res, 400, 'missing_text_or_options');
    }
    const ctx = validateInstance(instance, res);
    if (!ctx)
        return;
    const lines = options.map((opt, idx) => `${idx + 1}. ${opt.text}${opt.description ? ` — ${opt.description}` : ''}`);
    const menuText = [
        body.title ? `*${body.title}*` : null,
        body.text,
        '',
        ...lines,
        body.footer ? `\n_${body.footer}_` : null,
    ]
        .filter(Boolean)
        .join('\n');
    const menuContent = { text: menuText };
    const typingMs = resolveTypingMs(body, menuContent, parseTypingMs(body.typingMs));
    const sent = await sendMessageWithTyping(ctx, jid, menuContent, typingMs);
    const sentKey = sent?.key;
    emitWebhookEvent('messages.upsert', { source: 'api', direction: 'outbound', instance, to: jid, messageId: sentKey?.id, content: menuContent }, instance);
    void emitInstanceEvent(instance, 'SEND_MESSAGE', { to: jid, messageId: sentKey?.id, content: menuContent });
    return void sendOk(res, {
        instance,
        to: jid,
        messageId: sentKey?.id,
        style: 'plain_menu',
        typingMs: typingMs ?? 0,
    });
});
/**
 * POST /v1/messages/send_buttons_helpers
 */
router.post('/send_buttons_helpers', async (req, res) => {
    const body = (req.body ?? {});
    const instance = resolveInstanceName(body.instance, res);
    if (!instance)
        return;
    const jid = toJid(String(body.to ?? ''));
    if (!jid)
        return void sendError(res, 400, 'invalid_phone');
    const buttons = Array.isArray(body.buttons) ? body.buttons : [];
    if (!body.text || buttons.length === 0) {
        return void sendError(res, 400, 'missing_text_or_buttons');
    }
    if (buttons.length > config.limits.maxButtons) {
        return void sendError(res, 400, 'too_many_buttons', undefined, { max: config.limits.maxButtons });
    }
    const ctx = validateInstance(instance, res);
    if (!ctx)
        return;
    const nativeButtons = buttons.map((b) => ({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id }),
    }));
    const content = {
        text: body.text,
        footer: body.footer,
        interactiveButtons: { type: 'reply', buttons: nativeButtons },
    };
    const typingMs = resolveTypingMs(body, content, parseTypingMs(body.typingMs));
    const sent = await sendMessageWithTyping(ctx, jid, content, typingMs);
    const sentKey = sent?.key;
    emitWebhookEvent('messages.upsert', { source: 'api', direction: 'outbound', instance, to: jid, messageId: sentKey?.id, content }, instance);
    void emitInstanceEvent(instance, 'SEND_MESSAGE', { to: jid, messageId: sentKey?.id, content });
    return void sendOk(res, {
        instance,
        to: jid,
        messageId: sentKey?.id,
        style: 'native_buttons_reply',
        typingMs: typingMs ?? 0,
    });
});
/**
 * POST /v1/messages/send_interactive_helpers
 */
router.post('/send_interactive_helpers', async (req, res) => {
    const body = (req.body ?? {});
    const instance = resolveInstanceName(body.instance, res);
    if (!instance)
        return;
    const jid = toJid(String(body.to ?? ''));
    if (!jid)
        return void sendError(res, 400, 'invalid_phone');
    const ctas = parseInteractiveCtas(body.ctas ?? body.buttons);
    if (!body.text || ctas.length === 0) {
        return void sendError(res, 400, 'missing_text_or_ctas');
    }
    if (ctas.length > config.limits.maxButtons) {
        return void sendError(res, 400, 'too_many_ctas', undefined, { max: config.limits.maxButtons });
    }
    const ctx = validateInstance(instance, res);
    if (!ctx)
        return;
    const buttons = ctas.map((cta) => {
        if (cta.type === 'url')
            return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: cta.text, url: cta.url }) };
        if (cta.type === 'copy')
            return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: cta.text, copy_code: cta.copy_code }) };
        if (cta.type === 'call')
            return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: cta.text, phone_number: cta.phone_number }) };
        return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: cta.text, id: cta.id }) };
    });
    const content = {
        text: body.text,
        footer: body.footer,
        interactiveButtons: { type: 'cta', buttons },
    };
    const typingMs = resolveTypingMs(body, content, parseTypingMs(body.typingMs));
    const sent = await sendMessageWithTyping(ctx, jid, content, typingMs);
    const sentKey = sent?.key;
    emitWebhookEvent('messages.upsert', { source: 'api', direction: 'outbound', instance, to: jid, messageId: sentKey?.id, content }, instance);
    void emitInstanceEvent(instance, 'SEND_MESSAGE', { to: jid, messageId: sentKey?.id, content });
    return void sendOk(res, {
        instance,
        to: jid,
        messageId: sentKey?.id,
        style: 'native_buttons_cta',
        typingMs: typingMs ?? 0,
    });
});
/**
 * POST /v1/messages/send_list_helpers
 */
router.post('/send_list_helpers', async (req, res) => {
    const body = (req.body ?? {});
    const instance = resolveInstanceName(body.instance, res);
    if (!instance)
        return;
    const jid = toJid(String(body.to ?? ''));
    if (!jid)
        return void sendError(res, 400, 'invalid_phone');
    const sections = Array.isArray(body.sections) ? body.sections : [];
    if (!body.text || !body.buttonText || sections.length === 0) {
        return void sendError(res, 400, 'missing_text_or_sections');
    }
    if (sections.length > config.limits.maxListSections) {
        return void sendError(res, 400, 'too_many_sections', undefined, { max: config.limits.maxListSections });
    }
    for (const section of sections) {
        if (!Array.isArray(section.rows) || section.rows.length === 0) {
            return void sendError(res, 400, 'empty_section_rows');
        }
        if (section.rows.length > config.limits.maxListRowsPerSection) {
            return void sendError(res, 400, 'too_many_rows_per_section', undefined, {
                max: config.limits.maxListRowsPerSection,
            });
        }
    }
    const ctx = validateInstance(instance, res);
    if (!ctx)
        return;
    const content = {
        text: body.text,
        footer: body.footer,
        interactiveList: {
            type: 'nativeList',
            buttonText: body.buttonText,
            sections,
        },
    };
    const typingMs = resolveTypingMs(body, content, parseTypingMs(body.typingMs));
    const sent = await sendMessageWithTyping(ctx, jid, content, typingMs);
    const sentKey = sent?.key;
    emitWebhookEvent('messages.upsert', { source: 'api', direction: 'outbound', instance, to: jid, messageId: sentKey?.id, content }, instance);
    void emitInstanceEvent(instance, 'SEND_MESSAGE', { to: jid, messageId: sentKey?.id, content });
    return void sendOk(res, {
        instance,
        to: jid,
        messageId: sentKey?.id,
        style: 'native_list',
        typingMs: typingMs ?? 0,
    });
});
/**
 * POST /v1/messages/send_poll
 */
router.post('/send_poll', async (req, res) => {
    const body = (req.body ?? {});
    const instance = resolveInstanceName(body.instance, res);
    if (!instance)
        return;
    const jid = toJid(String(body.to ?? ''));
    if (!jid)
        return void sendError(res, 400, 'invalid_phone');
    const options = Array.isArray(body.options)
        ? body.options.filter((s) => typeof s === 'string' && Boolean(s.trim()))
        : [];
    if (!body.name || options.length < 2) {
        return void sendError(res, 400, 'missing_name_or_options');
    }
    if (options.length > config.limits.maxPollOptions) {
        return void sendError(res, 400, 'too_many_poll_options', undefined, { max: config.limits.maxPollOptions });
    }
    const selectableCount = Number.isInteger(body.selectableCount) ? Number(body.selectableCount) : 1;
    if (selectableCount < 1 || selectableCount > options.length) {
        return void sendError(res, 400, 'invalid_selectable_count');
    }
    const ctx = validateInstance(instance, res);
    if (!ctx)
        return;
    const content = {
        poll: {
            name: body.name,
            values: options,
            selectableCount,
        },
    };
    const typingMs = resolveTypingMs(body, content, parseTypingMs(body.typingMs));
    const sent = await sendMessageWithTyping(ctx, jid, content, typingMs);
    const sentKey = sent?.key;
    emitWebhookEvent('messages.upsert', { source: 'api', direction: 'outbound', instance, to: jid, messageId: sentKey?.id, content }, instance);
    void emitInstanceEvent(instance, 'SEND_MESSAGE', { to: jid, messageId: sentKey?.id, content });
    return void sendOk(res, {
        instance,
        to: jid,
        messageId: sentKey?.id,
        style: 'poll',
        typingMs: typingMs ?? 0,
    });
});
/**
 * POST /v1/messages/send_carousel_helpers
 */
router.post('/send_carousel_helpers', async (req, res) => {
    const body = (req.body ?? {});
    const instance = resolveInstanceName(body.instance, res);
    if (!instance)
        return;
    const jid = toJid(String(body.to ?? ''));
    if (!jid)
        return void sendError(res, 400, 'invalid_phone');
    const cards = Array.isArray(body.cards) ? body.cards : [];
    if (!body.text || cards.length === 0) {
        return void sendError(res, 400, 'missing_text_or_cards');
    }
    if (cards.length > config.limits.maxCarouselCards) {
        return void sendError(res, 400, 'too_many_cards', undefined, { max: config.limits.maxCarouselCards });
    }
    for (const card of cards) {
        const cardButtons = Array.isArray(card.buttons) ? card.buttons : [];
        if (cardButtons.length > config.limits.maxButtons) {
            return void sendError(res, 400, 'too_many_card_buttons', undefined, { max: config.limits.maxButtons });
        }
    }
    const ctx = validateInstance(instance, res);
    if (!ctx)
        return;
    const carouselCards = cards.map((card) => ({
        title: card.title,
        description: card.description ?? card.body,
        image: card.imageUrl ? { url: card.imageUrl } : undefined,
        buttons: (Array.isArray(card.buttons) ? card.buttons : []).map((button) => ({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({ display_text: button.text, id: button.id }),
        })),
    }));
    const content = {
        text: body.text,
        footer: body.footer,
        interactiveCarousel: {
            type: 'nativeCarousel',
            cards: carouselCards,
        },
    };
    const typingMs = resolveTypingMs(body, content, parseTypingMs(body.typingMs));
    const sent = await sendMessageWithTyping(ctx, jid, content, typingMs);
    const sentKey = sent?.key;
    emitWebhookEvent('messages.upsert', { source: 'api', direction: 'outbound', instance, to: jid, messageId: sentKey?.id, content }, instance);
    void emitInstanceEvent(instance, 'SEND_MESSAGE', { to: jid, messageId: sentKey?.id, content });
    return void sendOk(res, {
        instance,
        to: jid,
        messageId: sentKey?.id,
        style: 'native_carousel',
        typingMs: typingMs ?? 0,
    });
});
export default router;
