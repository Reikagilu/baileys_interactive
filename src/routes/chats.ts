import { Router } from 'express';
import { getInstance, getInstanceChatMessages } from '../services/whatsapp.js';
import { sendError, sendOk } from '../utils/api-response.js';
import { normalizeInstanceName } from '../utils/helpers.js';

const router = Router();

// Valida formato de JID: número puro ou número@s.whatsapp.net ou @g.us
const VALID_JID_RE = /^\d{7,20}@(s\.whatsapp\.net|g\.us|lid)$/;

function normalizeChatJid(input: unknown): string {
    const value = String(input ?? '').trim();
    if (!value) return '';
    if (value.includes('@')) return VALID_JID_RE.test(value) ? value : '';
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 20 ? `${digits}@s.whatsapp.net` : '';
}

function validateConnectedInstance(instanceName: string, res: Parameters<typeof sendError>[0]) {
    const ctx = getInstance(instanceName);
    if (!ctx) { sendError(res, 404, 'instance_not_found'); return null; }
    if (ctx.status !== 'connected') {
        sendError(res, 409, 'instance_not_connected', 'Instance must be connected.', { status: ctx.status });
        return null;
    }
    return ctx;
}

function resolveInstanceName(value: unknown, res: Parameters<typeof sendError>[0]): string | null {
    const instance = normalizeInstanceName(value, 'main');
    if (!instance) { sendError(res, 400, 'invalid_instance_name'); return null; }
    return instance;
}

const MAX_READ_MESSAGE_IDS = 100;

router.post('/:jid/read', async (req, res) => {
    const { jid } = req.params;
    const instance = resolveInstanceName(req.body?.instance, res);
    if (!instance) return;

    const rawIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
    const ctx = validateConnectedInstance(instance, res);
    if (!ctx) return;

    if (typeof (ctx.sock as unknown as {readMessages?: unknown}).readMessages !== 'function') {
        return sendError(res, 501, 'read_messages_not_supported');
    }
    if (!rawIds.length) return sendError(res, 400, 'missing_message_ids');
    if (rawIds.length > MAX_READ_MESSAGE_IDS) {
        return sendError(res, 400, 'too_many_message_ids', `Máximo de ${MAX_READ_MESSAGE_IDS} IDs.`, { max: MAX_READ_MESSAGE_IDS });
    }

    const remoteJid = normalizeChatJid(jid);
    if (!remoteJid) return sendError(res, 400, 'invalid_jid');

    const keys = rawIds
        .map((id: unknown) => String(id ?? '').trim())
        .filter((id: string) => /^[A-Za-z0-9_-]{1,40}$/.test(id))
        .map((id: string) => ({ remoteJid, id, fromMe: false }));

    if (!keys.length) return sendError(res, 400, 'missing_message_ids');

    try {
        await (ctx.sock as unknown as {readMessages: (k: unknown[]) => Promise<void>}).readMessages(keys);
        return sendOk(res, { instance, jid: remoteJid, readCount: keys.length });
    } catch (error) {
        return sendError(res, 500, 'read_messages_failed', error instanceof Error ? error.message : String(error));
    }
});

async function runChatModifyAction(
    req: import('express').Request,
    res: import('express').Response,
    modification: unknown,
    action: string,
) {
    const { jid } = req.params;
    const instance = resolveInstanceName(req.body?.instance, res);
    if (!instance) return;

    const ctx = validateConnectedInstance(instance, res);
    if (!ctx) return;

    if (typeof (ctx.sock as unknown as {chatModify?: unknown}).chatModify !== 'function') {
        return sendError(res, 501, 'chat_modify_not_supported');
    }

    const remoteJid = normalizeChatJid(jid);
    if (!remoteJid) return sendError(res, 400, 'invalid_jid');

    try {
        const cachedMsgs = getInstanceChatMessages(instance, remoteJid) ?? [];
        const lastMessages = cachedMsgs.slice(-5).map((m) => ({
            key: { remoteJid, id: m.id, fromMe: m.fromMe },
            messageTimestamp: m.timestamp ? Math.floor(Number(m.timestamp) / 1000) : 0,
        }));
        await (ctx.sock as unknown as {chatModify: (m: unknown, jid: string, msgs: unknown[]) => Promise<void>}).chatModify(modification, remoteJid, lastMessages);
        return sendOk(res, { instance, jid: remoteJid, action });
    } catch (error) {
        return sendError(res, 400, 'chat_modify_failed', error instanceof Error ? error.message : String(error));
    }
}

router.post('/:jid/archive',  (req, res) => runChatModifyAction(req, res, { archive: true }, 'archive'));
router.post('/:jid/unarchive',(req, res) => runChatModifyAction(req, res, { archive: false }, 'unarchive'));
router.post('/:jid/pin',      (req, res) => runChatModifyAction(req, res, { pin: true }, 'pin'));
router.post('/:jid/unpin',    (req, res) => runChatModifyAction(req, res, { pin: false }, 'unpin'));
router.post('/:jid/mute',     (req, res) => {
    const durationSec = Number(req.body?.durationSeconds);
    const mute = Number.isFinite(durationSec) && durationSec > 0
        ? Math.min(durationSec, 60 * 60 * 24 * 365)
        : 60 * 60 * 24 * 365; // default 1 ano
    return runChatModifyAction(req, res, { mute }, 'mute');
});
router.post('/:jid/unmute',   (req, res) => runChatModifyAction(req, res, { mute: null }, 'unmute'));

export default router;
