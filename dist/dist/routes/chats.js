import { Router } from 'express';
import { getInstance } from '../services/whatsapp.js';
import { sendError, sendOk } from '../utils/api-response.js';
import { normalizeInstanceName } from '../utils/helpers.js';
const router = Router();
function normalizeChatJid(input) {
    const value = String(input || '').trim();
    if (!value)
        return '';
    if (value.includes('@'))
        return value;
    return `${value.replace(/\D/g, '')}@s.whatsapp.net`;
}
function validateConnectedInstance(instanceName, res) {
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
function resolveInstanceName(value, res) {
    const instance = normalizeInstanceName(value, 'main');
    if (!instance) {
        sendError(res, 400, 'invalid_instance_name');
        return null;
    }
    return instance;
}
router.post('/:jid/read', async (req, res) => {
    const { jid } = req.params;
    const instance = resolveInstanceName(req.body?.instance, res);
    if (!instance)
        return;
    const messageIds = Array.isArray(req.body?.messageIds) ? req.body.messageIds : [];
    const ctx = validateConnectedInstance(instance, res);
    if (!ctx)
        return;
    if (typeof ctx.sock.readMessages !== 'function') {
        return sendError(res, 501, 'read_messages_not_supported');
    }
    if (!messageIds.length) {
        return sendError(res, 400, 'missing_message_ids');
    }
    const remoteJid = normalizeChatJid(jid);
    if (!remoteJid) {
        return sendError(res, 400, 'invalid_jid');
    }
    const keys = messageIds
        .map((id) => String(id || '').trim())
        .filter(Boolean)
        .map((id) => ({ remoteJid, id, fromMe: false }));
    if (!keys.length) {
        return sendError(res, 400, 'missing_message_ids');
    }
    await ctx.sock.readMessages(keys);
    return sendOk(res, { instance, jid: remoteJid, readCount: keys.length });
});
async function runChatModifyAction(req, res, modification, action) {
    const { jid } = req.params;
    const instance = resolveInstanceName(req.body?.instance, res);
    if (!instance)
        return;
    const ctx = validateConnectedInstance(instance, res);
    if (!ctx)
        return;
    if (typeof ctx.sock.chatModify !== 'function') {
        return sendError(res, 501, 'chat_modify_not_supported');
    }
    const remoteJid = normalizeChatJid(jid);
    if (!remoteJid) {
        return sendError(res, 400, 'invalid_jid');
    }
    try {
        await ctx.sock.chatModify(modification, remoteJid, []);
        return sendOk(res, { instance, jid: remoteJid, action });
    }
    catch (error) {
        return sendError(res, 400, 'chat_modify_failed', error instanceof Error ? error.message : String(error));
    }
}
router.post('/:jid/archive', (req, res) => runChatModifyAction(req, res, { archive: true }, 'archive'));
router.post('/:jid/unarchive', (req, res) => runChatModifyAction(req, res, { archive: false }, 'unarchive'));
router.post('/:jid/pin', (req, res) => runChatModifyAction(req, res, { pin: true }, 'pin'));
router.post('/:jid/unpin', (req, res) => runChatModifyAction(req, res, { pin: false }, 'unpin'));
router.post('/:jid/mute', (req, res) => runChatModifyAction(req, res, { mute: 60 * 60 * 24 * 365 }, 'mute'));
router.post('/:jid/unmute', (req, res) => runChatModifyAction(req, res, { mute: null }, 'unmute'));
export default router;
//# sourceMappingURL=chats.js.map