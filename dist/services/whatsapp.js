import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WAMessageStatus } from 'baileys';
import { config } from '../config.js';
import { isValidInstanceName } from '../utils/helpers.js';
import { signMediaUrlToken } from '../utils/media-signature.js';
import { emitWebhookEvent } from './webhooks.js';
import { emitInstanceEvent, getInstanceGeneral, getInstancePanelConfig } from './instance-config.js';
import { upsertMessage as msUpsert, updateMessageFields as msUpdateMessageFields, upsertChatMeta as msUpsertMeta, incrementUnread as msIncrementUnread, resetUnread as msResetUnread, listChats as msListChats, listMessages as msListMessages, countMessages as msCountMessages, clearInstance as msClearInstance, runInTransaction as msRunInTransaction, bulkUpsertContacts as msBulkUpsertContacts, upsertContact as msUpsertContact, setMessageDeliveryState as msSetDeliveryState, getMessageDeliveryState as msGetDeliveryState, getMessageDeliveryStates as msGetDeliveryStates, } from './message-store.js';
import { markMessageSynced } from './chatwoot-sync-store.js';
import { getInstanceIntegrations } from './integrations.js';
import { dispatchToChatwoot, autoCreateChatwootInbox } from './chatwoot-bridge.js';
import { markChatwootOriginated } from './chatwoot-tracking.js';
import { log } from '../utils/logger.js';
import { validateOutboundUrl } from '../utils/url-security.js';
import { sleep as humanSleep, randomIntBetween as humanRandomIntBetween, jitter as humanJitter, getHumanizeSettings, } from './humanize.js';
import { recordOpencodePeerSelfFix, recordMessagesUpsert, recordConnected, recordConnectionClose, recordReconnectAttempt } from '../utils/metrics.js';
const instances = new Map();
const reconnectAttempts = new Map();
const pairingIssuedAt = new Map();
const authRecoveryIssuedAt = new Map();
const alwaysOnlineIntervals = new Map();
const syncHistoryIntervals = new Map();
const forceAppStateResync = new Set();
const syncHistoryInFlight = new Set();
const syncHistoryCursor = new Map();
let processShuttingDown = false;
const runtimePath = path.resolve(process.cwd(), '.runtime');
const startupStatePath = path.join(runtimePath, 'autostart-instances.json');
const autostartInstances = new Set();
const lastStatePath = path.join(runtimePath, 'instance-last-state.json');
const lastInstanceState = new Map();
let _instanceStateDb = null;
const mediaStoragePath = path.resolve(process.cwd(), 'data', 'chat-media');
// Keep the media index in /app/data so it survives container recreation together
// with the media binaries. Older containers wrote it under .runtime; load that
// file as a fallback during migration, but persist new state to /app/data.
const mediaIndexPath = path.resolve(process.cwd(), 'data', 'chat-media-index.json');
const legacyMediaIndexPath = path.join(runtimePath, 'chat-media-index.json');
const CONTINUOUS_HISTORY_SYNC_MS = Math.max(30_000, Number(process.env.CONTINUOUS_HISTORY_SYNC_MS ?? 60_000));
const CONTINUOUS_HISTORY_BATCH_CHATS = Math.max(1, Math.min(10, Number(process.env.CONTINUOUS_HISTORY_BATCH_CHATS ?? 4)));
const CONTINUOUS_HISTORY_FETCH_COUNT = Math.max(20, Math.min(250, Number(process.env.CONTINUOUS_HISTORY_FETCH_COUNT ?? 100)));
const MESSAGE_WRAPPER_KEYS = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
];
const MEDIA_NODE_BY_KIND = {
    audio: { field: 'audioMessage', downloadType: 'audio' },
    image: { field: 'imageMessage', downloadType: 'image' },
    video: { field: 'videoMessage', downloadType: 'video' },
    sticker: { field: 'stickerMessage', downloadType: 'sticker' },
    document: { field: 'documentMessage', downloadType: 'document' },
};
const EXTERNAL_MESSAGE_STRIP_KEYS = new Set([
    'waveform',
    'messageContextInfo',
]);
const outboundDeliveryStates = new Map();
const outboundDeliveryWaiters = new Map();
const outboundDeliveryCleanupTimers = new Map();
function makeOutboundDeliveryKey(instance, messageId) {
    return `${instance}:${messageId}`;
}
function cleanupOutboundDeliveryStateLater(key, finalState) {
    const existing = outboundDeliveryCleanupTimers.get(key);
    if (existing)
        clearTimeout(existing);
    const ttlMs = finalState ? 10 * 60_000 : 30 * 60_000;
    const timer = setTimeout(() => {
        outboundDeliveryCleanupTimers.delete(key);
        outboundDeliveryStates.delete(key);
        outboundDeliveryWaiters.delete(key);
    }, ttlMs);
    timer.unref?.();
    outboundDeliveryCleanupTimers.set(key, timer);
}
function notifyOutboundDeliveryWaiters(key, snapshot) {
    const waiters = outboundDeliveryWaiters.get(key);
    if (!waiters || waiters.size === 0)
        return;
    for (const waiter of waiters)
        waiter(snapshot);
}
function isFinalOutboundDeliveryState(snapshot) {
    return snapshot.state === 'delivered' || snapshot.state === 'read' || snapshot.state === 'played' || snapshot.state === 'failed';
}
function deliverySnapshotFromStored(instance, messageId, stored) {
    const levels = {
        failed: -1, pending: 0, server_ack: 1, delivered: 2, read: 3, played: 4,
    };
    return {
        instance,
        messageId,
        state: stored.state,
        level: levels[stored.state],
        description: stored.description ?? `Estado persistido: ${stored.state}`,
        event: stored.event ?? 'messages.update',
        statusCode: stored.statusCode,
        updatedAt: stored.updatedAt,
    };
}
function setOutboundDeliveryState(snapshot) {
    const key = makeOutboundDeliveryKey(snapshot.instance, snapshot.messageId);
    const persisted = !outboundDeliveryStates.has(key)
        ? msGetDeliveryState(snapshot.instance, snapshot.messageId)
        : undefined;
    const current = outboundDeliveryStates.get(key)
        ?? (persisted ? deliverySnapshotFromStored(snapshot.instance, snapshot.messageId, persisted) : undefined);
    const currentSucceeded = current && ['delivered', 'read', 'played'].includes(current.state);
    // Failure must replace pending/server_ack, but must never regress a confirmed delivery.
    if (snapshot.state === 'failed' && currentSucceeded)
        return;
    if (current?.state === 'failed' && snapshot.state !== 'failed')
        return;
    if (snapshot.state !== 'failed' && current && current.level > snapshot.level)
        return;
    if (current && current.level === snapshot.level && current.updatedAt > snapshot.updatedAt)
        return;
    outboundDeliveryStates.set(key, snapshot);
    msSetDeliveryState(snapshot.instance, snapshot.messageId, {
        state: snapshot.state,
        statusCode: snapshot.statusCode,
        updatedAt: snapshot.updatedAt,
        event: snapshot.event,
        description: snapshot.description,
    });
    if (snapshot.state === 'failed') {
        log.whatsapp.child(snapshot.instance).error(`outbound_delivery_failed msgId=${snapshot.messageId} statusCode=${String(snapshot.statusCode ?? 'n/a')}`);
        emitWebhookEvent('message.delivery.failed', snapshot, snapshot.instance);
    }
    cleanupOutboundDeliveryStateLater(key, isFinalOutboundDeliveryState(snapshot));
    notifyOutboundDeliveryWaiters(key, snapshot);
}
function mapMessageStatus(status) {
    const numericStatus = typeof status === 'number' && Number.isFinite(status) ? status : undefined;
    if (numericStatus === WAMessageStatus.ERROR) {
        return {
            state: 'failed',
            level: -1,
            description: 'WhatsApp rejeitou a mensagem apos o envio.',
            statusCode: numericStatus,
        };
    }
    if (numericStatus === WAMessageStatus.PENDING) {
        return {
            state: 'pending',
            level: 0,
            description: 'Mensagem aceita localmente e aguardando confirmacao do WhatsApp.',
            statusCode: numericStatus,
        };
    }
    if (numericStatus === WAMessageStatus.SERVER_ACK) {
        return {
            state: 'server_ack',
            level: 1,
            description: 'WhatsApp confirmou o recebimento no servidor, mas ainda sem entrega ao aparelho do destinatario.',
            statusCode: numericStatus,
        };
    }
    if (numericStatus === WAMessageStatus.DELIVERY_ACK) {
        return {
            state: 'delivered',
            level: 2,
            description: 'Mensagem entregue ao aparelho do destinatario.',
            statusCode: numericStatus,
        };
    }
    if (numericStatus === WAMessageStatus.READ) {
        return {
            state: 'read',
            level: 3,
            description: 'Mensagem lida pelo destinatario.',
            statusCode: numericStatus,
        };
    }
    if (numericStatus === WAMessageStatus.PLAYED) {
        return {
            state: 'played',
            level: 4,
            description: 'Mensagem de audio/video reproduzida pelo destinatario.',
            statusCode: numericStatus,
        };
    }
    return {
        state: 'pending',
        level: 0,
        description: 'Status de entrega ainda nao confirmado pelo WhatsApp.',
        statusCode: numericStatus,
    };
}
function extractReceiptSnapshot(receipt) {
    const data = isRecord(receipt) ? receipt : {};
    const userJid = typeof data.userJid === 'string' ? data.userJid : undefined;
    const deliveryTimestamp = typeof data.receiptTimestamp === 'number'
        ? data.receiptTimestamp
        : typeof data.deliveryTimestamp === 'number'
            ? data.deliveryTimestamp
            : undefined;
    const readTimestamp = typeof data.readTimestamp === 'number' ? data.readTimestamp : undefined;
    return { userJid, deliveryTimestamp, readTimestamp };
}
function updateOutboundDeliveryFromMessageUpdate(instance, payload) {
    const updates = Array.isArray(payload) ? payload : [payload];
    for (const item of updates) {
        if (!isRecord(item) || !isRecord(item.key) || !isRecord(item.update))
            continue;
        const messageId = typeof item.key.id === 'string' ? item.key.id.trim() : '';
        if (!messageId)
            continue;
        const mapped = mapMessageStatus(item.update.status);
        setOutboundDeliveryState({
            instance,
            messageId,
            state: mapped.state,
            level: mapped.level,
            description: mapped.description,
            event: 'messages.update',
            statusCode: mapped.statusCode,
            updatedAt: Date.now(),
        });
    }
}
function updateOutboundDeliveryFromReceiptUpdate(instance, payload) {
    const updates = Array.isArray(payload) ? payload : [payload];
    for (const item of updates) {
        if (!isRecord(item) || !isRecord(item.key))
            continue;
        const messageId = typeof item.key.id === 'string' ? item.key.id.trim() : '';
        if (!messageId)
            continue;
        const receipt = extractReceiptSnapshot(item.receipt);
        const state = {
            instance,
            messageId,
            state: receipt.readTimestamp ? 'read' : 'delivered',
            level: receipt.readTimestamp ? 3 : 2,
            description: receipt.readTimestamp
                ? 'Mensagem lida pelo destinatario.'
                : 'Mensagem entregue ao aparelho do destinatario.',
            event: 'message-receipt.update',
            updatedAt: Date.now(),
            receipt,
        };
        setOutboundDeliveryState(state);
    }
}
export async function validateRecipientOnWhatsApp(name, rawPhone) {
    const input = String(rawPhone ?? '').trim();
    const normalizedPhone = input.replace(/\D+/g, '');
    const jid = normalizedPhone ? `${normalizedPhone}@s.whatsapp.net` : '';
    if (!normalizedPhone) {
        return {
            ok: false,
            input,
            normalizedPhone,
            jid,
            error: 'invalid_phone',
            message: 'Numero vazio ou invalido. Envie apenas DDI+DDD+numero.',
        };
    }
    const ctx = instances.get(name);
    if (!ctx || !ctx.sock) {
        return {
            ok: false,
            input,
            normalizedPhone,
            jid,
            error: 'instance_not_found',
            message: 'Instancia nao encontrada para validar o destinatario.',
        };
    }
    if (ctx.status !== 'connected') {
        return {
            ok: false,
            input,
            normalizedPhone,
            jid,
            error: 'instance_not_connected',
            message: 'Instancia desconectada. Conecte a sessao antes de validar o destinatario.',
        };
    }
    if (typeof ctx.sock.onWhatsApp !== 'function') {
        return {
            ok: true,
            input,
            normalizedPhone,
            jid,
            exists: undefined,
            message: 'A biblioteca atual nao suporta validacao previa de numero; envio seguira sem essa checagem.',
        };
    }
    try {
        const results = await ctx.sock.onWhatsApp(normalizedPhone);
        const first = Array.isArray(results) ? results[0] : undefined;
        const exists = first?.exists === true;
        const resolvedJid = typeof first?.jid === 'string' && first.jid.trim() ? first.jid.trim() : jid;
        if (!exists) {
            return {
                ok: false,
                input,
                normalizedPhone,
                jid: resolvedJid,
                exists: false,
                error: 'recipient_not_on_whatsapp',
                message: 'Numero validado antes do envio e nao encontrado no WhatsApp.',
            };
        }
        return {
            ok: true,
            input,
            normalizedPhone,
            jid: resolvedJid,
            exists: true,
            message: 'Numero confirmado no WhatsApp antes do envio.',
        };
    }
    catch (err) {
        return {
            ok: false,
            input,
            normalizedPhone,
            jid,
            error: 'recipient_validation_failed',
            message: err instanceof Error ? err.message : String(err),
        };
    }
}
export async function waitForOutboundDelivery(instance, messageId, options) {
    const timeoutMs = Math.max(1000, Math.min(60_000, Math.round(options?.timeoutMs ?? 15_000)));
    const minLevel = options?.minState === 'read' ? 3 : options?.minState === 'server_ack' ? 1 : 2;
    const key = makeOutboundDeliveryKey(instance, messageId);
    const persisted = msGetDeliveryState(instance, messageId);
    const current = outboundDeliveryStates.get(key)
        ?? (persisted ? deliverySnapshotFromStored(instance, messageId, persisted) : undefined);
    if (current && !outboundDeliveryStates.has(key))
        outboundDeliveryStates.set(key, current);
    if (current && (current.level >= minLevel || current.state === 'failed')) {
        return { snapshot: current, timedOut: false };
    }
    const pendingSnapshot = current ?? {
        instance,
        messageId,
        state: 'pending',
        level: 0,
        description: 'Mensagem enviada para o WhatsApp, aguardando confirmacao de entrega.',
        event: 'send',
        updatedAt: Date.now(),
    };
    if (!current)
        setOutboundDeliveryState(pendingSnapshot);
    return await new Promise((resolve) => {
        const waiters = outboundDeliveryWaiters.get(key) ?? new Set();
        const finalize = (snapshot, timedOut) => {
            clearTimeout(timer);
            waiters.delete(handler);
            if (waiters.size === 0)
                outboundDeliveryWaiters.delete(key);
            resolve({ snapshot, timedOut });
        };
        const handler = (snapshot) => {
            if (snapshot.state === 'failed' || snapshot.level >= minLevel) {
                finalize(snapshot, false);
            }
        };
        waiters.add(handler);
        outboundDeliveryWaiters.set(key, waiters);
        const timer = setTimeout(() => {
            finalize(outboundDeliveryStates.get(key) ?? pendingSnapshot, true);
        }, timeoutMs);
        timer.unref?.();
    });
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
const chatCache = new Map();
const chatMediaBinaryStore = new Map();
const chatMediaStorageKeyIndex = new Map();
const chatMediaEnsureInFlight = new Map();
// Cached dynamic import promises — Node caches modules internally but each
// `await import(...)` still creates a Promise microtask. Caching the Promise
// itself eliminates that overhead in the high-frequency media paths.
let _baileysModulePromise = null;
let _baileysMediaModulePromise = null;
function getBaileysModule() {
    if (!_baileysModulePromise)
        _baileysModulePromise = import('baileys');
    return _baileysModulePromise;
}
function getBaileysMediaModule() {
    if (!_baileysMediaModulePromise)
        _baileysMediaModulePromise = import('baileys/lib/Utils/messages-media.js');
    return _baileysMediaModulePromise;
}
function buildMediaUrl(instance, mediaId) {
    const exp = Math.floor(Date.now() / 1000) + config.media.signedUrlTtlSeconds;
    const sig = signMediaUrlToken(config.media.signedUrlSecret, instance, mediaId, exp);
    return `/v1/media/${encodeURIComponent(instance)}/${encodeURIComponent(mediaId)}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
}
function mediaFileExtension(kind, mimeType) {
    const value = String(mimeType ?? '').trim().toLowerCase();
    if (value === 'image/jpeg')
        return 'jpg';
    if (value === 'image/png')
        return 'png';
    if (value === 'image/webp')
        return 'webp';
    if (value === 'image/gif')
        return 'gif';
    if (value === 'video/mp4')
        return 'mp4';
    if (value === 'video/webm')
        return 'webm';
    if (value === 'audio/ogg')
        return 'ogg';
    if (value === 'audio/mpeg')
        return 'mp3';
    if (value === 'audio/mp4')
        return 'm4a';
    if (value === 'application/pdf')
        return 'pdf';
    if (kind === 'video')
        return 'mp4';
    if (kind === 'audio')
        return 'ogg';
    if (kind === 'sticker')
        return 'webp';
    if (kind === 'image')
        return 'jpg';
    return 'bin';
}
function mediaKindFromExtension(ext) {
    const value = ext.replace(/^\./, '').trim().toLowerCase();
    if (value === 'jpg' || value === 'jpeg')
        return { kind: 'image', mimeType: 'image/jpeg' };
    if (value === 'png')
        return { kind: 'image', mimeType: 'image/png' };
    if (value === 'webp')
        return { kind: 'sticker', mimeType: 'image/webp' };
    if (value === 'gif')
        return { kind: 'image', mimeType: 'image/gif' };
    if (value === 'mp4')
        return { kind: 'video', mimeType: 'video/mp4' };
    if (value === 'webm')
        return { kind: 'video', mimeType: 'video/webm' };
    if (value === 'ogg')
        return { kind: 'audio', mimeType: 'audio/ogg' };
    if (value === 'mp3')
        return { kind: 'audio', mimeType: 'audio/mpeg' };
    if (value === 'm4a')
        return { kind: 'audio', mimeType: 'audio/mp4' };
    if (value === 'pdf')
        return { kind: 'document', mimeType: 'application/pdf' };
    return null;
}
async function sha256File(filePath) {
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}
function loadMediaIndex() {
    chatMediaBinaryStore.clear();
    chatMediaStorageKeyIndex.clear();
    try {
        const sourcePath = fs.existsSync(mediaIndexPath)
            ? mediaIndexPath
            : (fs.existsSync(legacyMediaIndexPath) ? legacyMediaIndexPath : '');
        if (!sourcePath)
            return;
        const raw = fs.readFileSync(sourcePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object')
            return;
        let migrated = false;
        for (const [mediaId, value] of Object.entries(parsed)) {
            if (!value || typeof value !== 'object')
                continue;
            const entry = value;
            if (!entry.instance || !entry.relativePath || !entry.mimeType || !entry.kind)
                continue;
            const normalized = {
                mediaId,
                instance: String(entry.instance),
                kind: entry.kind,
                mimeType: String(entry.mimeType),
                relativePath: String(entry.relativePath),
                sizeBytes: Number(entry.sizeBytes ?? 0),
                createdAt: Number(entry.createdAt ?? Date.now()),
                expiresAt: Number(entry.expiresAt ?? Date.now()),
                storageKey: entry.storageKey ? String(entry.storageKey) : undefined,
            };
            const absolutePath = path.join(mediaStoragePath, normalized.relativePath);
            if (fs.existsSync(absolutePath)) {
                chatMediaBinaryStore.set(mediaId, normalized);
                if (normalized.storageKey)
                    chatMediaStorageKeyIndex.set(normalized.storageKey, mediaId);
            }
        }
        if (sourcePath === legacyMediaIndexPath && chatMediaBinaryStore.size > 0) {
            migrated = true;
        }
        if (migrated)
            persistMediaIndex();
    }
    catch {
        // ignore malformed index
    }
}
// Debounce para persistMediaIndex: em grupos ativos com muitas mídias,
// chamadas síncronas a cada mensagem geram I/O excessivo. Agrupa em 1.5s.
let _persistMediaIndexTimer = null;
function persistMediaIndex() {
    if (_persistMediaIndexTimer)
        return;
    _persistMediaIndexTimer = setTimeout(() => {
        _persistMediaIndexTimer = null;
        try {
            fs.mkdirSync(runtimePath, { recursive: true });
            const payload = Object.fromEntries([...chatMediaBinaryStore.entries()].sort(([a], [b]) => a.localeCompare(b)));
            fs.writeFileSync(mediaIndexPath, JSON.stringify(payload, null, 2), 'utf8');
        }
        catch {
            // ignore persistence failures
        }
    }, 1500);
}
function normalizeTimestamp(raw) {
    const toMs = (value) => {
        if (!Number.isFinite(value) || value <= 0)
            return Date.now();
        return value < 1000000000000 ? value * 1000 : value;
    };
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return toMs(raw);
    }
    if (typeof raw === 'string') {
        const parsed = Number(raw);
        if (Number.isFinite(parsed))
            return toMs(parsed);
    }
    if (typeof raw === 'object' && raw !== null) {
        const maybe = raw;
        if (typeof maybe.toNumber === 'function') {
            const val = maybe.toNumber();
            if (Number.isFinite(val))
                return toMs(val);
        }
        if (typeof maybe.low === 'number') {
            return toMs(maybe.low);
        }
    }
    return Date.now();
}
/**
 * Like normalizeTimestamp but returns 0 instead of Date.now() when the raw
 * value is missing/invalid. Used for chat metadata (conversationTimestamp)
 * so that an absent timestamp does NOT overwrite a previously stored one.
 */
function normalizeTimestampOrZero(raw) {
    const toMs = (value) => {
        if (!Number.isFinite(value) || value <= 0)
            return 0;
        return value < 1000000000000 ? value * 1000 : value;
    };
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        return toMs(raw);
    }
    if (typeof raw === 'string') {
        const parsed = Number(raw);
        if (Number.isFinite(parsed))
            return toMs(parsed);
    }
    if (typeof raw === 'object' && raw !== null) {
        const maybe = raw;
        if (typeof maybe.toNumber === 'function') {
            const val = maybe.toNumber();
            if (Number.isFinite(val))
                return toMs(val);
        }
        if (typeof maybe.low === 'number') {
            return toMs(maybe.low);
        }
    }
    return 0;
}
function extractChatTitleFromPayload(payload) {
    const chat = (payload ?? {});
    const title = String(chat.name ?? '').trim()
        || String(chat.subject ?? '').trim()
        || String(chat.pushName ?? '').trim()
        || String(chat.notify ?? '').trim();
    if (title)
        return title;
    const jid = String(chat.id ?? chat.jid ?? '').trim();
    if (!jid)
        return '-';
    return jid.split('@')[0] || jid;
}
function loadAutostartState() {
    autostartInstances.clear();
    try {
        if (!fs.existsSync(startupStatePath))
            return;
        const raw = fs.readFileSync(startupStatePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return;
        parsed
            .map((item) => String(item ?? '').trim())
            .filter((name) => name.length > 0)
            .forEach((name) => autostartInstances.add(name));
    }
    catch {
        // ignore malformed file
    }
}
function getInstanceStateDb() {
    if (_instanceStateDb)
        return _instanceStateDb;
    const resolved = path.resolve(process.cwd(), config.messages.dbPath);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(resolved);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`
    CREATE TABLE IF NOT EXISTS instance_runtime_state (
      instance        TEXT PRIMARY KEY,
      status          TEXT NOT NULL,
      was_connected   INTEGER NOT NULL DEFAULT 0,
      stopped_by_user INTEGER NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL
    )
  `);
    _instanceStateDb = db;
    return db;
}
function loadLastInstanceState() {
    lastInstanceState.clear();
    try {
        const rows = getInstanceStateDb().prepare(`
      SELECT instance, status, was_connected, stopped_by_user, updated_at
      FROM instance_runtime_state
    `).all();
        for (const row of rows) {
            const normalizedName = String(row.instance ?? '').trim();
            if (!isValidInstanceName(normalizedName))
                continue;
            lastInstanceState.set(normalizedName, {
                status: String(row.status ?? 'unknown'),
                wasConnected: Boolean(row.was_connected),
                stoppedByUser: Boolean(row.stopped_by_user),
                updatedAt: String(row.updated_at ?? new Date().toISOString()),
            });
        }
    }
    catch {
        // Fallback de compatibilidade com instalações antigas que ainda só têm o
        // arquivo local de estado.
        try {
            if (!fs.existsSync(lastStatePath))
                return;
            const raw = fs.readFileSync(lastStatePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object')
                return;
            for (const [name, value] of Object.entries(parsed)) {
                const normalizedName = String(name ?? '').trim();
                if (!isValidInstanceName(normalizedName))
                    continue;
                if (!value || typeof value !== 'object')
                    continue;
                const record = value;
                lastInstanceState.set(normalizedName, {
                    status: String(record.status ?? 'unknown'),
                    wasConnected: Boolean(record.wasConnected),
                    stoppedByUser: Boolean(record.stoppedByUser),
                    updatedAt: String(record.updatedAt ?? new Date().toISOString()),
                });
            }
        }
        catch {
            // ignore malformed fallback file
        }
    }
}
function persistAutostartState() {
    try {
        fs.mkdirSync(runtimePath, { recursive: true });
        const payload = JSON.stringify([...autostartInstances].sort(), null, 2);
        fs.writeFileSync(startupStatePath, payload, 'utf8');
    }
    catch {
        // ignore persistence failures
    }
}
function persistLastInstanceState() {
    try {
        const db = getInstanceStateDb();
        const upsert = db.prepare(`
      INSERT INTO instance_runtime_state (instance, status, was_connected, stopped_by_user, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(instance) DO UPDATE SET
        status = excluded.status,
        was_connected = excluded.was_connected,
        stopped_by_user = excluded.stopped_by_user,
        updated_at = excluded.updated_at
    `);
        // Envolver em transação: com N instâncias, N upserts individuais sem transação
        // causam N flushes do WAL, bloqueando o event loop desnecessariamente.
        db.exec('BEGIN');
        try {
            for (const [name, state] of lastInstanceState.entries()) {
                upsert.run(name, state.status, state.wasConnected ? 1 : 0, state.stoppedByUser ? 1 : 0, state.updatedAt);
            }
            db.exec('COMMIT');
        }
        catch (txErr) {
            try {
                db.exec('ROLLBACK');
            }
            catch { /* ignore */ }
            throw txErr;
        }
        // Mantém o arquivo local apenas como espelho legível/fallback legado.
        fs.mkdirSync(runtimePath, { recursive: true });
        const payload = Object.fromEntries([...lastInstanceState.entries()].sort(([a], [b]) => a.localeCompare(b)));
        fs.writeFileSync(lastStatePath, JSON.stringify(payload, null, 2), 'utf8');
    }
    catch {
        // ignore persistence failures
    }
}
function trackLastInstanceState(name, patch) {
    const current = lastInstanceState.get(name) ?? {
        status: 'unknown',
        wasConnected: false,
        stoppedByUser: false,
        updatedAt: new Date().toISOString(),
    };
    const next = {
        status: patch.status ?? current.status,
        wasConnected: patch.wasConnected ?? current.wasConnected,
        stoppedByUser: patch.stoppedByUser ?? current.stoppedByUser,
        updatedAt: new Date().toISOString(),
    };
    lastInstanceState.set(name, next);
    persistLastInstanceState();
}
function persistCurrentInstanceStatesForShutdown() {
    for (const [name, ctx] of instances.entries()) {
        const activeStatus = ctx.status === 'connected' || ctx.status === 'connecting' || ctx.status === 'qr';
        trackLastInstanceState(name, {
            status: ctx.status,
            wasConnected: activeStatus ? true : (lastInstanceState.get(name)?.wasConnected ?? false),
            stoppedByUser: false,
        });
    }
}
function markAutostart(name, enabled) {
    if (enabled) {
        autostartInstances.add(name);
    }
    else {
        autostartInstances.delete(name);
    }
    persistAutostartState();
}
loadAutostartState();
loadLastInstanceState();
function registerShutdownStateHandlers() {
    const markShutdown = () => {
        processShuttingDown = true;
        persistCurrentInstanceStatesForShutdown();
    };
    process.once('SIGINT', markShutdown);
    process.once('SIGTERM', markShutdown);
    process.once('beforeExit', markShutdown);
    process.once('exit', markShutdown);
}
registerShutdownStateHandlers();
function extractOwnLidPrefix(creds) {
    const lid = String(creds?.me?.lid ?? '').trim();
    return lid ? lid.split(':')[0].split('@')[0] : '';
}
function extractOwnPhonePrefix(creds) {
    const id = String(creds?.me?.id ?? '').trim();
    return id ? id.split(':')[0].split('@')[0] : '';
}
function hasCorruptExistingRegistration(instanceName, creds) {
    if (!creds || creds.registered !== false)
        return false;
    const hasPersistedIdentity = Boolean(String(creds.me?.id ?? '').trim() || String(creds.me?.lid ?? '').trim());
    if (!hasPersistedIdentity)
        return false;
    const priorState = lastInstanceState.get(instanceName);
    const hasCompletedPairingState = isCompletedPairingState(creds);
    // In this Baileys fork, QR-linked sessions can remain with registered=false
    // even after successful pairing. Treat it as corruption only when the auth
    // looks incomplete AND the instance had previously been connected.
    if (hasCompletedPairingState)
        return false;
    return Boolean(priorState?.wasConnected);
}
function isCompletedPairingState(creds) {
    return Boolean(creds?.account) || (Array.isArray(creds?.signalIdentities) && creds.signalIdentities.length > 0);
}
function resetInstanceAuthState(authPath) {
    try {
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
        }
    }
    catch {
        // best effort
    }
    try {
        fs.mkdirSync(authPath, { recursive: true });
    }
    catch {
        // best effort
    }
}
function maybeResetInstanceAuthState(name, authPath, reason) {
    if (!config.whatsapp.autoResetCorruptAuth) {
        log.whatsapp.child(name).error(`auto_auth_reset_blocked  reason=${reason}  action=preserve_auth  hint=enable_WHATSAPP_AUTO_RESET_CORRUPT_AUTH_if_you_really_want_destructive_recovery`);
        return false;
    }
    resetInstanceAuthState(authPath);
    return true;
}
function repairInconsistentOwnSignalSessions(authPath, creds, instanceName) {
    if (!hasCorruptExistingRegistration(instanceName, creds))
        return;
    if (!config.whatsapp.autoResetCorruptAuth) {
        log.whatsapp.child(instanceName).warn('auth-repair skipped  action=preserve_auth  reason=auto_reset_disabled');
        return;
    }
    const ownLidPrefix = extractOwnLidPrefix(creds);
    if (!ownLidPrefix || !fs.existsSync(authPath))
        return;
    try {
        const entries = fs.readdirSync(authPath, { withFileTypes: true });
        const stalePrefixes = [
            `session-${ownLidPrefix}_1.`,
            `sender-key-`,
        ];
        let deleted = 0;
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const fileName = entry.name;
            const isOwnSession = fileName.startsWith(stalePrefixes[0]) && fileName.endsWith('.json');
            const isOwnSenderKey = fileName.startsWith(stalePrefixes[1]) &&
                fileName.includes(`--${ownLidPrefix}_1--`) &&
                fileName.endsWith('.json');
            if (!isOwnSession && !isOwnSenderKey)
                continue;
            try {
                fs.unlinkSync(path.join(authPath, fileName));
                deleted += 1;
            }
            catch {
                // ignore individual file removal failures
            }
        }
        if (deleted > 0) {
            log.whatsapp.warn(`auth-repair  removed ${deleted} stale own-device signal files  lid=${ownLidPrefix}`);
        }
    }
    catch (err) {
        log.whatsapp.warn(`auth-repair  falha ao limpar arquivos de sinal em ${authPath}`, err);
    }
}
function hasValidAuthForRestore(name, authFolder) {
    // Verifica se a pasta de auth tem creds.json registrado (>0 bytes) e nao
    // eh placeholder vazio. Usado por shouldRestoreInstanceOnStartup pra
    // distinguir "instancia morreu mas creds estao ok" de "creds foram apagadas".
    try {
        const authPath = path.resolve(process.cwd(), authFolder, name);
        const credsPath = path.join(authPath, 'creds.json');
        if (!fs.existsSync(credsPath))
            return false;
        const stat = fs.statSync(credsPath);
        if (stat.size === 0)
            return false;
        // Tenta parsear pra garantir que nao eh JSON malformado
        const raw = fs.readFileSync(credsPath, 'utf8');
        const parsed = JSON.parse(raw);
        // registered=false indica sessao nao-pareada (estado intermediario).
        // Pode ser recovery legit, mas eh mais arriscado recuperar.
        return parsed.registered === true;
    }
    catch {
        return false;
    }
}
function shouldRestoreInstanceOnStartup(state, name, authFolder = 'auth') {
    if (state?.stoppedByUser)
        return false;
    // Restore only if the last persisted state was still active. This preserves
    // the exact last known state across restarts: if it was disconnected before
    // shutdown, it must stay disconnected after boot.
    if (state) {
        const status = state.status;
        if (status === 'connected' || status === 'connecting' || status === 'qr') {
            return true;
        }
        // F5 fix: se creds ainda estão registrados, tenta recuperar.
        // 'disconnected' pode ser resultado de reconnect_exhausted (Beyound desistiu
        // após 6 tentativas). As creds no disco continuam válidas — vale tentar
        // recriar o socket. Se falhar, createInstance vai setar auth_invalid.
        if (status === 'disconnected' || status === 'auth_invalid') {
            return hasValidAuthForRestore(name, authFolder);
        }
        return false;
    }
    // Backward compatibility for older installs that have auth folders but no
    // persisted last-state metadata yet.
    return autostartInstances.has(name);
}
/**
 * Throttled cleanup das sessões Signal próprias do usuário (note-to-self) que
 * caíram em estado corrompido (Counter Error / Bad MAC) — tipicamente após
 * reconexões durante o flush de stanzas pendentes.
 *
 * Sem essa função, o Baileys aguarda `maxMsgRetryCount` (configurado para 2)
 * tentativas antes de limpar a sessão automaticamente, gerando ruído no log e
 * mantendo a sessão quebrada por mais tempo. Aqui detectamos via
 * `messageStubType === CIPHERTEXT` (= falha de descriptografia entregue ao
 * upper-layer) que o destino é o LID próprio e disparamos `deleteSession`
 * imediatamente, forçando renegociação na próxima mensagem.
 *
 * Throttle por JID (60s) evita loops caso a renegociação demore.
 */
const selfSessionCleanupCooldownMs = 60_000;
const selfSessionCleanupRecent = new Map();
async function handleCorruptedSelfSessions(name, ctx, list) {
    if (!list || list.length === 0)
        return;
    // CIPHERTEXT stub = 2. Hardcoded para evitar dynamic import por chamada
    // (proto.WebMessageInfo.StubType.CIPHERTEXT === 2 em todas as versões do Baileys).
    const CIPHERTEXT_STUB = 2;
    const sock = ctx.sock;
    // Use memoized values from ctx when available (populated at connection.open).
    // Fallback to reading from creds/user on first call.
    let ownPnUser = ctx.ownPnUser ?? '';
    let ownLidUser = ctx.ownLidUser ?? '';
    if (!ownPnUser && !ownLidUser) {
        // me.id pode ser "551197...@s.whatsapp.net" ou "551197...:46@s.whatsapp.net".
        const rawPn = String(sock.authState?.creds?.me?.id ?? sock.user?.id ?? '');
        const rawLid = String(sock.authState?.creds?.me?.lid ?? sock.user?.lid ?? '');
        ownPnUser = rawPn ? rawPn.split('@')[0].split(':')[0] : '';
        ownLidUser = rawLid ? rawLid.split('@')[0].split(':')[0] : '';
        // Memoize for subsequent calls on this instance.
        if (ownPnUser)
            ctx.ownPnUser = ownPnUser;
        if (ownLidUser)
            ctx.ownLidUser = ownLidUser;
    }
    const rawPn = String(sock.authState?.creds?.me?.id ?? sock.user?.id ?? '');
    const rawLid = String(sock.authState?.creds?.me?.lid ?? sock.user?.lid ?? '');
    const pnDomain = rawPn.includes('@') ? '@' + rawPn.split('@')[1] : '@s.whatsapp.net';
    const lidDomain = rawLid.includes('@') ? '@' + rawLid.split('@')[1] : '@lid';
    const ownPn = ownPnUser ? `${ownPnUser}${pnDomain}` : '';
    const ownLid = ownLidUser ? `${ownLidUser}${lidDomain}` : '';
    if (!ownPn && !ownLid)
        return;
    const toCleanup = new Set();
    for (const msg of list) {
        const stub = msg.messageStubType;
        if (stub !== CIPHERTEXT_STUB)
            continue;
        const key = msg.key ?? {};
        const remoteJid = String(key.remoteJid ?? '');
        const participant = String(key.participant ?? '');
        const candidate = participant || remoteJid;
        if (!candidate)
            continue;
        const candidateUser = candidate.split('@')[0].split(':')[0];
        // Apenas para sessão própria (note-to-self): o JID é o usuário próprio
        // (em PN ou LID).
        const isSelf = (ownPnUser && candidateUser === ownPnUser) ||
            (ownLidUser && candidateUser === ownLidUser);
        if (!isSelf)
            continue;
        const now = Date.now();
        const last = selfSessionCleanupRecent.get(candidate) ?? 0;
        if (now - last < selfSessionCleanupCooldownMs)
            continue;
        selfSessionCleanupRecent.set(candidate, now);
        // Inclui AMBOS o JID detectado (PN ou LID) e seu par para garantir que
        // os dois arquivos de sessão em disco sejam removidos. O deleteSession do
        // Baileys usa jidToSignalProtocolAddress que gera a chave de arquivo por
        // JID individualmente:
        //   - PN "551197...@s.whatsapp.net" → addr "551197...0" → file session-551197...0.json
        //   - LID "100158...:0@lid" → signalUser="100158..._1", addr="100158..._1.0" → file session-100158..._1.0.json
        // Se só passarmos o PN, o arquivo do LID permanece corrompido (e vice-versa).
        // Sempre passamos ambos com device=0 (que é o device das sessões note-to-self).
        toCleanup.add(candidate);
        // Adiciona o JID par: se o candidato é PN, adiciona o LID com device 0 e vice-versa
        if (ownPnUser && candidateUser === ownPnUser && ownLidUser) {
            // LID com device 0 (format: user:0@lid)
            toCleanup.add(`${ownLidUser}:0@lid`);
        }
        else if (ownLidUser && candidateUser === ownLidUser && ownPnUser) {
            // PN com device 0 (format: user:0@s.whatsapp.net)
            toCleanup.add(`${ownPnUser}:0@s.whatsapp.net`);
        }
    }
    if (toCleanup.size === 0)
        return;
    const deleteSession = sock.signalRepository?.deleteSession;
    if (typeof deleteSession !== 'function')
        return;
    const jids = Array.from(toCleanup);
    try {
        await deleteSession.call(sock.signalRepository, jids);
        log.whatsapp
            .child(name)
            .info('self_session_corrupted_cleaned', { jids, count: jids.length });
        // Métrica: incrementa contador de cleanups por instância.
        recordOpencodePeerSelfFix(name);
    }
    catch (err) {
        log.whatsapp.child(name).warn('self_session_cleanup_failed', { jids, err });
    }
    // Invalida o peerSessionsCache interno do Baileys para os JIDs deletados.
    // Sem isso, o cache ainda diz "true" e o próximo sendMessage pula o fetch
    // de pre-keys (assertSessions force=false), falhando a encriptação
    // silenciosamente. O invalidatePeerSessionCache é exposto via patch 4.
    if (typeof sock.invalidatePeerSessionCache === 'function') {
        try {
            sock.invalidatePeerSessionCache(jids);
            log.whatsapp.child(name).debug('peer_session_cache_invalidated', { jids });
        }
        catch (err) {
            log.whatsapp.child(name).warn('peer_session_cache_invalidate_failed', { jids, err });
        }
    }
    // Limita o tamanho do mapa de cooldown para evitar leak.
    if (selfSessionCleanupRecent.size > 200) {
        const cutoff = Date.now() - selfSessionCleanupCooldownMs * 5;
        for (const [jid, ts] of selfSessionCleanupRecent) {
            if (ts < cutoff)
                selfSessionCleanupRecent.delete(jid);
        }
    }
}
loadMediaIndex();
purgeExpiredMediaBinaries();
scheduleExistingMediaAdoption();
// Periodically purge expired media files from disk so instances used purely as
// relay (no chat-viewer access) don't accumulate files indefinitely.
setInterval(() => purgeExpiredMediaBinaries(), 60 * 60 * 1000).unref();
/**
 * Generations counter: stop() bumps the gen; in-flight setTimeout callbacks
 * compare against the gen captured when they were scheduled and abort if it
 * changed. Avoids the race where stopAlwaysOnline races with a pending
 * setTimeout firing after disconnect.
 */
const alwaysOnlineGen = new Map();
function stopAlwaysOnline(name) {
    const timer = alwaysOnlineIntervals.get(name);
    if (timer) {
        // Used to be setInterval; with humanize it's a chain of setTimeouts.
        // clearTimeout works on both handle types (Node returns Timeout for both).
        clearTimeout(timer);
        alwaysOnlineIntervals.delete(name);
    }
    alwaysOnlineGen.set(name, (alwaysOnlineGen.get(name) ?? 0) + 1);
}
function startAlwaysOnline(name, ctx) {
    stopAlwaysOnline(name);
    const settings = getInstanceGeneral(name);
    if (!settings.alwaysOnline)
        return;
    if (typeof ctx.sock.sendPresenceUpdate !== 'function')
        return;
    // PRIO-5 (humanize): substitui o setInterval fixo de 30s por uma cadeia de
    // setTimeout self-rescheduling com jitter ±25% (default base 75s ⇒
    // ~56..94s). Elimina o pattern detectável de "available no segundo exato
    // a cada 30s". Também atrasa o primeiro ping em 200–2000ms para
    // descorrelacionar reconexões simultâneas de múltiplas instâncias.
    const humanize = getHumanizeSettings(name);
    const baseMs = humanize.enabled ? humanize.alwaysOnlineBaseMs : 30_000;
    const jitterPct = humanize.enabled ? humanize.alwaysOnlineJitterPct : 0;
    const initialDelay = humanize.enabled ? humanRandomIntBetween(200, 2000) : 0;
    const gen = (alwaysOnlineGen.get(name) ?? 0);
    const scheduleNext = (delayMs) => {
        const handle = setTimeout(() => {
            // Abort if a newer start/stop has run since we were scheduled.
            if (alwaysOnlineGen.get(name) !== gen)
                return;
            if (instances.get(name) !== ctx || ctx.status !== 'connected')
                return;
            ctx.sock.sendPresenceUpdate?.('available').catch(() => { });
            scheduleNext(humanJitter(baseMs, jitterPct));
        }, delayMs);
        handle.unref?.();
        alwaysOnlineIntervals.set(name, handle);
    };
    scheduleNext(initialDelay);
}
function pruneGroupChatsFromCache(name) {
    const settings = getInstanceGeneral(name);
    if (!settings.ignoreGroups)
        return;
    const chats = chatCache.get(name);
    if (!chats)
        return;
    for (const jid of chats.keys()) {
        if (jid.endsWith('@g.us')) {
            chats.delete(jid);
        }
    }
}
/** Generation guard for the humanize-driven setTimeout chain (mesma técnica
 *  do alwaysOnline). Sem isso, um setTimeout pendente pode disparar
 *  fetchMessageHistory após a desconexão. */
const syncHistoryGen = new Map();
function stopContinuousHistorySync(name) {
    const timer = syncHistoryIntervals.get(name);
    if (timer) {
        // Antes era setInterval; agora pode ser setTimeout (modo humanize). clearTimeout
        // funciona com qualquer Timeout do Node.
        clearTimeout(timer);
        syncHistoryIntervals.delete(name);
    }
    syncHistoryGen.set(name, (syncHistoryGen.get(name) ?? 0) + 1);
    syncHistoryCursor.delete(name);
    syncHistoryInFlight.delete(name);
}
function extractMessagesFromHistoryResponse(raw) {
    if (Array.isArray(raw)) {
        return raw.filter((item) => typeof item === 'object' && item !== null);
    }
    const obj = (raw ?? {});
    if (Array.isArray(obj.messages)) {
        return obj.messages.filter((item) => typeof item === 'object' && item !== null);
    }
    if (Array.isArray(obj.msgs)) {
        return obj.msgs.filter((item) => typeof item === 'object' && item !== null);
    }
    if (Array.isArray(obj.historyMessages)) {
        return obj.historyMessages.filter((item) => typeof item === 'object' && item !== null);
    }
    return [];
}
async function runContinuousHistorySync(name, ctx) {
    if (syncHistoryInFlight.has(name))
        return;
    syncHistoryInFlight.add(name);
    try {
        if (instances.get(name) !== ctx || ctx.status !== 'connected')
            return;
        const settings = getInstanceGeneral(name);
        if (!settings.syncFullHistory)
            return;
        const anySock = ctx.sock;
        const hasFetchHistory = typeof anySock.fetchMessageHistory === 'function';
        const hasResyncState = typeof anySock.resyncAppState === 'function';
        if (!hasFetchHistory && !hasResyncState)
            return;
        const list = getInstanceChatList(name).filter((chat) => !(settings.ignoreGroups && chat.jid.endsWith('@g.us')));
        if (list.length === 0) {
            if (hasResyncState) {
                try {
                    await anySock.resyncAppState(['critical_block', 'regular']);
                }
                catch {
                    // best effort
                }
            }
            return;
        }
        // PRIO-1 (humanize): reduzimos chats por tick (default 2) e adicionamos
        // sleep aleatório entre cada fetchMessageHistory para que o burst não saia
        // como uma rajada simultânea de 6 stanzas.
        const humanize = getHumanizeSettings(name);
        const batchSize = humanize.enabled ? humanize.historyBatchChats : CONTINUOUS_HISTORY_BATCH_CHATS;
        const start = syncHistoryCursor.get(name) ?? 0;
        const limit = Math.min(Math.max(1, batchSize), list.length);
        const selected = [];
        for (let i = 0; i < limit; i++) {
            const idx = (start + i) % list.length;
            selected.push(list[idx]);
        }
        syncHistoryCursor.set(name, (start + limit) % list.length);
        let isFirst = true;
        for (const chat of selected) {
            if (instances.get(name) !== ctx || ctx.status !== 'connected')
                break;
            if (!hasFetchHistory)
                break;
            if (!isFirst && humanize.enabled) {
                await humanSleep(humanRandomIntBetween(humanize.historyFetchSleepMinMs, humanize.historyFetchSleepMaxMs));
                // Re-check após o sleep — pode ter desconectado nesse meio-tempo.
                if (instances.get(name) !== ctx || ctx.status !== 'connected')
                    break;
            }
            isFirst = false;
            const existing = getInstanceChatMessages(name, chat.jid);
            const oldest = existing.length > 0 ? existing[0] : undefined;
            const oldestTimestamp = oldest ? normalizeTimestamp(oldest.timestamp) : undefined;
            const oldestKey = oldest
                ? {
                    remoteJid: chat.jid,
                    id: oldest.id,
                    fromMe: oldest.fromMe,
                }
                : undefined;
            try {
                const response = await anySock.fetchMessageHistory(CONTINUOUS_HISTORY_FETCH_COUNT, oldestKey, oldestTimestamp);
                const messages = extractMessagesFromHistoryResponse(response);
                if (messages.length > 0) {
                    // Chunked async para não bloquear o event loop em batches grandes.
                    await ingestHistoryMessagesChunked(name, messages);
                }
            }
            catch {
                // best effort continuous sync
            }
        }
    }
    finally {
        syncHistoryInFlight.delete(name);
    }
}
function startContinuousHistorySync(name, ctx) {
    stopContinuousHistorySync(name);
    const settings = getInstanceGeneral(name);
    if (!settings.syncFullHistory)
        return;
    // PRIO-1 (humanize): intervalo base ~10min com jitter ±30%. Eliminamos o
    // tick fixo de 7s (que era flagrante padrão de bot). Implementado como
    // cadeia de setTimeout self-rescheduling para que cada próximo agendamento
    // pegue um valor jittered novo.
    const humanize = getHumanizeSettings(name);
    const baseMs = humanize.enabled ? humanize.historySyncBaseMs : CONTINUOUS_HISTORY_SYNC_MS;
    const jitterPct = humanize.enabled ? humanize.historySyncJitterPct : 0;
    // Primeira execução: pequeno delay aleatório (3–15s no modo humanize) para
    // descorrelacionar de "connection === 'open'" — assim o catch-up não sai
    // junto com o messaging-history.set inicial.
    const firstDelay = humanize.enabled ? humanRandomIntBetween(3000, 15_000) : 0;
    const gen = (syncHistoryGen.get(name) ?? 0);
    const scheduleNext = (delayMs) => {
        const handle = setTimeout(async () => {
            if (syncHistoryGen.get(name) !== gen)
                return;
            if (instances.get(name) !== ctx || ctx.status !== 'connected')
                return;
            try {
                await runContinuousHistorySync(name, ctx);
            }
            catch {
                // best-effort
            }
            if (syncHistoryGen.get(name) !== gen)
                return;
            scheduleNext(humanJitter(baseMs, jitterPct));
        }, delayMs);
        handle.unref?.();
        syncHistoryIntervals.set(name, handle);
    };
    scheduleNext(firstDelay);
}
async function resolveProxyAgent(instance) {
    const proxy = getInstancePanelConfig(instance).proxy;
    if (!proxy.enabled) {
        return { agent: null };
    }
    const host = String(proxy.host || '').trim();
    const port = Number(proxy.port || 0);
    if (!host || !Number.isFinite(port) || port <= 0) {
        return { agent: null, error: 'proxy_invalid_host_or_port' };
    }
    const protocol = proxy.protocol === 'https' ? 'https' : 'http';
    const username = String(proxy.username || '').trim();
    const password = String(proxy.password || '').trim();
    const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
    const proxyUrl = `${protocol}://${auth}${host}:${port}`;
    try {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        return { agent: new HttpsProxyAgent(proxyUrl) };
    }
    catch {
        return { agent: null, error: 'proxy_agent_unavailable' };
    }
}
export function applyInstanceRuntimeSettings(name) {
    const ctx = instances.get(name);
    if (!ctx) {
        return {
            ok: false,
            applied: [],
            requiresReconnect: [],
        };
    }
    stopAlwaysOnline(name);
    startAlwaysOnline(name, ctx);
    stopContinuousHistorySync(name);
    startContinuousHistorySync(name, ctx);
    pruneGroupChatsFromCache(name);
    return {
        ok: true,
        applied: ['alwaysOnline', 'rejectCalls', 'ignoreGroups', 'autoReadMessages', 'readStatus', 'syncFullHistory'],
        requiresReconnect: ['proxy'],
    };
}
function extractMessageText(message) {
    const msg = (message ?? {});
    if (typeof msg.conversation === 'string')
        return msg.conversation;
    const extended = msg.extendedTextMessage;
    if (extended?.text)
        return extended.text;
    const image = msg.imageMessage;
    if (image?.caption)
        return image.caption;
    const video = msg.videoMessage;
    if (video?.caption)
        return video.caption;
    if (msg.stickerMessage)
        return '[sticker]';
    if (msg.audioMessage)
        return '[audio]';
    if (msg.documentMessage)
        return '[document]';
    if (msg.contactMessage)
        return '[contact]';
    if (msg.locationMessage)
        return '[location]';
    if (isRecord(message)) {
        for (const value of Object.values(message)) {
            if (!isRecord(value))
                continue;
            const nestedMessage = isRecord(value.message) ? value.message : value;
            if (nestedMessage === message)
                continue;
            const nestedText = extractMessageText(nestedMessage);
            if (nestedText !== '[message]')
                return nestedText;
        }
    }
    return '[message]';
}
function detectRawMessageType(message, depth = 0) {
    if (!isRecord(message) || depth > 6)
        return 'unknown';
    if (isRecord(message.conversation) || typeof message.conversation === 'string')
        return 'text';
    if (isRecord(message.extendedTextMessage))
        return 'text';
    if (isRecord(message.audioMessage))
        return 'audio';
    if (isRecord(message.imageMessage))
        return 'image';
    if (isRecord(message.videoMessage))
        return 'video';
    if (isRecord(message.stickerMessage))
        return 'sticker';
    if (isRecord(message.documentMessage))
        return 'document';
    if (isRecord(message.locationMessage))
        return 'location';
    if (isRecord(message.contactMessage) || isRecord(message.contactsArrayMessage))
        return 'contact';
    if (isRecord(message.reactionMessage))
        return 'reaction';
    for (const wrapperKey of MESSAGE_WRAPPER_KEYS) {
        const wrapper = message[wrapperKey];
        if (!isRecord(wrapper) || !isRecord(wrapper.message))
            continue;
        const nested = detectRawMessageType(wrapper.message, depth + 1);
        if (nested !== 'unknown')
            return nested;
    }
    for (const value of Object.values(message)) {
        if (!isRecord(value))
            continue;
        const nestedTarget = isRecord(value.message) ? value.message : value;
        if (nestedTarget === message)
            continue;
        const nested = detectRawMessageType(nestedTarget, depth + 1);
        if (nested !== 'unknown')
            return nested;
    }
    return 'unknown';
}
function shouldIncludeMediaBase64(kind) {
    if (!config.webhooks.includeIncomingMediaBase64)
        return false;
    if (kind === 'video')
        return config.webhooks.includeIncomingVideoBase64;
    return true;
}
function maxMediaBytes(kind, scope) {
    if (scope === 'webhook') {
        if (kind === 'video')
            return config.webhooks.incomingVideoBase64MaxBytes;
        return config.webhooks.incomingMediaBase64MaxBytes;
    }
    if (kind === 'video')
        return config.limits.chatVideoMaxBytes;
    return config.limits.chatInlineMediaMaxBytes;
}
function purgeExpiredMediaBinaries(now = Date.now()) {
    const ttl = config.limits.chatMediaRetentionMs;
    const toDelete = [];
    for (const [mediaId, item] of chatMediaBinaryStore.entries()) {
        if (item.expiresAt <= now || now - item.createdAt > ttl) {
            toDelete.push(mediaId);
        }
    }
    if (!toDelete.length)
        return;
    for (const mediaId of toDelete) {
        const item = chatMediaBinaryStore.get(mediaId);
        if (!item)
            continue;
        const absolutePath = path.join(mediaStoragePath, item.relativePath);
        // Use async deletion to avoid blocking the event loop; fire-and-forget.
        fs.promises.rm(absolutePath, { force: true }).catch(() => { });
        if (item.storageKey)
            chatMediaStorageKeyIndex.delete(item.storageKey);
        chatMediaBinaryStore.delete(mediaId);
    }
    persistMediaIndex();
}
function clearInstanceMediaBinaries(instance, force = false) {
    if (!force)
        return;
    let changed = false;
    for (const [mediaId, item] of chatMediaBinaryStore.entries()) {
        if (item.instance === instance) {
            const absolutePath = path.join(mediaStoragePath, item.relativePath);
            try {
                if (fs.existsSync(absolutePath))
                    fs.rmSync(absolutePath, { force: true });
            }
            catch {
                // ignore deletion failures
            }
            if (item.storageKey)
                chatMediaStorageKeyIndex.delete(item.storageKey);
            chatMediaBinaryStore.delete(mediaId);
            changed = true;
        }
    }
    if (changed)
        persistMediaIndex();
}
function isSafeInlineMime(kind, mimeType) {
    const value = String(mimeType ?? '').trim().toLowerCase();
    if (!value)
        return kind !== 'video';
    if (kind === 'image')
        return value.startsWith('image/') && value !== 'image/svg+xml';
    if (kind === 'audio')
        return value.startsWith('audio/');
    if (kind === 'sticker')
        return value === 'image/webp' || value === 'image/png';
    if (kind === 'video')
        return value.startsWith('video/');
    return false;
}
function storeMediaBinary(instance, media) {
    if (!media.base64)
        return media;
    const mimeType = media.mimeType || (media.kind === 'video' ? 'video/mp4' : 'application/octet-stream');
    if (!isSafeInlineMime(media.kind, mimeType) && media.kind !== 'document') {
        return {
            ...media,
            base64: undefined,
            omittedReason: 'download_failed',
        };
    }
    let bytes;
    try {
        bytes = Buffer.from(media.base64, 'base64');
    }
    catch {
        return {
            ...media,
            base64: undefined,
            omittedReason: 'download_failed',
        };
    }
    if (!bytes.length || bytes.length > maxMediaBytes(media.kind, 'chat')) {
        return {
            ...media,
            base64: undefined,
            omittedReason: 'too_large',
        };
    }
    const createdAt = Date.now();
    const expiresAt = createdAt + config.limits.chatMediaRetentionMs;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storageKey = `${instance}:sha256:${sha256}`;
    const existingMediaId = chatMediaStorageKeyIndex.get(storageKey);
    const existing = existingMediaId ? chatMediaBinaryStore.get(existingMediaId) : undefined;
    if (existing) {
        const existingPath = path.join(mediaStoragePath, existing.relativePath);
        if (fs.existsSync(existingPath)) {
            existing.expiresAt = Math.max(existing.expiresAt, expiresAt);
            existing.createdAt = Math.min(existing.createdAt, createdAt);
            existing.sizeBytes = existing.sizeBytes || bytes.length;
            existing.storageKey = storageKey;
            chatMediaBinaryStore.set(existing.mediaId, existing);
            persistMediaIndex();
            return {
                ...media,
                mediaId: existing.mediaId,
                storageKey,
                base64: undefined,
                bytes: existing.sizeBytes || bytes.length,
            };
        }
        chatMediaBinaryStore.delete(existing.mediaId);
        chatMediaStorageKeyIndex.delete(storageKey);
    }
    const mediaId = randomUUID();
    const ext = mediaFileExtension(media.kind, mimeType);
    const year = new Date(createdAt).getUTCFullYear();
    const month = String(new Date(createdAt).getUTCMonth() + 1).padStart(2, '0');
    const day = String(new Date(createdAt).getUTCDate()).padStart(2, '0');
    const relativePath = path.join(instance, String(year), month, day, `${mediaId}.${ext}`);
    const absolutePath = path.join(mediaStoragePath, relativePath);
    try {
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, bytes);
    }
    catch {
        return {
            ...media,
            base64: undefined,
            omittedReason: 'download_failed',
        };
    }
    chatMediaBinaryStore.set(mediaId, {
        instance,
        mediaId,
        kind: media.kind,
        mimeType,
        relativePath,
        sizeBytes: bytes.length,
        createdAt,
        expiresAt,
        storageKey,
    });
    chatMediaStorageKeyIndex.set(storageKey, mediaId);
    persistMediaIndex();
    return {
        ...media,
        mediaId,
        storageKey,
        base64: undefined,
        bytes: bytes.length,
    };
}
async function adoptExistingMediaBinaries() {
    if (process.env.CHAT_MEDIA_ADOPT_EXISTING === 'false')
        return;
    if (!fs.existsSync(mediaStoragePath))
        return;
    const deleteDuplicates = process.env.CHAT_MEDIA_DELETE_DUPLICATES !== 'false';
    let scanned = 0;
    let adopted = 0;
    let duplicatesDeleted = 0;
    let bytesDeleted = 0;
    let errors = 0;
    const walk = async (dir) => {
        let entries;
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        }
        catch {
            errors += 1;
            return;
        }
        for (const entry of entries) {
            const absolutePath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(absolutePath);
                continue;
            }
            if (!entry.isFile())
                continue;
            const relativePath = path.relative(mediaStoragePath, absolutePath);
            const parts = relativePath.split(path.sep);
            const instance = parts[0];
            if (!instance || parts.length < 2)
                continue;
            const extMeta = mediaKindFromExtension(path.extname(entry.name));
            if (!extMeta)
                continue;
            const alreadyIndexed = [...chatMediaBinaryStore.values()].some((item) => item.relativePath === relativePath);
            if (alreadyIndexed)
                continue;
            try {
                const stat = await fs.promises.stat(absolutePath);
                if (!stat.isFile() || stat.size <= 0)
                    continue;
                scanned += 1;
                const sha256 = await sha256File(absolutePath);
                const storageKey = `${instance}:sha256:${sha256}`;
                const existingMediaId = chatMediaStorageKeyIndex.get(storageKey);
                const existing = existingMediaId ? chatMediaBinaryStore.get(existingMediaId) : undefined;
                if (existing) {
                    const existingPath = path.join(mediaStoragePath, existing.relativePath);
                    if (deleteDuplicates && fs.existsSync(existingPath)) {
                        await fs.promises.rm(absolutePath, { force: true });
                        duplicatesDeleted += 1;
                        bytesDeleted += stat.size;
                    }
                    continue;
                }
                const mediaId = path.parse(entry.name).name || randomUUID();
                const createdAt = Math.floor(stat.mtimeMs || Date.now());
                const expiresAt = createdAt + config.limits.chatMediaRetentionMs;
                const record = {
                    instance,
                    mediaId,
                    kind: extMeta.kind,
                    mimeType: extMeta.mimeType,
                    relativePath,
                    sizeBytes: stat.size,
                    createdAt,
                    expiresAt,
                    storageKey,
                };
                chatMediaBinaryStore.set(mediaId, record);
                chatMediaStorageKeyIndex.set(storageKey, mediaId);
                adopted += 1;
                if (adopted % 500 === 0 || duplicatesDeleted % 500 === 0)
                    persistMediaIndex();
            }
            catch {
                errors += 1;
            }
            if ((scanned + adopted + duplicatesDeleted) % 100 === 0) {
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
    };
    log.whatsapp.info('media_adoption_started');
    await walk(mediaStoragePath);
    persistMediaIndex();
    log.whatsapp.info('media_adoption_finished', {
        scanned,
        adopted,
        duplicatesDeleted,
        bytesDeleted,
        bytesDeletedGiB: Number((bytesDeleted / 1024 / 1024 / 1024).toFixed(2)),
        errors,
    });
}
function scheduleExistingMediaAdoption() {
    const delayMs = Number.parseInt(process.env.CHAT_MEDIA_ADOPT_DELAY_MS ?? '30000', 10);
    const handle = setTimeout(() => {
        adoptExistingMediaBinaries().catch((err) => {
            log.whatsapp.warn('media_adoption_failed', err);
        });
    }, Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 30000);
    handle.unref?.();
}
function findMediaNode(message, depth = 0) {
    if (!isRecord(message) || depth > 6)
        return null;
    for (const [kind, configByKind] of Object.entries(MEDIA_NODE_BY_KIND)) {
        const candidate = message[configByKind.field];
        if (isRecord(candidate)) {
            return { kind, node: candidate };
        }
    }
    for (const wrapperKey of MESSAGE_WRAPPER_KEYS) {
        const wrapper = message[wrapperKey];
        if (!isRecord(wrapper) || !isRecord(wrapper.message))
            continue;
        const nested = findMediaNode(wrapper.message, depth + 1);
        if (nested)
            return nested;
    }
    for (const value of Object.values(message)) {
        if (!isRecord(value))
            continue;
        const nestedTarget = isRecord(value.message) ? value.message : value;
        if (nestedTarget === message)
            continue;
        const nested = findMediaNode(nestedTarget, depth + 1);
        if (nested)
            return nested;
    }
    return null;
}
/**
 * Serializa os campos essenciais do node de mídia do Baileys para JSON persistível.
 * Converte Buffers para base64 e mantém apenas os campos necessários para re-download futuro.
 */
function serializeMediaSourceNode(node) {
    const DOWNLOAD_FIELDS = ['url', 'directPath', 'mediaKey', 'fileEncSha256', 'fileSha256', 'fileLength', 'mediaKeyTimestamp'];
    const out = {};
    for (const field of DOWNLOAD_FIELDS) {
        const val = node[field];
        if (val === undefined || val === null)
            continue;
        // Buffer / Uint8Array / TypedArray genérico: serializa como base64.
        // Após o fix de stripMessageNoise, mediaKey/fileEncSha256/fileSha256 chegam
        // aqui como Uint8Array (não Buffer), então é crítico tratar ambos.
        if (Buffer.isBuffer(val)) {
            out[field] = val.toString('base64');
            out[`${field}__enc`] = 'base64';
        }
        else if (val instanceof Uint8Array) {
            out[field] = Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('base64');
            out[`${field}__enc`] = 'base64';
        }
        else if (ArrayBuffer.isView(val)) {
            const view = val;
            out[field] = Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
            out[`${field}__enc`] = 'base64';
        }
        else if (typeof val === 'bigint') {
            out[field] = val.toString();
            out[`${field}__enc`] = 'bigint';
        }
        else if (isLongLike(val)) {
            // protobufjs Long: { low, high, unsigned }. Persiste como string decimal
            // para evitar perda de precisão e marca como 'long' para reidratar.
            out[field] = longLikeToString(val);
            out[`${field}__enc`] = 'long';
        }
        else {
            out[field] = val;
        }
    }
    return out;
}
/**
 * Verifica se o valor é um Long do protobufjs (formato `{ low, high, unsigned }`).
 * Long é usado pelo Baileys/protobufjs para campos numéricos de 64 bits como
 * `fileLength` (tamanho do arquivo) e `mediaKeyTimestamp`.
 */
function isLongLike(val) {
    if (!val || typeof val !== 'object')
        return false;
    const obj = val;
    return typeof obj.low === 'number' && typeof obj.high === 'number';
}
/**
 * Converte um Long-like para string decimal sem perda de precisão.
 * Equivalente a Long.prototype.toString() do protobufjs.
 */
function longLikeToString(obj) {
    const low = obj.low;
    const high = obj.high;
    const unsigned = Boolean(obj.unsigned);
    // BigInt path: combina os dois u32 em um i64/u64.
    const lowU = BigInt(low >>> 0); // converte para u32
    const highU = BigInt(high >>> 0);
    let combined = (highU << 32n) | lowU;
    if (!unsigned && high < 0) {
        // signed negativo: subtrai 2^64 para obter complemento
        combined -= 1n << 64n;
    }
    return combined.toString();
}
/**
 * Detecta se um valor é um Uint8Array serializado como plain object com chaves
 * numéricas (`{ "0": 100, "1": 161, ... }`). Acontecia antes do fix do
 * serialize, quando Uint8Array caía no else e ia para `JSON.stringify` direto.
 *
 * Esses registros antigos não conseguem mais ser baixados (mídia já expirou no
 * servidor WA), mas precisam ser reconhecidos para evitar passar lixo para o
 * Baileys e tentar retry inutilmente.
 */
function isLegacyUint8ArrayObject(val) {
    if (!val || typeof val !== 'object' || Array.isArray(val))
        return false;
    if (val instanceof Uint8Array || Buffer.isBuffer(val) || ArrayBuffer.isView(val))
        return false;
    const obj = val;
    const keys = Object.keys(obj);
    if (keys.length === 0)
        return false;
    // Todas as chaves devem ser índices numéricos contíguos a partir de 0
    // e os valores precisam ser inteiros 0-255.
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== String(i))
            return false;
        const v = obj[String(i)];
        if (typeof v !== 'number' || v < 0 || v > 255 || !Number.isInteger(v))
            return false;
    }
    return true;
}
function injectMediaBase64(message, kind, base64, depth = 0) {
    if (!isRecord(message) || depth > 6)
        return message;
    const mediaField = MEDIA_NODE_BY_KIND[kind].field;
    if (isRecord(message[mediaField])) {
        return {
            ...message,
            [mediaField]: {
                ...message[mediaField],
                base64,
            },
        };
    }
    for (const wrapperKey of MESSAGE_WRAPPER_KEYS) {
        const wrapper = message[wrapperKey];
        if (!isRecord(wrapper) || !isRecord(wrapper.message))
            continue;
        return {
            ...message,
            [wrapperKey]: {
                ...wrapper,
                message: injectMediaBase64(wrapper.message, kind, base64, depth + 1),
            },
        };
    }
    for (const [key, value] of Object.entries(message)) {
        if (!isRecord(value))
            continue;
        if (isRecord(value.message)) {
            const nextMessage = injectMediaBase64(value.message, kind, base64, depth + 1);
            if (nextMessage !== value.message) {
                return {
                    ...message,
                    [key]: {
                        ...value,
                        message: nextMessage,
                    },
                };
            }
            continue;
        }
        const nested = injectMediaBase64(value, kind, base64, depth + 1);
        if (nested !== value) {
            return {
                ...message,
                [key]: nested,
            };
        }
    }
    return message;
}
async function downloadMediaBase64(node, kind, scope = 'webhook') {
    if (scope === 'webhook' && !shouldIncludeMediaBase64(kind))
        return null;
    try {
        const module = (await getBaileysModule());
        if (typeof module.downloadContentFromMessage !== 'function')
            return { omittedReason: 'download_failed' };
        const DOWNLOAD_TIMEOUT_MS = 30_000;
        const downloadPromise = (async () => {
            const stream = await module.downloadContentFromMessage(node, MEDIA_NODE_BY_KIND[kind].downloadType);
            const chunks = [];
            let total = 0;
            const limit = maxMediaBytes(kind, scope);
            for await (const chunk of stream) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buffer.length;
                if (total > limit) {
                    return { omittedReason: 'too_large' };
                }
                chunks.push(buffer);
            }
            if (!chunks.length)
                return { omittedReason: 'download_failed' };
            return { base64: Buffer.concat(chunks).toString('base64'), bytes: total };
        })();
        const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ omittedReason: 'download_failed' }), DOWNLOAD_TIMEOUT_MS));
        return await Promise.race([downloadPromise, timeoutPromise]);
    }
    catch {
        return { omittedReason: 'download_failed' };
    }
}
function extractMediaMeta(message) {
    const found = findMediaNode(message);
    if (!found)
        return null;
    const mimeType = typeof found.node.mimetype === 'string' ? found.node.mimetype : undefined;
    const caption = typeof found.node.caption === 'string' ? found.node.caption : undefined;
    const fileName = typeof found.node.fileName === 'string' ? found.node.fileName : undefined;
    const base64 = typeof found.node.base64 === 'string' ? found.node.base64 : undefined;
    return {
        kind: found.kind,
        mimeType,
        caption,
        fileName,
        base64,
    };
}
function parsePhoneFromVcard(vcardRaw) {
    const match = vcardRaw.match(/TEL[^:]*:([^\r\n]+)/i);
    if (!match || !match[1])
        return undefined;
    return match[1].replace(/[^0-9+]/g, '').trim() || undefined;
}
function extractContactMeta(message) {
    if (!isRecord(message))
        return null;
    const contact = isRecord(message.contactMessage) ? message.contactMessage : null;
    if (contact) {
        const displayName = typeof contact.displayName === 'string' ? contact.displayName.trim() : undefined;
        const number = typeof contact.number === 'string'
            ? contact.number.trim()
            : typeof contact.vcard === 'string'
                ? parsePhoneFromVcard(contact.vcard)
                : undefined;
        if (!displayName && !number)
            return null;
        return {
            displayName: displayName || undefined,
            number: number || undefined,
        };
    }
    const contactsArray = isRecord(message.contactsArrayMessage) ? message.contactsArrayMessage : null;
    const contactsList = Array.isArray(contactsArray?.contacts) ? contactsArray.contacts : null;
    if (contactsList && contactsList.length > 0) {
        const first = isRecord(contactsList[0]) ? contactsList[0] : null;
        if (!first)
            return null;
        const displayName = typeof first.displayName === 'string' ? first.displayName.trim() : undefined;
        const number = typeof first.number === 'string'
            ? first.number.trim()
            : typeof first.vcard === 'string'
                ? parsePhoneFromVcard(first.vcard)
                : undefined;
        if (!displayName && !number)
            return null;
        return {
            displayName: displayName || undefined,
            number: number || undefined,
        };
    }
    return null;
}
function extractSender(rawMessage) {
    const key = isRecord(rawMessage.key) ? rawMessage.key : {};
    const participant = typeof key.participant === 'string' ? key.participant : '';
    const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : '';
    const senderJid = participant || remoteJid;
    const senderNumber = senderJid ? senderJid.split('@')[0] : undefined;
    const senderName = typeof rawMessage.pushName === 'string' ? rawMessage.pushName.trim() : undefined;
    return {
        senderName: senderName || undefined,
        senderNumber,
    };
}
function isSkippableSystemMessage(message) {
    if (!isRecord(message))
        return false;
    if (isRecord(message.protocolMessage) || isRecord(message.senderKeyDistributionMessage))
        return true;
    for (const wrapperKey of MESSAGE_WRAPPER_KEYS) {
        const wrapper = message[wrapperKey];
        if (!isRecord(wrapper) || !isRecord(wrapper.message))
            continue;
        if (isSkippableSystemMessage(wrapper.message))
            return true;
    }
    return false;
}
async function enrichIncomingMediaBase64(messages) {
    if (!config.webhooks.includeIncomingMediaBase64 || messages.length === 0)
        return messages;
    const enriched = [...messages];
    // Parallel download with concurrency cap to avoid hammering WA servers.
    const CONCURRENCY = 4;
    const tasks = messages.map((current, i) => async () => {
        const message = isRecord(current.message) ? current.message : null;
        if (!message)
            return;
        const found = findMediaNode(message);
        if (!found)
            return;
        const mediaData = await downloadMediaBase64(found.node, found.kind, 'webhook');
        if (!mediaData?.base64)
            return;
        enriched[i] = {
            ...current,
            message: injectMediaBase64(message, found.kind, mediaData.base64),
        };
    });
    // Run tasks with bounded concurrency using a simple semaphore pattern.
    const queue = [...tasks];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        let task;
        while ((task = queue.shift())) {
            try {
                await task();
            }
            catch { /* per-item errors are non-fatal */ }
        }
    });
    await Promise.all(workers);
    return enriched;
}
/**
 * Re-hidrata um node de mídia serializado (com Buffers em base64) de volta
 * para o formato que o Baileys espera em `downloadContentFromMessage`.
 */
function rehydrateMediaSourceNode(src) {
    const out = {};
    for (const [key, val] of Object.entries(src)) {
        if (key.endsWith('__enc'))
            continue; // marker de encoding, não é campo real
        const encKey = `${key}__enc`;
        const enc = src[encKey];
        // Caminho marcado: serializeMediaSourceNode escreveu um marker
        if (enc === 'base64' && typeof val === 'string') {
            out[key] = Buffer.from(val, 'base64');
            continue;
        }
        if (enc === 'bigint' && typeof val === 'string') {
            try {
                out[key] = BigInt(val);
            }
            catch {
                out[key] = val;
            }
            continue;
        }
        if (enc === 'long' && typeof val === 'string') {
            // Reidrata Long como BigInt — Baileys aceita BigInt em campos como
            // fileLength sem problemas e evita dependência direta de protobufjs.
            try {
                out[key] = BigInt(val);
            }
            catch {
                out[key] = val;
            }
            continue;
        }
        // Caminhos legados: registros gravados antes do fix do serialize.
        // Antes, Uint8Array virava `{ "0": N, "1": N, ... }` e Long virava
        // `{ low, high, unsigned }`. Tentamos reidratar para que o download
        // continue funcionando em registros antigos.
        if (isLegacyUint8ArrayObject(val)) {
            const keys = Object.keys(val).sort((a, b) => Number(a) - Number(b));
            const buf = Buffer.alloc(keys.length);
            for (let i = 0; i < keys.length; i++) {
                buf[i] = val[String(i)];
            }
            out[key] = buf;
            continue;
        }
        if (isLongLike(val)) {
            try {
                out[key] = BigInt(longLikeToString(val));
            }
            catch {
                out[key] = val;
            }
            continue;
        }
        out[key] = val;
    }
    return out;
}
function classifyChatwootMediaDownloadFailure(errorMessage) {
    const normalized = errorMessage.trim().toLowerCase();
    if (!normalized)
        return 'download_failed';
    if (normalized.includes('excede limite') || normalized.includes('too large'))
        return 'too_large';
    if (normalized.includes('bad decrypt') ||
        normalized.includes('decryption failed') ||
        normalized.includes('cannot derive from empty media key') ||
        normalized.includes('empty media key') ||
        normalized.includes('bad mac')) {
        return 'decryption_failed';
    }
    return 'download_failed';
}
/**
 * Garante que mensagens com mídia tenham `base64` inline para que o
 * Chatwoot bridge consiga criar attachments. Diferente de
 * `enrichIncomingMediaBase64` (que respeita a flag de webhooks externos),
 * esta função SEMPRE tenta baixar a mídia, com um limite de tamanho
 * dedicado ao Chatwoot (`config.chatwoot.mediaMaxBytes`).
 *
 * Se uma mensagem já tem `base64` (porque o webhook externo já enriqueceu,
 * ou o usuário abriu o chat e a mídia foi cacheada), reutiliza.
 *
 * Não modifica mensagens sem mídia. Retorna sempre o mesmo array de tamanho.
 */
/**
 * Resume um node de mídia para logging diagnóstico: marca presença e tamanho
 * de cada campo crítico de download, sem expor bytes secretos.
 */
function summarizeMediaNodeForLog(node) {
    const FIELDS = ['url', 'directPath', 'mediaKey', 'fileEncSha256', 'fileSha256', 'fileLength', 'mediaKeyTimestamp'];
    const out = {};
    for (const field of FIELDS) {
        const val = node[field];
        if (val === undefined || val === null) {
            out[field] = false;
            continue;
        }
        if (Buffer.isBuffer(val)) {
            out[field] = `buf(${val.length})`;
        }
        else if (val instanceof Uint8Array) {
            out[field] = `u8a(${val.length})`;
        }
        else if (typeof val === 'string') {
            // url/directPath são strings reveláveis; mediaKey base64-encoded é segredo,
            // então marcamos apenas o tamanho para chaves cripto.
            if (field === 'url' || field === 'directPath') {
                out[field] = val.length > 80 ? `${val.slice(0, 80)}…(${val.length})` : val;
            }
            else {
                out[field] = `str(${val.length})`;
            }
        }
        else if (typeof val === 'number' || typeof val === 'bigint') {
            out[field] = String(val);
        }
        else if (val && typeof val === 'object') {
            // Pode ser um plain object com chaves numéricas ('{ "0": 12, "1": 34, ... }')
            // que aconteceu se um Buffer foi serializado via JSON.stringify e deserializado.
            const obj = val;
            const ctorName = obj.constructor?.name ?? 'Object';
            const numericKeys = Object.keys(obj).filter((k) => /^\d+$/.test(k));
            if (numericKeys.length > 0) {
                out[field] = `bufLike(ctor=${ctorName}, numericKeys=${numericKeys.length})`;
            }
            else if ('type' in obj && obj.type === 'Buffer' && Array.isArray(obj.data)) {
                out[field] = `bufJSON(${(obj.data).length})`;
            }
            else {
                out[field] = `object(ctor=${ctorName}, keys=${Object.keys(obj).slice(0, 5).join(',')})`;
            }
        }
        else {
            out[field] = typeof val;
        }
    }
    out.mimetype = typeof node.mimetype === 'string' ? node.mimetype : false;
    return out;
}
/**
 * Processa uma única mensagem para enrichMediaForChatwoot.
 * Extraída para permitir paralelismo via Promise.all.
 */
async function enrichSingleMessageForChatwoot(current, limit, instanceName) {
    const message = isRecord(current.message) ? current.message : null;
    if (!message)
        return current;
    const currentMedia = isRecord(current.media) ? current.media : null;
    // Já tem base64 diretamente no campo media (mídia enviada por nós)?
    if (typeof currentMedia?.base64 === 'string' && currentMedia.base64.length > 0)
        return current;
    let found = findMediaNode(message);
    if (!found)
        return current;
    // Já tem base64 (enriquecido antes)?
    if (typeof found.node.base64 === 'string' && found.node.base64.length > 0)
        return current;
    // Se o node não tem as chaves de download (url/directPath/mediaKey), tentar
    // usar o _src persistido no media (salvo durante ingestão da mensagem).
    const persistedSrc = isRecord(currentMedia?._src) ? currentMedia._src : null;
    const hasDownloadKeys = typeof found.node.url === 'string' || typeof found.node.directPath === 'string';
    let usedPersistedSrc = false;
    if (!hasDownloadKeys && persistedSrc) {
        found = { kind: found.kind, node: { ...found.node, ...rehydrateMediaSourceNode(persistedSrc) } };
        usedPersistedSrc = true;
    }
    // Retry para download de mídia (máximo 3 tentativas)
    const maxRetries = 3;
    let lastDownloadError = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // downloadContentFromMessage não é re-exportado pelo index do baileys;
            // importar direto do módulo utilitário onde está definido.
            const mediaModule = (await getBaileysMediaModule());
            if (typeof mediaModule.downloadContentFromMessage !== 'function') {
                lastDownloadError = 'downloadContentFromMessage não disponível';
                break;
            }
            const stream = await mediaModule.downloadContentFromMessage(found.node, MEDIA_NODE_BY_KIND[found.kind].downloadType);
            const chunks = [];
            let total = 0;
            let oversize = false;
            for await (const chunk of stream) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buffer.length;
                if (total > limit) {
                    oversize = true;
                    break;
                }
                chunks.push(buffer);
            }
            if (oversize || chunks.length === 0) {
                lastDownloadError = oversize ? 'mídia excede limite máximo' : 'stream vazio';
                break; // Oversize/empty não vai melhorar com retry
            }
            const base64 = Buffer.concat(chunks).toString('base64');
            const enrichedMedia = isRecord(current.media) ? current.media : null;
            return {
                ...current,
                media: enrichedMedia
                    ? { ...enrichedMedia, base64 }
                    : {
                        kind: found.kind,
                        mimeType: typeof found.node.mimetype === 'string' ? found.node.mimetype : undefined,
                        base64,
                    },
                message: injectMediaBase64(message, found.kind, base64),
            };
        }
        catch (err) {
            lastDownloadError = err instanceof Error ? err.message : String(err);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 100 * attempt));
            }
        }
    }
    // Download falhou - marcar omittedReason.
    const classification = classifyChatwootMediaDownloadFailure(lastDownloadError);
    const key = isRecord(current.key) ? current.key : {};
    const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : undefined;
    const msgId = typeof key.id === 'string' ? key.id : undefined;
    const fromMe = key.fromMe === true;
    const participant = typeof key.participant === 'string' ? key.participant : undefined;
    const logger = instanceName ? log.whatsapp.child(instanceName) : log.whatsapp;
    logger.warn(`enrichMediaForChatwoot_failed kind=${found.kind} classification=${classification} jid=${remoteJid ?? '?'} id=${msgId ?? '?'} fromMe=${fromMe} usedPersistedSrc=${usedPersistedSrc} hasDownloadKeys=${hasDownloadKeys} attempts=${maxRetries}`, {
        error: lastDownloadError,
        participant,
        node: summarizeMediaNodeForLog(found.node),
        persistedSrcKeys: persistedSrc ? Object.keys(persistedSrc) : null,
    });
    const existingMedia = isRecord(current.media) ? current.media : null;
    if (existingMedia && !existingMedia.base64) {
        return {
            ...current,
            media: {
                ...existingMedia,
                omittedReason: classification,
            },
        };
    }
    return current;
}
export async function enrichMediaForChatwoot(messages, instanceName) {
    if (messages.length === 0)
        return messages;
    const limit = config.chatwoot.mediaMaxBytes;
    // Parallel download with bounded concurrency (4 simultaneous) to avoid
    // hammering WA CDN while still reducing total latency by N-fold on bursts.
    const CONCURRENCY = 4;
    const enriched = new Array(messages.length);
    const tasks = messages.map((msg, i) => async () => {
        enriched[i] = await enrichSingleMessageForChatwoot(msg, limit, instanceName);
    });
    const queue = [...tasks];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        let task;
        while ((task = queue.shift())) {
            await task();
        }
    });
    await Promise.all(workers);
    return enriched;
}
function stripMessageNoise(value, depth = 0) {
    // Preserve Buffer/TypedArray instances as-is — these carry binary payloads
    // (mediaKey, fileEncSha256, sha256 hashes, etc.) that MUST remain typed for
    // downstream crypto ops. Treating them as plain records via Object.entries
    // would copy numeric indices into a plain `{ '0': N, ... }` object,
    // corrupting the bytes and breaking AES decryption.
    if (Buffer.isBuffer(value))
        return value;
    if (value instanceof Uint8Array)
        return value;
    if (ArrayBuffer.isView(value))
        return value;
    if (value instanceof ArrayBuffer)
        return value;
    if (!isRecord(value) || depth > 8)
        return value;
    // Preserve protobufjs Long objects (`{ low, high, unsigned }`) — they have
    // prototype methods (toNumber/toString) that get lost if rebuilt as plain.
    // Detect by shape since `instanceof Long` is unreliable across module copies.
    const proto = Object.getPrototypeOf(value);
    if (proto &&
        proto.constructor &&
        typeof proto.constructor === 'function' &&
        proto.constructor.name === 'Long' &&
        'low' in value &&
        'high' in value &&
        'unsigned' in value) {
        return value;
    }
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        if (EXTERNAL_MESSAGE_STRIP_KEYS.has(key))
            continue;
        output[key] = stripMessageNoise(entry, depth + 1);
    }
    return output;
}
function findMessageContextInfoNode(message, depth = 0) {
    if (!isRecord(message) || depth > 6)
        return null;
    if (isRecord(message.contextInfo))
        return message.contextInfo;
    if (isRecord(message.messageContextInfo))
        return message.messageContextInfo;
    for (const wrapperKey of MESSAGE_WRAPPER_KEYS) {
        const wrapper = message[wrapperKey];
        if (!isRecord(wrapper) || !isRecord(wrapper.message))
            continue;
        const nested = findMessageContextInfoNode(wrapper.message, depth + 1);
        if (nested)
            return nested;
    }
    for (const value of Object.values(message)) {
        if (!isRecord(value))
            continue;
        const nestedTarget = isRecord(value.message) ? value.message : value;
        if (nestedTarget === message)
            continue;
        const nested = findMessageContextInfoNode(nestedTarget, depth + 1);
        if (nested)
            return nested;
    }
    return null;
}
function extractCompactCryptoContext(rawMessage) {
    const message = isRecord(rawMessage.message) ? rawMessage.message : null;
    if (!message)
        return null;
    const ctx = findMessageContextInfoNode(message);
    if (!ctx)
        return null;
    const metadata = isRecord(ctx.deviceListMetadata) ? ctx.deviceListMetadata : null;
    const senderKeyHash = metadata && typeof metadata.senderKeyHash === 'string' ? metadata.senderKeyHash : undefined;
    const recipientKeyHash = metadata && typeof metadata.recipientKeyHash === 'string' ? metadata.recipientKeyHash : undefined;
    const messageSecret = typeof ctx.messageSecret === 'string' ? ctx.messageSecret : undefined;
    if (!senderKeyHash && !recipientKeyHash && !messageSecret)
        return null;
    return {
        senderKeyHash,
        recipientKeyHash,
        messageSecret,
    };
}
function findReactionMessageNode(message, depth = 0) {
    if (!isRecord(message) || depth > 6)
        return null;
    if (isRecord(message.reactionMessage))
        return message.reactionMessage;
    for (const wrapperKey of MESSAGE_WRAPPER_KEYS) {
        const wrapper = message[wrapperKey];
        if (!isRecord(wrapper) || !isRecord(wrapper.message))
            continue;
        const nested = findReactionMessageNode(wrapper.message, depth + 1);
        if (nested)
            return nested;
    }
    for (const value of Object.values(message)) {
        if (!isRecord(value))
            continue;
        const nestedTarget = isRecord(value.message) ? value.message : value;
        if (nestedTarget === message)
            continue;
        const nested = findReactionMessageNode(nestedTarget, depth + 1);
        if (nested)
            return nested;
    }
    return null;
}
function extractReactionReference(rawMessage) {
    const rootMessage = isRecord(rawMessage.message) ? rawMessage.message : null;
    if (!rootMessage)
        return null;
    const reaction = findReactionMessageNode(rootMessage);
    if (!reaction)
        return null;
    const reactionKey = isRecord(reaction.key) ? reaction.key : null;
    const targetMessageId = typeof reactionKey?.id === 'string'
        ? reactionKey.id.trim()
        : typeof reaction.stanzaId === 'string'
            ? reaction.stanzaId.trim()
            : '';
    const targetRemoteJid = typeof reactionKey?.remoteJid === 'string'
        ? reactionKey.remoteJid.trim()
        : typeof reaction.remoteJid === 'string'
            ? reaction.remoteJid.trim()
            : '';
    const targetParticipant = typeof reactionKey?.participant === 'string'
        ? reactionKey.participant.trim()
        : typeof reaction.participant === 'string'
            ? reaction.participant.trim()
            : '';
    const emoji = typeof reaction.text === 'string' ? reaction.text : undefined;
    return {
        emoji,
        targetMessageId: targetMessageId || undefined,
        targetRemoteJid: targetRemoteJid || undefined,
        targetParticipant: targetParticipant || undefined,
    };
}
function extractQuotedMessageId(rawMessage) {
    const rootMessage = isRecord(rawMessage.message) ? rawMessage.message : null;
    if (!rootMessage)
        return undefined;
    const ctx = findMessageContextInfoNode(rootMessage);
    if (!ctx)
        return undefined;
    const stanzaId = typeof ctx.stanzaId === 'string' ? ctx.stanzaId.trim() : '';
    if (stanzaId)
        return stanzaId;
    const quotedKey = isRecord(ctx.quotedMessageKey) ? ctx.quotedMessageKey : null;
    const quotedId = typeof quotedKey?.id === 'string' ? quotedKey.id.trim() : '';
    return quotedId || undefined;
}
async function resolveReactionTarget(instance, rawMessage) {
    const ref = extractReactionReference(rawMessage);
    if (!ref || !ref.targetMessageId)
        return null;
    const currentKey = isRecord(rawMessage.key) ? rawMessage.key : null;
    const fallbackJid = typeof currentKey?.remoteJid === 'string' ? currentKey.remoteJid.trim() : '';
    const chatJid = ref.targetRemoteJid || fallbackJid;
    if (!chatJid) {
        return {
            id: ref.targetMessageId,
            emoji: ref.emoji,
            found: false,
        };
    }
    const chats = chatCache.get(instance);
    const chat = chats?.get(chatJid);
    // Use O(1) Map lookup when available; fallback to linear scan if not yet built.
    const target = chat
        ? (chat.messagesById?.get(ref.targetMessageId) ?? chat.messages.find((item) => item.id === ref.targetMessageId) ?? null)
        : null;
    if (!target) {
        return {
            id: ref.targetMessageId,
            chatJid,
            participant: ref.targetParticipant,
            emoji: ref.emoji,
            found: false,
        };
    }
    await ensureCachedMessageMedia(instance, target, chatJid);
    const targetType = target.media?.kind ?? (target.contact ? 'contact' : 'text');
    return {
        id: target.id,
        chatJid,
        participant: ref.targetParticipant,
        emoji: ref.emoji,
        found: true,
        type: targetType,
        text: target.text,
        sender: {
            name: target.senderName,
            number: target.senderNumber,
        },
        contact: target.contact
            ? {
                displayName: target.contact.displayName,
                number: target.contact.number,
            }
            : undefined,
        media: target.media
            ? {
                kind: target.media.kind,
                mimeType: target.media.mimeType,
                fileName: target.media.fileName,
                caption: target.media.caption,
                mediaId: target.media.mediaId,
                url: target.media.mediaId ? buildMediaUrl(instance, target.media.mediaId) : undefined,
                bytes: target.media.bytes,
            }
            : undefined,
    };
}
function getCachedMessageForRaw(instance, rawMessage) {
    const key = isRecord(rawMessage.key) ? rawMessage.key : null;
    const jid = key && typeof key.remoteJid === 'string' ? key.remoteJid.trim() : '';
    const id = key && typeof key.id === 'string' ? key.id.trim() : '';
    if (!jid || !id)
        return null;
    const chats = chatCache.get(instance);
    const chat = chats?.get(jid);
    if (!chat)
        return null;
    // Use O(1) Map lookup when available (built lazily in updateCachedMessage).
    if (chat.messagesById)
        return chat.messagesById.get(id) ?? null;
    return chat.messages.find((item) => item.id === id) ?? null;
}
async function normalizeSingleMessageForExternal(instance, raw) {
    const cleaned = stripMessageNoise(raw);
    const inferredType = detectRawMessageType(raw.message);
    cleaned.message_type = inferredType;
    cleaned.messageType = inferredType;
    const cryptoContext = extractCompactCryptoContext(raw);
    if (cryptoContext) {
        cleaned.crypto = cryptoContext;
    }
    const senderFallback = extractSender(raw);
    cleaned.sender = {
        name: senderFallback.senderName,
        number: senderFallback.senderNumber,
    };
    const quotedMessageId = extractQuotedMessageId(raw);
    if (quotedMessageId)
        cleaned.quotedMessageId = quotedMessageId;
    const rawKey = isRecord(raw.key) ? raw.key : null;
    const rawJid = typeof rawKey?.remoteJid === 'string' ? rawKey.remoteJid.trim() : undefined;
    const cached = getCachedMessageForRaw(instance, raw);
    if (cached) {
        await ensureCachedMessageMedia(instance, cached, rawJid);
        cleaned.text = cached.text;
        if (cached.quotedMessageId)
            cleaned.quotedMessageId = cached.quotedMessageId;
        const resolvedType = cached.media?.kind ?? inferredType;
        cleaned.message_type = resolvedType;
        cleaned.messageType = resolvedType;
        cleaned.sender = {
            name: cached.senderName,
            number: cached.senderNumber,
        };
        if (cached.media) {
            cleaned.media = {
                kind: cached.media.kind,
                mimeType: cached.media.mimeType,
                fileName: cached.media.fileName,
                caption: cached.media.caption,
                mediaId: cached.media.mediaId,
                url: cached.media.mediaId ? buildMediaUrl(instance, cached.media.mediaId) : undefined,
                base64: config.webhooks.includeIncomingMediaBase64 ? cached.media.base64 : undefined,
                bytes: cached.media.bytes,
                omittedReason: cached.media.omittedReason,
                // Passa _src para que enrichMediaForChatwoot possa re-hidratar as chaves
                // de download mesmo quando o node da mensagem não as contém (leitura do banco).
                _src: cached.media._src,
            };
        }
    }
    if (cleaned.message_type === 'reaction' || cleaned.messageType === 'reaction') {
        const reactionTarget = await resolveReactionTarget(instance, raw);
        if (reactionTarget) {
            cleaned.reaction_target = reactionTarget;
            cleaned.reactionTarget = reactionTarget;
        }
    }
    return cleaned;
}
async function normalizeUpsertMessagesForExternal(instance, messages) {
    // Process each message independently in parallel — each item involves async
    // media-ensure and reaction-target lookups that are independent across messages.
    return Promise.all(messages.map((raw) => normalizeSingleMessageForExternal(instance, raw)));
}
function ensureInstanceChatMap(instance) {
    let map = chatCache.get(instance);
    if (!map) {
        map = new Map();
        chatCache.set(instance, map);
    }
    return map;
}
function updateCachedMessage(instance, payload) {
    const chats = ensureInstanceChatMap(instance);
    const existing = chats.get(payload.jid);
    const title = existing?.title || payload.jid.split('@')[0];
    const chat = existing ?? {
        jid: payload.jid,
        title,
        unreadCount: 0,
        lastMessage: '',
        lastTimestamp: 0,
        messages: [],
    };
    // Inicializa o índice por ID na primeira utilização (lazy build O(N) uma vez).
    if (!chat.messagesById) {
        chat.messagesById = new Map(chat.messages.map((m) => [m.id, m]));
    }
    const existingMessage = chat.messagesById.get(payload.id);
    if (existingMessage) {
        if (payload.senderName)
            existingMessage.senderName = payload.senderName;
        if (payload.senderNumber)
            existingMessage.senderNumber = payload.senderNumber;
        if (payload.media) {
            existingMessage.media = {
                ...(existingMessage.media ?? {}),
                ...payload.media,
            };
        }
        if (payload.contact) {
            existingMessage.contact = {
                ...(existingMessage.contact ?? {}),
                ...payload.contact,
            };
        }
        if (payload.quotedMessageId)
            existingMessage.quotedMessageId = payload.quotedMessageId;
        if (payload.mediaSource) {
            existingMessage.mediaSource = payload.mediaSource;
        }
        chats.set(payload.jid, chat);
        try {
            msUpdateMessageFields(instance, payload.jid, payload.id, {
                senderName: payload.senderName,
                senderNumber: payload.senderNumber,
                participant: payload.participant,
                quotedMessageId: payload.quotedMessageId,
                media: payload.media,
                contact: payload.contact,
            });
        }
        catch {
            // Best-effort: cache already has the enriched message.
        }
        return false;
    }
    const shouldAdvanceLastMessage = payload.timestamp >= chat.lastTimestamp;
    if (shouldAdvanceLastMessage) {
        chat.lastMessage = payload.text;
        chat.lastTimestamp = payload.timestamp;
    }
    // Atualizar contato em `contacts` (fonte de verdade) com o pushName recebido
    // quando a flag general.importContacts está ativa. Também alimenta chat_meta.title
    // como cache/fallback quando o título atual ainda é vazio ou apenas o número.
    // Nunca usa o pushName de mensagens fromMe (que seria o nome da própria instância).
    if (payload.senderName &&
        !payload.fromMe && // pushName de fromMe é o nome da própria instância, não do contato
        !payload.participant && // não é grupo (participant seria o JID do membro)
        !payload.jid.endsWith('@g.us') &&
        !payload.jid.endsWith('@newsletter')) {
        if (getInstanceGeneral(instance).importContacts === true) {
            // Grava na tabela contacts (fonte de verdade canônica para nome).
            try {
                msUpsertContact(instance, {
                    jid: payload.jid,
                    notify: payload.senderName,
                });
            }
            catch { /* best-effort */ }
            // Mantém chat_meta.title como cache para listagens existentes — apenas
            // sobrescreve quando atual é vazio ou só dígitos (não sobrescreve nome real).
            const currentTitle = chat.title || '';
            const isPhoneOnlyTitle = /^\d+$/.test(currentTitle);
            if (isPhoneOnlyTitle || !currentTitle) {
                chat.title = payload.senderName;
                try {
                    msUpsertMeta(instance, payload.jid, { title: payload.senderName });
                }
                catch { /* best-effort */ }
            }
        }
    }
    const incrementUnread = payload.incrementUnread ?? !payload.fromMe;
    if (incrementUnread) {
        chat.unreadCount += 1;
    }
    const newMsg = {
        id: payload.id,
        fromMe: payload.fromMe,
        text: payload.text,
        timestamp: payload.timestamp,
        senderName: payload.senderName,
        senderNumber: payload.senderNumber,
        participant: payload.participant,
        quotedMessageId: payload.quotedMessageId,
        media: payload.media,
        contact: payload.contact,
        mediaSource: payload.mediaSource,
    };
    chat.messages.push(newMsg);
    chat.messagesById?.set(newMsg.id, newMsg);
    // Sliding window: mantém no máximo maxPerChat mensagens em memória para
    // evitar crescimento ilimitado do cache em grupos muito ativos.
    const maxInMem = config.messages.maxPerChat;
    if (chat.messages.length > maxInMem) {
        chat.messages = chat.messages.slice(-maxInMem);
        // Rebuild do índice após o slice para remover entradas expiradas.
        chat.messagesById = new Map(chat.messages.map((m) => [m.id, m]));
    }
    chats.set(payload.jid, chat);
    // ── Persistência SQLite ────────────────────────────────────────────────────
    try {
        msUpsert(instance, payload.jid, {
            id: payload.id,
            fromMe: payload.fromMe,
            text: payload.text,
            timestamp: payload.timestamp,
            senderName: payload.senderName,
            senderNumber: payload.senderNumber,
            participant: payload.participant,
            quotedMessageId: payload.quotedMessageId,
            media: payload.media
                ? {
                    ...payload.media,
                    // Persistir chaves de download para permitir re-download futuro.
                    // Buffers são serializados como base64 com marker __enc.
                    ...(payload.mediaSource?.node
                        ? { _src: serializeMediaSourceNode(payload.mediaSource.node) }
                        : {}),
                }
                : undefined,
            contact: payload.contact,
        });
        if (shouldAdvanceLastMessage) {
            msUpsertMeta(instance, payload.jid, {
                lastMessage: payload.text,
                lastTimestamp: payload.timestamp,
            });
        }
        if (incrementUnread) {
            msIncrementUnread(instance, payload.jid);
        }
    }
    catch {
        // Persistência é best-effort; nunca bloqueia o fluxo normal
    }
    // ──────────────────────────────────────────────────────────────────────────
    return true;
}
function upsertCachedChatMeta(instance, payload) {
    const chats = ensureInstanceChatMap(instance);
    const existing = chats.get(payload.jid);
    const fallbackTitle = payload.jid.split('@')[0] || payload.jid;
    const title = String(payload.title ?? '').trim() || existing?.title || fallbackTitle;
    const chat = existing ?? {
        jid: payload.jid,
        title,
        unreadCount: 0,
        lastMessage: '',
        lastTimestamp: Number(payload.timestamp ?? 0),
        messages: [],
    };
    chat.title = title;
    if (payload.timestamp && payload.timestamp > chat.lastTimestamp) {
        chat.lastTimestamp = payload.timestamp;
    }
    chats.set(payload.jid, chat);
    // ── Persistência SQLite ────────────────────────────────────────────────────
    try {
        msUpsertMeta(instance, payload.jid, {
            title,
            ...(payload.timestamp ? { lastTimestamp: payload.timestamp } : {}),
        });
    }
    catch {
        // best-effort
    }
    // ──────────────────────────────────────────────────────────────────────────
}
function formatDisconnectInfo(lastDisconnect) {
    const info = (lastDisconnect ?? {});
    const code = info.error?.output?.statusCode;
    const message = info.error?.message ?? info.error?.data;
    return { code, message };
}
function isPairingWindowActive(name) {
    const issuedAt = pairingIssuedAt.get(name);
    if (!issuedAt)
        return false;
    return Date.now() - issuedAt <= 120000;
}
function markAuthRecoveryWindow(name) {
    authRecoveryIssuedAt.set(name, Date.now());
}
function isAuthRecoveryWindowActive(name) {
    const issuedAt = authRecoveryIssuedAt.get(name);
    if (!issuedAt)
        return false;
    return Date.now() - issuedAt <= 120000;
}
function ingestMessagesToCache(instance, rawMessages, options) {
    const settings = getInstanceGeneral(instance);
    const fromHistory = Boolean(options?.fromHistory);
    const list = settings.ignoreGroups
        ? rawMessages.filter((msg) => {
            const key = (msg.key ?? {});
            const remoteJid = String(key.remoteJid ?? '').trim();
            return !remoteJid.endsWith('@g.us');
        })
        : rawMessages;
    // Para batches de history sync (que podem ter milhares de mensagens), envolve
    // tudo em uma única transação SQLite. Sem isso cada upsert vira um fsync
    // separado e bloqueia o event loop por segundos, derrubando o keepalive do
    // socket WhatsApp (causa-raiz dos 408 em loop durante a sync inicial).
    const runIngest = () => {
        let inserted = 0;
        for (const msg of list) {
            const key = (msg.key ?? {});
            const remoteJid = String(key.remoteJid ?? '').trim();
            const id = String(key.id ?? '').trim();
            if (!remoteJid || !id)
                continue;
            const message = msg.message;
            if (isSkippableSystemMessage(message))
                continue;
            const timestamp = normalizeTimestamp(msg.messageTimestamp);
            const text = extractMessageText(message);
            const sender = extractSender(msg);
            const mediaMeta = extractMediaMeta(message);
            const contactMeta = extractContactMeta(message);
            const mediaFound = findMediaNode(message);
            const quotedMessageId = extractQuotedMessageId(msg);
            const wasInserted = updateCachedMessage(instance, {
                jid: remoteJid,
                id,
                fromMe: Boolean(key.fromMe),
                text,
                timestamp,
                incrementUnread: fromHistory ? false : !Boolean(key.fromMe),
                senderName: sender.senderName,
                senderNumber: sender.senderNumber,
                participant: typeof key.participant === 'string' ? key.participant.trim() || undefined : undefined,
                quotedMessageId,
                media: mediaMeta
                    ? {
                        kind: mediaMeta.kind,
                        mimeType: mediaMeta.mimeType,
                        fileName: mediaMeta.fileName,
                        caption: mediaMeta.caption,
                        base64: mediaMeta.base64,
                    }
                    : undefined,
                contact: contactMeta ?? undefined,
                mediaSource: mediaFound ?? undefined,
            });
            if (wasInserted)
                inserted += 1;
        }
        return inserted;
    };
    // Threshold: para fromHistory >= 20 msgs, ou para qualquer batch >= 100,
    // vale a pena agrupar em transação (fsync único).
    const useTransaction = (fromHistory && list.length >= 20) || list.length >= 100;
    let inserted = 0;
    if (useTransaction) {
        try {
            inserted = msRunInTransaction(runIngest);
        }
        catch (err) {
            log.whatsapp.child(instance).warn('ingest_transaction_failed_fallback', err);
            inserted = runIngest();
        }
    }
    else {
        inserted = runIngest();
    }
    return { list, inserted };
}
/**
 * Versão async chunked de ingest para batches grandes de history sync.
 * Quebra a lista em pedaços de `chunkSize` e cede ao event loop entre chunks
 * (`setImmediate`), permitindo que o WebSocket do Baileys leia heartbeats e
 * envie acks sem ter que esperar o ingest inteiro terminar. Cada chunk roda
 * em sua própria transação SQLite.
 *
 * Use isto em handlers como `messaging-history.set`/`messages.set` que podem
 * receber milhares de mensagens em um único evento.
 */
const HISTORY_INGEST_CHUNK_SIZE = 200;
function nextTickYield() {
    return new Promise((resolve) => setImmediate(resolve));
}
async function ingestHistoryMessagesChunked(instance, rawMessages) {
    if (!rawMessages || rawMessages.length === 0) {
        return { list: [], inserted: 0 };
    }
    // Para listas pequenas, usa o caminho síncrono direto (com transaction).
    if (rawMessages.length <= HISTORY_INGEST_CHUNK_SIZE) {
        return ingestMessagesToCache(instance, rawMessages, { fromHistory: true });
    }
    const aggregatedList = [];
    let totalInserted = 0;
    for (let i = 0; i < rawMessages.length; i += HISTORY_INGEST_CHUNK_SIZE) {
        const chunk = rawMessages.slice(i, i + HISTORY_INGEST_CHUNK_SIZE);
        const result = ingestMessagesToCache(instance, chunk, { fromHistory: true });
        aggregatedList.push(...result.list);
        totalInserted += result.inserted;
        // Cede ao event loop entre chunks para deixar o socket processar I/O.
        if (i + HISTORY_INGEST_CHUNK_SIZE < rawMessages.length) {
            await nextTickYield();
        }
    }
    return { list: aggregatedList, inserted: totalInserted };
}
function closeSocket(sock) {
    // Remove todos os event listeners do socket morto para evitar acúmulo em reconexões.
    try {
        sock.ev?.removeAllListeners?.();
    }
    catch { /* ignore */ }
    try {
        sock.ws?.close?.();
    }
    catch {
        // ignore
    }
}
/**
 * Retorna o contexto da instância pelo nome, ou undefined se não existir.
 */
export function getInstance(name) {
    return instances.get(name);
}
/**
 * Retorna todas as instâncias.
 */
export function getAllInstances() {
    return Array.from(instances.values());
}
export async function reconnectPreviouslyActiveInstances(authFolder) {
    const authPath = path.resolve(process.cwd(), authFolder);
    const failed = [];
    if (!fs.existsSync(authPath)) {
        return { attempted: 0, started: 0, failed };
    }
    const savedSessions = new Set(fs
        .readdirSync(authPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isValidInstanceName(entry.name))
        .map((entry) => entry.name.trim()));
    const queue = [...savedSessions].filter((name) => {
        if (!isValidInstanceName(name))
            return false;
        const state = lastInstanceState.get(name);
        return shouldRestoreInstanceOnStartup(state, name, authFolder);
    });
    let started = 0;
    for (const name of queue) {
        const result = await createInstance(name, authFolder);
        if (result.ok) {
            started += 1;
        }
        else {
            failed.push(`${name}:${result.error ?? 'unknown_error'}`);
        }
        await sleep(250);
    }
    return {
        attempted: queue.length,
        started,
        failed,
    };
}
/**
 * Cria e inicia uma nova instância WhatsApp (InfiniteAPI/Baileys).
 * Gera QR code até o usuário escanear e conectar.
 * Em 515 (restartRequired) recria o socket automaticamente após 2s.
 */
export async function createInstance(name, authFolder) {
    const normalizedName = String(name ?? '').trim();
    if (!isValidInstanceName(normalizedName)) {
        return { ok: false, instance: normalizedName || String(name ?? ''), error: 'invalid_instance_name' };
    }
    name = normalizedName;
    if (instances.has(name)) {
        const ctx = instances.get(name);
        if (ctx.status === 'connected') {
            markAutostart(name, true);
            return { ok: true, instance: name };
        }
        if (ctx.status === 'qr' && ctx.qr) {
            return { ok: true, instance: name, qr: ctx.qr };
        }
        // disconnected ou connecting: para intervalos órfãos, remove do Map e fecha socket
        stopAlwaysOnline(name);
        stopContinuousHistorySync(name);
        instances.delete(name);
        reconnectAttempts.delete(name);
        closeSocket(ctx.sock);
    }
    try {
        const { default: makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestWaWebVersion, Browsers, } = await import('baileys');
        const authPath = path.resolve(process.cwd(), authFolder, name);
        // Detect a corrupted (0-byte) creds.json before loading auth state.
        // This can happen when the process is killed mid-write. If found, remove it
        // so that useMultiFileAuthState starts fresh (QR flow) instead of crashing
        // or silently treating the instance as unregistered.
        const credsFilePath = path.join(authPath, 'creds.json');
        try {
            const credsStat = fs.statSync(credsFilePath);
            if (credsStat.size === 0) {
                log.whatsapp.child(name).error('creds_corrupted_empty — creds.json está vazio (0 bytes), provavelmente corrompido por interrupção durante escrita; removendo para gerar novo QR');
                fs.unlinkSync(credsFilePath);
            }
        }
        catch {
            // File doesn't exist yet — normal for first-time setup
        }
        let authState = await useMultiFileAuthState(authPath);
        repairInconsistentOwnSignalSessions(authPath, authState.state.creds, name);
        if (authState.state.creds.registered !== true && isCompletedPairingState(authState.state.creds)) {
            authState.state.creds.registered = true;
            await authState.saveCreds().catch((err) => {
                log.whatsapp.child(name).error('saveCreds_failed_on_boot_registered_normalize', err);
            });
        }
        // If the persisted auth is partially populated but not actually registered,
        // it is unusable for both reconnect and fresh QR generation. Reset it here
        // before the socket is created so the next attempt starts from a clean session.
        if (hasCorruptExistingRegistration(name, authState.state.creds)) {
            if (isPairingWindowActive(name) || isAuthRecoveryWindowActive(name)) {
                log.whatsapp.child(name).warn('auth_corrupt_on_boot adiado — janela de recovery/QR ativa, mantendo auth para reconexão');
            }
            else {
                log.whatsapp.child(name).warn('auth_corrupt_on_boot — registered=false com identidade existente; recovery não destrutivo antes de criar socket');
                if (maybeResetInstanceAuthState(name, authPath, 'auth_corrupt_on_boot')) {
                    authState = await useMultiFileAuthState(authPath);
                }
                else {
                    trackLastInstanceState(name, {
                        status: 'auth_invalid',
                        wasConnected: false,
                        stoppedByUser: false,
                    });
                    markAutostart(name, false);
                    return { ok: false, instance: name, error: 'auth_corrupt_requires_manual_repair' };
                }
            }
        }
        const { state, saveCreds } = authState;
        let version;
        try {
            const wa = await fetchLatestWaWebVersion({});
            const v = wa.version;
            version = Array.isArray(v) && v.length >= 3 ? [v[0], v[1], v[2]] : [2, 3000, 1032884366];
        }
        catch {
            version = [2, 3000, 1032884366];
        }
        const generalSettings = getInstanceGeneral(name);
        const proxyAgentResult = await resolveProxyAgent(name);
        if (proxyAgentResult.error) {
            return { ok: false, instance: name, error: proxyAgentResult.error };
        }
        // Silent logger for Baileys: disables [BAILEYS] console.log spam (Message received,
        // Event buffer flushed, Event buffering started, histNotification, etc.) and the
        // pino histNotification info logs. Only fatal errors are kept.
        const silentLogger = {
            level: 'fatal',
            fatal: (..._args) => { },
            error: (..._args) => { },
            warn: (..._args) => { },
            info: (..._args) => { },
            debug: (..._args) => { },
            trace: (..._args) => { },
            child: () => silentLogger,
        };
        const signalKeyStore = makeCacheableSignalKeyStore(state.keys, silentLogger);
        const socketOptions = {
            auth: {
                creds: state.creds,
                keys: signalKeyStore,
            },
            printQRInTerminal: false,
            version,
            browser: Browsers.windows('Chrome'),
            syncFullHistory: generalSettings.syncFullHistory,
            logger: silentLogger,
            // Accelerate session cleanup: reduce retries for corrupted sessions (Bad MAC/Counter Error)
            // Default maxMsgRetryCount is 5; reducing to 2 means corrupted sessions are cleaned faster.
            maxMsgRetryCount: 2,
            // Ensure auto session recreation is enabled (default: true, making explicit)
            enableAutoSessionRecreation: true,
            // Aumenta keepalive de 15s (default) para 25s para reduzir reconexões espúrias
            // em redes com latência (Docker bridge, NAT, ISPs com idle-timeout curto).
            // Cada reconexão dispara reentrega de stanzas pelo WhatsApp, o que causa
            // Counter Errors (Key already used) em sessões Signal — em especial na sessão
            // própria do usuário (note-to-self). Reduzir reconexões = reduzir Counter Errors.
            keepAliveIntervalMs: 25_000,
            // Ensure corrupted sessions are auto-deleted after retries exhausted (default: true)
            sessionCleanupConfig: {
                autoCleanCorrupted: true,
                enabled: true,
                cleanupOnStartup: true,
                secondaryDeviceInactiveDays: 7,
                primaryDeviceInactiveDays: 30,
                lidOrphanHours: 24,
            },
        };
        if (proxyAgentResult.agent) {
            socketOptions.agent = proxyAgentResult.agent;
            socketOptions.fetchAgent = proxyAgentResult.agent;
        }
        const sock = makeWASocket(socketOptions);
        const ctx = {
            name,
            sock,
            status: 'connecting',
            qr: null,
            createdAt: new Date(),
            authFolder,
        };
        instances.set(name, ctx);
        reconnectAttempts.set(name, 0);
        trackLastInstanceState(name, {
            status: 'connecting',
            stoppedByUser: false,
        });
        sock.ev.on('creds.update', (creds) => {
            void saveCreds().catch((err) => {
                log.whatsapp.child(name).error('saveCreds_failed', err);
            });
            const registered = Boolean(creds?.registered);
            if (registered) {
                pairingIssuedAt.delete(name);
            }
        });
        sock.ev.on('connection.update', ((update) => {
            emitWebhookEvent('connection.update', { instance: name, update }, name);
            void emitInstanceEvent(name, 'CONNECTION_UPDATE', { update });
            const { connection, qr, lastDisconnect } = (update ?? {});
            if (qr) {
                ctx.status = 'qr';
                ctx.qr = qr;
                markAuthRecoveryWindow(name);
                trackLastInstanceState(name, {
                    status: 'qr',
                    stoppedByUser: false,
                });
                void emitInstanceEvent(name, 'QRCODE_UPDATED', { hasQr: true });
            }
            if (connection === 'open') {
                ctx.status = 'connected';
                ctx.qr = null;
                recordConnected(name);
                authRecoveryIssuedAt.delete(name);
                reconnectAttempts.set(name, 0);
                if (state.creds.registered !== true && isCompletedPairingState(state.creds)) {
                    state.creds.registered = true;
                    void saveCreds().catch((err) => {
                        log.whatsapp.child(name).error('saveCreds_failed_after_registered_normalize', err);
                    });
                }
                markAutostart(name, true);
                trackLastInstanceState(name, {
                    status: 'connected',
                    wasConnected: true,
                    stoppedByUser: false,
                });
                const currentUser = ctx.sock.user ?? {};
                const linkedJid = String(currentUser.id ?? '').trim();
                const linkedNumber = linkedJid ? linkedJid.split(':')[0].split('@')[0] : '';
                ctx.linkedNumber = linkedNumber || null;
                ctx.profileName = String(currentUser.name ?? '').trim() || null;
                // Memoize own JID user parts so handleCorruptedSelfSessions avoids
                // recomputing them on every messages.upsert event.
                {
                    const sockTyped = ctx.sock;
                    const rawPn = String(sockTyped.authState?.creds?.me?.id ?? sockTyped.user?.id ?? '');
                    const rawLid = String(sockTyped.authState?.creds?.me?.lid ?? sockTyped.user?.lid ?? '');
                    ctx.ownPnUser = rawPn ? rawPn.split('@')[0].split(':')[0] : undefined;
                    ctx.ownLidUser = rawLid ? rawLid.split('@')[0].split(':')[0] : undefined;
                }
                if (typeof ctx.sock.profilePictureUrl === 'function' && linkedJid) {
                    ctx.sock
                        .profilePictureUrl(linkedJid)
                        .then((url) => {
                        if (instances.get(name) === ctx) {
                            ctx.profilePictureUrl = url || null;
                        }
                    })
                        .catch(() => {
                        if (instances.get(name) === ctx) {
                            ctx.profilePictureUrl = null;
                        }
                    });
                }
                startAlwaysOnline(name, ctx);
                startContinuousHistorySync(name, ctx);
                // Nota: não chamamos assertSessions para o próprio JID (note-to-self) porque
                // o WA recusa buscar pre-keys do próprio número. A sessão Signal é reconstruída
                // automaticamente quando o WA envia novas pre-keys na próxima troca de mensagens.
                if (forceAppStateResync.has(name)) {
                    forceAppStateResync.delete(name);
                    const anySock = ctx.sock;
                    if (typeof anySock.resyncAppState === 'function') {
                        void anySock.resyncAppState(['critical_block', 'regular']).catch((err) => {
                            log.whatsapp.child(name).warn('forced_app_state_resync_failed', err);
                        });
                    }
                }
                // Auto-create Chatwoot inbox if configured + auto-sync history if Import Messages is enabled.
                // Wait a few seconds before sync so initial history sync has had time to populate the SQLite store.
                void (async () => {
                    try {
                        await autoCreateChatwootInbox(name, linkedNumber ?? null);
                    }
                    catch (err) {
                        log.whatsapp.child(name).error('Erro ao criar inbox no Chatwoot automaticamente (autoCreateChatwootInbox)', err);
                    }
                    try {
                        // Use the already-imported static reference — no dynamic import needed.
                        const { syncHistoryToChatwoot: syncHist } = await import('./chatwoot-bridge.js');
                        const cfg = getInstanceIntegrations(name).chatwoot;
                        if (cfg.enabled && cfg.importMessages === true && cfg.baseUrl && cfg.accountId && cfg.apiAccessToken) {
                            // Wait 8s after connect for initial Baileys history sync to populate SQLite
                            await new Promise(r => setTimeout(r, 8000));
                            const current = instances.get(name);
                            if (current !== ctx || current?.status !== 'connected')
                                return;
                            syncHist(name, undefined, 200, 'connect').catch((err) => {
                                log.whatsapp.child(name).warn('connect-trigger sync_failed', err);
                            });
                        }
                    }
                    catch (err) {
                        log.whatsapp.child(name).warn('connect-trigger sync_error', err);
                    }
                })();
            }
            if (connection === 'close') {
                // Ignore close events from stale sockets that are no longer current.
                if (instances.get(name) !== ctx) {
                    return;
                }
                const previousStatus = ctx.status;
                const { code, message } = formatDisconnectInfo(lastDisconnect);
                ctx.status = 'disconnected';
                ctx.qr = null;
                if (!processShuttingDown || previousStatus === 'disconnected') {
                    trackLastInstanceState(name, {
                        status: 'disconnected',
                    });
                }
                log.whatsapp.child(name).info(`connection_close  code=${String(code ?? 'n/a')}  message=${String(message ?? 'n/a')}`);
                recordConnectionClose(name, code);
                // 515 = restartRequired: durante o pareamento isso e normal. O WhatsApp
                // pede apenas que o socket seja recriado usando a mesma auth recem-gravada.
                // Esse caso precisa acontecer ANTES do bloco auth_corrupt, porque nesse
                // momento `registered=false` ainda pode aparecer transitoriamente.
                if (code === DisconnectReason.restartRequired) {
                    const folder = ctx.authFolder;
                    markAuthRecoveryWindow(name);
                    closeSocket(ctx.sock);
                    ctx.status = 'connecting';
                    ctx.qr = null;
                    trackLastInstanceState(name, {
                        status: 'connecting',
                        stoppedByUser: false,
                    });
                    stopAlwaysOnline(name);
                    stopContinuousHistorySync(name);
                    // TODO: guardar handle em pendingReconnectTimer para cancelar se desconectado manualmente
                    setTimeout(() => {
                        if (!processShuttingDown)
                            createInstance(name, folder).catch(() => { });
                    }, 2000);
                    return;
                }
                if (hasCorruptExistingRegistration(name, state.creds)) {
                    const pairingActive = isPairingWindowActive(name);
                    const recoveryActive = isAuthRecoveryWindowActive(name);
                    const authLikeClose = code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced;
                    const transientConnectedClose = previousStatus === 'connected' && !authLikeClose;
                    const folder = ctx.authFolder;
                    const authPath = path.resolve(process.cwd(), folder, name);
                    // `registered=false` pode aparecer de forma transitoria durante QR/restart
                    // e tambem em um close 408 de sessao ja conectada. Nesses casos nao
                    // devemos apagar a auth; devemos apenas recriar o socket e deixar o
                    // fluxo normal de recovery acontecer.
                    if (recoveryActive && !authLikeClose) {
                        log.whatsapp.child(name).warn(`auth_corrupt adiado — janela QR/recovery ativa  code=${String(code ?? 'n/a')}`);
                        closeSocket(ctx.sock);
                        ctx.status = 'connecting';
                        ctx.qr = null;
                        trackLastInstanceState(name, {
                            status: 'connecting',
                            wasConnected: false,
                            stoppedByUser: false,
                        });
                        stopAlwaysOnline(name);
                        stopContinuousHistorySync(name);
                        // TODO: guardar handle em pendingReconnectTimer para cancelar se desconectado manualmente
                        setTimeout(() => {
                            if (!processShuttingDown)
                                createInstance(name, folder).catch(() => { });
                        }, 1200);
                        return;
                    }
                    if (transientConnectedClose) {
                        // Session was connected — treat as transient disconnect, let normal reconnect logic handle it below.
                        log.whatsapp.child(name).warn(`auth_corrupt adiado após close transitório  code=${String(code ?? 'n/a')}  previousStatus=connected`);
                    }
                    else {
                        log.whatsapp.child(name).warn(`auth_corrupt — registered=false com identidade existente; recovery${pairingActive ? ' durante pairing' : ''}`);
                        closeSocket(ctx.sock);
                        reconnectAttempts.delete(name);
                        const authWasReset = maybeResetInstanceAuthState(name, authPath, 'auth_corrupt_after_close');
                        stopAlwaysOnline(name);
                        stopContinuousHistorySync(name);
                        if (pairingActive && authWasReset) {
                            ctx.status = 'connecting';
                            ctx.qr = null;
                            trackLastInstanceState(name, {
                                status: 'connecting',
                                wasConnected: false,
                                stoppedByUser: false,
                            });
                            // TODO: guardar handle em pendingReconnectTimer para cancelar se desconectado manualmente
                            setTimeout(() => {
                                if (!processShuttingDown)
                                    createInstance(name, folder).catch(() => { });
                            }, 1200);
                        }
                        else {
                            instances.delete(name);
                            trackLastInstanceState(name, {
                                status: 'disconnected',
                                wasConnected: false,
                                stoppedByUser: false,
                            });
                            pairingIssuedAt.delete(name);
                        }
                        return;
                    }
                }
                if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced) {
                    if (isPairingWindowActive(name)) {
                        const folder = ctx.authFolder;
                        const authPath = path.resolve(process.cwd(), folder, name);
                        log.whatsapp.child(name).warn(`pairing_window_close  code=${String(code)}  destructive_recovery=${String(config.whatsapp.autoResetCorruptAuth)}`);
                        closeSocket(ctx.sock);
                        stopAlwaysOnline(name);
                        stopContinuousHistorySync(name);
                        const authWasReset = maybeResetInstanceAuthState(name, authPath, 'pairing_window_close');
                        if (!authWasReset) {
                            log.whatsapp.child(name).warn(`pairing_window_close  preserve_auth_and_reconnect  code=${String(code)}`);
                        }
                        ctx.status = 'connecting';
                        ctx.qr = null;
                        reconnectAttempts.set(name, 0);
                        trackLastInstanceState(name, {
                            status: 'connecting',
                            wasConnected: false,
                            stoppedByUser: false,
                        });
                        // TODO: guardar handle em pendingReconnectTimer para cancelar se desconectado manualmente
                        setTimeout(() => {
                            if (!processShuttingDown)
                                createInstance(name, folder).catch(() => { });
                        }, 1200);
                        return;
                    }
                    const attempts = (reconnectAttempts.get(name) ?? 0) + 1;
                    const allowRecovery = previousStatus === 'connected' && attempts <= 6;
                    if (allowRecovery) {
                        reconnectAttempts.set(name, attempts);
                        const folder = ctx.authFolder;
                        const delayMs = Math.min(1000 * attempts, 6000);
                        markAuthRecoveryWindow(name);
                        log.whatsapp.child(name).warn(`auth_close_recover  code=${String(code)}  attempt=${attempts}  delay_ms=${delayMs}`);
                        closeSocket(ctx.sock);
                        ctx.status = 'connecting';
                        trackLastInstanceState(name, {
                            status: 'connecting',
                            stoppedByUser: false,
                        });
                        // TODO: guardar handle em pendingReconnectTimer para cancelar se desconectado manualmente
                        setTimeout(() => {
                            if (!processShuttingDown)
                                createInstance(name, folder).catch(() => { });
                        }, delayMs);
                        return;
                    }
                    // WhatsApp invalidou a sessão remotamente (deslogado do celular,
                    // device limit, expired credentials, etc). A auth no disco está
                    // permanentemente inválida — qualquer reconexão futura usando essa
                    // creds vai receber 401 imediato sem nunca emitir QR.
                    // Para destravar, apagamos a auth para que o próximo POST /v1/instances
                    // gere um QR limpo de pareamento.
                    const folder = ctx.authFolder;
                    const authPath = path.resolve(process.cwd(), folder, name);
                    log.whatsapp.child(name).warn(`auth_invalid_session_dropped  code=${String(code)}  previousStatus=${previousStatus}  reset_auth=true`);
                    closeSocket(ctx.sock);
                    stopAlwaysOnline(name);
                    stopContinuousHistorySync(name);
                    const authWasReset = maybeResetInstanceAuthState(name, authPath, 'auth_invalid_session_dropped');
                    if (!authWasReset) {
                        log.whatsapp.child(name).warn(`auth_invalid_session_dropped  reset_blocked  code=${String(code)}`);
                    }
                    instances.delete(name);
                    reconnectAttempts.delete(name);
                    markAutostart(name, false);
                    trackLastInstanceState(name, {
                        status: 'auth_invalid',
                        wasConnected: false,
                        stoppedByUser: false,
                    });
                    chatCache.delete(name);
                    clearInstanceMediaBinaries(name, true);
                    pairingIssuedAt.delete(name);
                    return;
                }
                // For transient closes (timeout/network/stream), only auto-recreate if it was already connected.
                // Exception: code=408 (QR expired) while in QR mode but auth files exist means
                // the session was previously established — auto-regenerate QR instead of giving up.
                if (previousStatus !== 'connected') {
                    if (code === 408) {
                        const folder = ctx.authFolder;
                        const authPath = path.resolve(process.cwd(), folder, name);
                        let hasAuthFiles = false;
                        try {
                            hasAuthFiles = fs.readdirSync(authPath).length > 0;
                        }
                        catch { /* ignore */ }
                        if (hasAuthFiles) {
                            log.whatsapp.child(name).info(`qr_expired_retry — auth existe, recriando QR  code=${String(code)}`);
                            closeSocket(ctx.sock);
                            ctx.status = 'connecting';
                            ctx.qr = null;
                            trackLastInstanceState(name, { status: 'connecting', stoppedByUser: false });
                            // TODO: guardar handle em pendingReconnectTimer para cancelar se desconectado manualmente
                            setTimeout(() => { if (!processShuttingDown)
                                createInstance(name, folder).catch(() => { }); }, 2000);
                            return;
                        }
                    }
                    return;
                }
                const attempts = (reconnectAttempts.get(name) ?? 0) + 1;
                reconnectAttempts.set(name, attempts);
                if (attempts <= 6) {
                    const folder = ctx.authFolder;
                    const delayMs = Math.min(1000 * attempts, 6000);
                    markAuthRecoveryWindow(name);
                    log.whatsapp.child(name).info(`reconnect_attempt=${attempts}  delay_ms=${delayMs}`);
                    recordReconnectAttempt(name);
                    closeSocket(ctx.sock);
                    ctx.status = 'connecting';
                    trackLastInstanceState(name, {
                        status: 'connecting',
                        stoppedByUser: false,
                    });
                    stopAlwaysOnline(name);
                    stopContinuousHistorySync(name);
                    // TODO: guardar handle em pendingReconnectTimer para cancelar se desconectado manualmente
                    setTimeout(() => {
                        if (!processShuttingDown)
                            createInstance(name, folder).catch(() => { });
                    }, delayMs);
                }
                else {
                    log.whatsapp.child(name).error(`reconnect_exhausted — esgotadas ${attempts} tentativas de reconexão, instância desconectada`);
                    // Cleanup completo: remover do Map, parar intervalos, atualizar estado persistido.
                    // Sem cleanup, o socket morto e os intervalos ficam em memória indefinidamente.
                    stopAlwaysOnline(name);
                    stopContinuousHistorySync(name);
                    closeSocket(ctx.sock);
                    instances.delete(name);
                    reconnectAttempts.delete(name);
                    trackLastInstanceState(name, { status: 'disconnected', wasConnected: false, stoppedByUser: false });
                }
            }
        }));
        sock.ev.on('messages.upsert', (payload) => {
            const data = (payload ?? {});
            const originalList = Array.isArray(data.messages) ? data.messages : [];
            const ingested = ingestMessagesToCache(name, originalList, { fromHistory: false });
            recordMessagesUpsert(name, ingested.inserted);
            const list = ingested.list;
            // Detecta mensagens que falharam descriptografia (CIPHERTEXT stub) na própria
            // sessão Signal do usuário (note-to-self) ou em sessões com Counter Error
            // recorrente, e dispara cleanup imediato dessa sessão para forçar
            // renegociação. Sem isso, o Baileys aguarda maxMsgRetryCount (2) tentativas
            // antes de limpar — o que gera spam de logs "Counter Error" e mantém a
            // sessão quebrada por mais tempo.
            void handleCorruptedSelfSessions(name, ctx, list).catch((err) => {
                log.whatsapp.child(name).warn('handleCorruptedSelfSessions_failed', err);
            });
            // Resolver títulos de JIDs @lid via lidMapping → nome do contato, quando importContacts=true.
            // Em Baileys 7.x não existe mais `sock.store`, então a única fonte de nome
            // disponível na hora de uma mensagem é `msg.senderName` (pushName).
            void (async () => {
                try {
                    const lidMapping = ctx.sock?.signalRepository?.lidMapping;
                    if (!lidMapping?.getPNForLID)
                        return;
                    const importContactsEnabled = getInstanceGeneral(name).importContacts === true;
                    if (!importContactsEnabled)
                        return;
                    const chatList = getInstanceChatList(name);
                    const chatListByJid = new Map(chatList.map((c) => [c.jid, c]));
                    for (const msg of list) {
                        const msgJid = String(msg.jid ?? '');
                        if (!msgJid.endsWith('@lid'))
                            continue;
                        const existing = chatListByJid.get(msgJid);
                        if (existing?.title && !/^\d+$/.test(existing.title))
                            continue; // já tem nome real
                        const pn = await lidMapping.getPNForLID(msgJid).catch(() => null);
                        if (!pn)
                            continue;
                        const pnUser = String(pn).split('@')[0].split(':')[0];
                        if (!pnUser || !/^\d+$/.test(pnUser))
                            continue;
                        const pnJid = `${pnUser}@s.whatsapp.net`;
                        const name_ = String(msg.senderName || '').trim();
                        if (name_ && !/^\d+$/.test(name_) && name_ !== pnUser) {
                            // Grava em contacts (fonte de verdade) com lid + phoneNumber.
                            // sender_name vem do pushName → mapeado como "notify" (fraco), preservando
                            // qualquer "name" forte já gravado por eventos contacts.*.
                            try {
                                msUpsertContact(name, {
                                    jid: pnJid,
                                    lid: msgJid,
                                    phoneNumber: pnJid,
                                    notify: name_,
                                });
                            }
                            catch { /* best-effort */ }
                            upsertCachedChatMeta(name, { jid: msgJid, title: name_ });
                            upsertCachedChatMeta(name, { jid: pnJid, title: name_ });
                        }
                    }
                }
                catch { /* best-effort */ }
            })();
            // Promoção ativa de contatos a partir de pushName: a cada `messages.upsert`,
            // para mensagens recebidas de JIDs PN (@s.whatsapp.net), grava o pushName
            // (msg.senderName) na tabela `contacts` como `notify` (campo fraco).
            // Em Baileys 7.x não existe mais `sock.store`, então pushName é a única
            // fonte de nome obtida em runtime sem depender de eventos `contacts.*`.
            // upsertContact preserva qualquer `name`/`verifiedName` forte já existente
            // graças ao CASE WHEN baseado em isMeaningfulName.
            void (async () => {
                try {
                    if (getInstanceGeneral(name).importContacts !== true)
                        return;
                    // Coleta de pares (jid, pushName) únicos para gravar.
                    const candidates = new Map();
                    for (const msg of list) {
                        if (msg.fromMe)
                            continue;
                        const pushName = String(msg.senderName ?? '').trim();
                        if (!pushName)
                            continue;
                        if (/^\d+$/.test(pushName))
                            continue; // só números, ignora
                        // JID principal da conversa (chat).
                        const jid = String(msg.jid ?? '');
                        if (jid.endsWith('@s.whatsapp.net')) {
                            candidates.set(jid, pushName);
                        }
                        // Participante: em mensagens de grupo, é o PN do remetente real.
                        const participant = String(msg.participant ?? '');
                        if (participant.endsWith('@s.whatsapp.net')) {
                            candidates.set(participant, pushName);
                        }
                    }
                    if (candidates.size === 0)
                        return;
                    for (const [jid, pushName] of candidates) {
                        try {
                            msUpsertContact(name, {
                                jid,
                                phoneNumber: jid,
                                notify: pushName,
                            });
                        }
                        catch { /* best-effort */ }
                    }
                }
                catch { /* best-effort */ }
            })();
            if (list.length > 0) {
                (async () => {
                    const enrichedList = await enrichIncomingMediaBase64(list);
                    const outboundMessages = await normalizeUpsertMessagesForExternal(name, enrichedList);
                    const payloadObject = (typeof payload === 'object' && payload !== null ? payload : {});
                    const payloadForEvents = {
                        type: typeof payloadObject.type === 'string' ? payloadObject.type : 'notify',
                        messages: outboundMessages,
                    };
                    emitWebhookEvent('messages.upsert', payloadForEvents, name);
                    await emitInstanceEvent(name, 'MESSAGES_UPSERT', payloadForEvents);
                    // Forward to Chatwoot if integration is enabled (best-effort, non-blocking).
                    // Pre-filter system messages (protocolMessage, senderKeyDistributionMessage,
                    // historySyncNotification, reactionMessage) — they are not real user messages
                    // and should not even reach the bridge to avoid log spam and wasted work.
                    const realMessages = outboundMessages.filter((m) => {
                        const raw = m?.message;
                        if (!raw)
                            return false;
                        if (raw.protocolMessage || raw.senderKeyDistributionMessage || raw.reactionMessage)
                            return false;
                        return true;
                    });
                    if (realMessages.length > 0) {
                        // Garante que mídias tenham base64 inline para o Chatwoot,
                        // independentemente da flag de webhooks externos. Sem isso, áudios,
                        // vídeos e imagens chegam vazios no Chatwoot.
                        const messagesForChatwoot = await enrichMediaForChatwoot(realMessages, name);
                        void dispatchToChatwoot(name, messagesForChatwoot);
                    }
                })().catch((err) => {
                    log.whatsapp.child(name).error('messages.upsert pipeline_error', err);
                });
            }
            const settings = getInstanceGeneral(name);
            const keysToRead = new Map();
            const addKeyToRead = (entry) => {
                keysToRead.set(`${entry.remoteJid}:${entry.id}`, entry);
            };
            for (const msg of list) {
                const key = (msg.key ?? {});
                const remoteJid = String(key.remoteJid ?? '').trim();
                const id = String(key.id ?? '').trim();
                if (!remoteJid || !id)
                    continue;
                if (!key.fromMe && settings.autoReadMessages && remoteJid !== 'status@broadcast' && typeof ctx.sock.readMessages === 'function') {
                    addKeyToRead({
                        remoteJid,
                        id,
                        participant: key.participant,
                        fromMe: false,
                    });
                }
                if (remoteJid === 'status@broadcast' && settings.readStatus && typeof ctx.sock.readMessages === 'function') {
                    addKeyToRead({
                        remoteJid,
                        id,
                        participant: key.participant,
                        fromMe: false,
                    });
                }
            }
            if (keysToRead.size && typeof ctx.sock.readMessages === 'function') {
                // PRIO-2 (humanize): em vez de chamar readMessages na MESMA tick do
                // upsert (que renderiza as duas marcas azuis em <50ms — assinatura
                // claríssima de bot), agendamos com delay aleatório + quebramos em
                // chunks por chat. Em modo humanize off, mantemos o comportamento
                // original (single call, instantâneo).
                const allKeys = [...keysToRead.values()];
                const humanize = getHumanizeSettings(name);
                if (!humanize.enabled) {
                    ctx.sock.readMessages(allKeys).catch(() => { });
                }
                else {
                    void (async () => {
                        // Initial delay — "leitura humana": 2.5–11s default antes da
                        // primeira ack-bateria.
                        await humanSleep(humanRandomIntBetween(humanize.autoReadDelayMinMs, humanize.autoReadDelayMaxMs));
                        // Re-check connection após o sleep (pode ter caído nesse meio).
                        const sock = instances.get(name)?.sock;
                        if (!sock || typeof sock.readMessages !== 'function')
                            return;
                        // Quebra em chunks com sleep entre eles. Mantém envio em ordem.
                        const chunkSize = Math.max(1, humanize.autoReadChunkSize);
                        for (let i = 0; i < allKeys.length; i += chunkSize) {
                            const chunk = allKeys.slice(i, i + chunkSize);
                            try {
                                await sock.readMessages(chunk);
                            }
                            catch {
                                // best-effort
                            }
                            if (i + chunkSize < allKeys.length) {
                                await humanSleep(humanRandomIntBetween(humanize.autoReadChunkSleepMinMs, humanize.autoReadChunkSleepMaxMs));
                            }
                        }
                    })().catch(() => { });
                }
            }
        });
        sock.ev.on('messages.set', (payload) => {
            const data = (payload ?? {});
            const originalList = Array.isArray(data.messages) ? data.messages : [];
            // Ingest chunked + async para não bloquear o event loop em syncs grandes.
            void ingestHistoryMessagesChunked(name, originalList).then((ingested) => {
                if (ingested.list.length > 0) {
                    void emitInstanceEvent(name, 'MESSAGES_SET', {
                        ...(typeof payload === 'object' && payload !== null ? payload : {}),
                        messages: ingested.list,
                    });
                }
            }).catch((err) => {
                log.whatsapp.child(name).warn('messages_set_ingest_failed', err);
            });
        });
        sock.ev.on('messaging-history.set', (payload) => {
            const data = (payload ?? {});
            const settings = getInstanceGeneral(name);
            // Persistir contatos do app-state sync inicial. Este é o canal mais
            // importante: o Baileys entrega aqui a snapshot completa dos contatos
            // da agenda do usuário. Ignorávamos o array antes — esse era o bug
            // principal de "não consigo importar contatos".
            const incomingContacts = Array.isArray(data.contacts) ? data.contacts : [];
            let ingestedContacts = 0;
            if (incomingContacts.length > 0 && settings.importContacts === true) {
                try {
                    ingestedContacts = msBulkUpsertContacts(name, incomingContacts);
                }
                catch (err) {
                    log.whatsapp.child(name).warn('history_contacts_ingest_failed', err);
                }
            }
            const chats = Array.isArray(data.chats) ? data.chats : [];
            // Agrupa upsert de chat_meta em uma única transação (mesmo problema:
            // sem isso cada chat vira um fsync em série).
            if (chats.length > 0) {
                try {
                    msRunInTransaction(() => {
                        for (const item of chats) {
                            const jid = String(item.id ?? item.jid ?? '').trim();
                            if (!jid)
                                continue;
                            if (settings.ignoreGroups && jid.endsWith('@g.us'))
                                continue;
                            upsertCachedChatMeta(name, {
                                jid,
                                title: extractChatTitleFromPayload(item),
                                timestamp: normalizeTimestampOrZero(item.conversationTimestamp),
                            });
                        }
                    });
                }
                catch (err) {
                    log.whatsapp.child(name).warn('history_chats_ingest_failed', err);
                }
            }
            const originalList = Array.isArray(data.messages) ? data.messages : [];
            // Log de visibilidade: o evento mais relevante para popular contatos é
            // emitido só uma vez por conexão. Importante saber em INFO o que veio.
            log.whatsapp.child(name).info(`messaging_history_set chats=${chats.length} contacts=${incomingContacts.length} contactsIngested=${ingestedContacts} messages=${originalList.length} importContacts=${settings.importContacts === true}`);
            // Ingest chunked + async para não bloquear o event loop. Esse handler
            // tipicamente recebe centenas/milhares de mensagens — sem o chunking,
            // o keepalive estoura e a conexão cai (408), reiniciando a sync em loop.
            void ingestHistoryMessagesChunked(name, originalList).then((ingested) => {
                if (ingested.list.length > 0) {
                    void emitInstanceEvent(name, 'MESSAGES_SET', { payload: { messages: ingested.list } });
                }
            }).catch((err) => {
                log.whatsapp.child(name).warn('messaging_history_set_ingest_failed', err);
            });
            if (chats.length > 0) {
                void emitInstanceEvent(name, 'CHATS_SET', { payload: { chats } });
            }
        });
        sock.ev.on('messages.update', (payload) => {
            updateOutboundDeliveryFromMessageUpdate(name, payload);
            emitWebhookEvent('messages.update', { instance: name, payload }, name);
            void emitInstanceEvent(name, 'MESSAGES_UPDATE', { payload });
        });
        sock.ev.on('message-receipt.update', (payload) => {
            updateOutboundDeliveryFromReceiptUpdate(name, payload);
            emitWebhookEvent('message-receipt.update', { instance: name, payload }, name);
        });
        sock.ev.on('chats.update', (payload) => {
            emitWebhookEvent('chats.update', { instance: name, payload }, name);
            void emitInstanceEvent(name, 'CHATS_UPDATE', { payload });
            const settings = getInstanceGeneral(name);
            const updates = Array.isArray(payload) ? payload : [];
            const doChatsUpdate = () => {
                for (const item of updates) {
                    const jid = String(item.id ?? item.jid ?? '').trim();
                    if (!jid)
                        continue;
                    if (settings.ignoreGroups && jid.endsWith('@g.us'))
                        continue;
                    upsertCachedChatMeta(name, {
                        jid,
                        title: extractChatTitleFromPayload(item),
                        timestamp: normalizeTimestampOrZero(item.conversationTimestamp),
                    });
                }
            };
            if (updates.length >= 5) {
                try {
                    msRunInTransaction(doChatsUpdate);
                }
                catch {
                    doChatsUpdate();
                }
            }
            else {
                doChatsUpdate();
            }
        });
        sock.ev.on('groups.update', (payload) => {
            emitWebhookEvent('groups.update', { instance: name, payload }, name);
            void emitInstanceEvent(name, 'GROUP_UPDATE', { payload });
            // Persistir subject atualizado no chat_meta quando o nome do grupo muda
            const updates = Array.isArray(payload) ? payload : [];
            if (updates.length === 0)
                return;
            const doUpdate = () => {
                for (const item of updates) {
                    const jid = String(item.id ?? '').trim();
                    const subject = String(item.subject ?? '').trim();
                    if (jid && subject) {
                        upsertCachedChatMeta(name, { jid, title: subject });
                    }
                }
            };
            if (updates.length >= 5) {
                try {
                    msRunInTransaction(doUpdate);
                }
                catch {
                    doUpdate();
                }
            }
            else {
                doUpdate();
            }
        });
        sock.ev.on('chats.set', (payload) => {
            void emitInstanceEvent(name, 'CHATS_SET', { payload });
            const settings = getInstanceGeneral(name);
            const data = (payload ?? {});
            const chats = Array.isArray(data.chats) ? data.chats : [];
            const doChatsSet = () => {
                for (const item of chats) {
                    const jid = String(item.id ?? item.jid ?? '').trim();
                    if (!jid)
                        continue;
                    if (settings.ignoreGroups && jid.endsWith('@g.us'))
                        continue;
                    upsertCachedChatMeta(name, {
                        jid,
                        title: extractChatTitleFromPayload(item),
                        timestamp: normalizeTimestampOrZero(item.conversationTimestamp),
                    });
                }
            };
            if (chats.length >= 5) {
                try {
                    msRunInTransaction(doChatsSet);
                }
                catch {
                    doChatsSet();
                }
            }
            else {
                doChatsSet();
            }
        });
        sock.ev.on('chats.upsert', (payload) => {
            void emitInstanceEvent(name, 'CHATS_UPSERT', { payload });
            const settings = getInstanceGeneral(name);
            const list = Array.isArray(payload) ? payload : [];
            const doChatsUpsert = () => {
                for (const item of list) {
                    const jid = String(item.id ?? item.jid ?? '').trim();
                    if (!jid)
                        continue;
                    if (settings.ignoreGroups && jid.endsWith('@g.us'))
                        continue;
                    upsertCachedChatMeta(name, {
                        jid,
                        title: extractChatTitleFromPayload(item),
                        timestamp: normalizeTimestampOrZero(item.conversationTimestamp),
                    });
                }
            };
            if (list.length >= 5) {
                try {
                    msRunInTransaction(doChatsUpsert);
                }
                catch {
                    doChatsUpsert();
                }
            }
            else {
                doChatsUpsert();
            }
        });
        // Handler unificado para todos os eventos contacts.*. Persiste em
        // contacts (fonte de verdade) usando bulkUpsertContacts. Não escreve
        // em chat_meta.title — esse canal é só para metadados de chat.
        // O guard usa general.importContacts (não mais chatwoot.importContacts).
        const handleContactsBatch = (origin, raw) => {
            if (getInstanceGeneral(name).importContacts !== true)
                return;
            if (!raw || raw.length === 0)
                return;
            try {
                const ingested = msBulkUpsertContacts(name, raw);
                if (ingested > 0) {
                    log.whatsapp.child(name).debug(`${origin}_ingested count=${ingested}`);
                }
            }
            catch (err) {
                log.whatsapp.child(name).warn(`${origin}_ingest_failed`, err);
            }
        };
        sock.ev.on('contacts.set', (payload) => {
            void emitInstanceEvent(name, 'CONTACTS_SET', { payload });
            const data = (payload ?? {});
            handleContactsBatch('contacts.set', Array.isArray(data.contacts) ? data.contacts : []);
        });
        sock.ev.on('contacts.update', (payload) => {
            void emitInstanceEvent(name, 'CONTACTS_UPDATE', { payload });
            handleContactsBatch('contacts.update', Array.isArray(payload) ? payload : []);
        });
        sock.ev.on('contacts.upsert', (payload) => {
            void emitInstanceEvent(name, 'CONTACTS_UPSERT', { payload });
            handleContactsBatch('contacts.upsert', Array.isArray(payload) ? payload : []);
        });
        sock.ev.on('groups.upsert', (payload) => {
            void emitInstanceEvent(name, 'GROUPS_UPSERT', { payload });
        });
        sock.ev.on('group-participants.update', (payload) => {
            void emitInstanceEvent(name, 'GROUP_PARTICIPANTS_UPDATE', { payload });
        });
        sock.ev.on('call', (payload) => {
            void emitInstanceEvent(name, 'CALL', { payload });
            const settings = getInstanceGeneral(name);
            if (!settings.rejectCalls)
                return;
            const entries = Array.isArray(payload) ? payload : [payload];
            for (const item of entries) {
                const call = item;
                const callId = String(call?.id ?? '').trim();
                const callFrom = String(call?.from ?? call?.chatId ?? '').trim();
                const callStatus = String(call?.status ?? '').trim().toLowerCase();
                if (!callId || !callFrom)
                    continue;
                if (callStatus && callStatus !== 'offer' && callStatus !== 'ringing')
                    continue;
                if (typeof ctx.sock.rejectCall === 'function') {
                    ctx.sock.rejectCall(callId, callFrom).catch(() => { });
                }
            }
        });
        return { ok: true, instance: name, qr: ctx.qr ?? undefined };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, instance: name, error: message };
    }
}
export function normalizePairingPhoneNumber(rawPhone, defaultCountryCode) {
    const digits = rawPhone.replace(/\D/g, '');
    if (!digits)
        return '';
    const countryCode = defaultCountryCode.replace(/\D/g, '');
    if (!countryCode)
        return digits;
    if (digits.startsWith(countryCode))
        return digits;
    if (digits.length <= 11)
        return `${countryCode}${digits}`;
    return digits;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function requestInstancePairingCode(name, phoneNumber) {
    const ctx = instances.get(name);
    if (!ctx) {
        return { ok: false, error: 'instance_not_found' };
    }
    if (ctx.status === 'connected') {
        return { ok: false, error: 'instance_already_connected', status: ctx.status };
    }
    if (typeof ctx.sock.requestPairingCode !== 'function') {
        return { ok: false, error: 'pairing_code_not_supported' };
    }
    let lastError = 'pairing_code_unavailable';
    for (let attempt = 1; attempt <= 8; attempt++) {
        const current = instances.get(name);
        if (!current) {
            return { ok: false, error: 'instance_not_found' };
        }
        if (current.status === 'connected') {
            return { ok: false, error: 'instance_already_connected', status: current.status };
        }
        const requestPairingCode = current.sock.requestPairingCode;
        if (typeof requestPairingCode !== 'function') {
            return { ok: false, error: 'pairing_code_not_supported' };
        }
        try {
            pairingIssuedAt.set(name, Date.now());
            const pairingCode = await requestPairingCode(phoneNumber);
            const code = String(pairingCode ?? '').trim();
            if (code) {
                pairingIssuedAt.set(name, Date.now());
                await sleep(1200);
                const afterIssue = instances.get(name);
                if (!afterIssue || afterIssue.status === 'disconnected') {
                    return { ok: false, error: 'pairing_code_unstable', status: afterIssue?.status };
                }
                return { ok: true, pairingCode: code, status: afterIssue.status };
            }
            lastError = 'empty_pairing_code';
        }
        catch (err) {
            const message = (err instanceof Error ? err.message : String(err)).trim();
            const normalized = message.toLowerCase();
            if (normalized.includes('not linked') || normalized.includes('registered') || normalized.includes('logged in')) {
                return { ok: false, error: 'session_already_registered', status: current.status };
            }
            if (normalized.includes('connection closed') || normalized.includes('closed')) {
                lastError = 'pairing_channel_not_ready';
            }
            else {
                lastError = message || 'pairing_code_unavailable';
            }
        }
        if (attempt < 8) {
            await sleep(1000);
        }
    }
    return { ok: false, error: lastError, status: instances.get(name)?.status };
}
/**
 * Desconecta e remove a instância da memória (credenciais permanecem em disco).
 */
export function disconnectInstance(name, options) {
    const ctx = instances.get(name);
    if (!ctx)
        return false;
    // Captura o status ANTES de fechar o socket — closeSocket() pode disparar
    // connection.update síncronamente e sobrescrever lastInstanceState com 'disconnected'.
    const statusBeforeClose = ctx.status;
    // Remove do Map ANTES de fechar o socket para que o guard `instances.get(name) !== ctx`
    // no handler connection.update detecte o socket como "stale" e retorne sem sobrescrever
    // o lastInstanceState com 'disconnected'.
    instances.delete(name);
    reconnectAttempts.delete(name);
    closeSocket(ctx.sock);
    if (!options?.keepAutostart) {
        markAutostart(name, false);
        trackLastInstanceState(name, {
            status: 'disconnected',
            wasConnected: false,
            stoppedByUser: true,
        });
    }
    else {
        // keepAutostart=true é usado no shutdown gracioso — preserva o status atual
        // (connected/qr/connecting) para que o autoconnect funcione no próximo boot.
        // Usa statusBeforeClose (capturado antes do closeSocket) para não sofrer race
        // com o evento connection.update que marca 'disconnected' ao fechar o socket.
        trackLastInstanceState(name, {
            status: statusBeforeClose,
            stoppedByUser: false,
        });
    }
    pairingIssuedAt.delete(name);
    chatCache.delete(name);
    clearInstanceMediaBinaries(name, true);
    stopAlwaysOnline(name);
    stopContinuousHistorySync(name);
    return true;
}
/**
 * Logout + apaga pasta de auth e remove instância. Próxima conexão gerará novo QR.
 */
export async function logoutInstance(name, authFolder) {
    const normalizedName = String(name ?? '').trim();
    if (!isValidInstanceName(normalizedName)) {
        return { ok: false, error: 'invalid_instance_name' };
    }
    name = normalizedName;
    const ctx = instances.get(name);
    if (ctx) {
        try {
            if (typeof ctx.sock.logout === 'function') {
                await ctx.sock.logout();
            }
        }
        catch {
            // ignore
        }
        closeSocket(ctx.sock);
        instances.delete(name);
        reconnectAttempts.delete(name);
        markAutostart(name, false);
        trackLastInstanceState(name, {
            status: 'disconnected',
            wasConnected: false,
            stoppedByUser: true,
        });
        pairingIssuedAt.delete(name);
        chatCache.delete(name);
        clearInstanceMediaBinaries(name, true);
        stopAlwaysOnline(name);
        stopContinuousHistorySync(name);
    }
    const authPath = path.resolve(process.cwd(), authFolder, name);
    try {
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true });
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
    }
    // Apaga mensagens persistidas ao fazer logout (sessão encerrada definitivamente)
    try {
        msClearInstance(name);
    }
    catch { /* best-effort */ }
    return { ok: true };
}
/**
 * Remove a instância (fecha socket e remove do mapa). Não apaga credenciais.
 */
/**
 * Repara sessões Signal corrompidas de uma instância.
 * Remove arquivos de sessão de contatos específicos (ou todos) e reinicia a instância.
 * Útil quando ocorrem erros "Decryption Failed" / "Session Error" repetidos.
 */
export async function repairInstanceSessions(name, authFolder) {
    const normalizedName = String(name ?? '').trim();
    if (!isValidInstanceName(normalizedName)) {
        return { ok: false, deleted: 0, restarted: false, error: 'invalid_instance_name' };
    }
    const authPath = path.resolve(process.cwd(), authFolder, normalizedName);
    if (!fs.existsSync(authPath)) {
        return { ok: false, deleted: 0, restarted: false, error: 'auth_path_not_found' };
    }
    let deleted = 0;
    const ctx = getInstance(normalizedName);
    const readOwnPrefixes = () => {
        try {
            const credsRaw = fs.readFileSync(path.join(authPath, 'creds.json'), 'utf8');
            const creds = JSON.parse(credsRaw);
            return {
                ownLidPrefix: extractOwnLidPrefix(creds),
                ownPhonePrefix: extractOwnPhonePrefix(creds),
            };
        }
        catch {
            return { ownLidPrefix: '', ownPhonePrefix: '' };
        }
    };
    const ownFromCreds = readOwnPrefixes();
    const currentUser = (ctx?.sock?.user ?? {});
    const ownLidPrefix = String(currentUser.lid ?? '').trim().split(':')[0].split('@')[0] || ownFromCreds.ownLidPrefix;
    const ownPhonePrefix = String(currentUser.id ?? '').trim().split(':')[0].split('@')[0] || ownFromCreds.ownPhonePrefix;
    try {
        const entries = fs.readdirSync(authPath, { withFileTypes: true });
        // Remove todos os arquivos de sessão Signal de outros contatos/dispositivos:
        // session-<jid>.json, sender-key-<group>--<jid>--<idx>.json, tctoken-<lid>@lid.json
        const SESSION_RE = /^session-(?!creds).*\.json$/;
        const SENDER_KEY_RE = /^sender-key-.*\.json$/;
        const TCTOKEN_RE = /^tctoken-.*@lid\.json$/;
        const ownLidMappingReverse = ownLidPrefix ? `lid-mapping-${ownLidPrefix}_reverse.json` : '';
        const ownPhoneMapping = ownPhonePrefix ? `lid-mapping-${ownPhonePrefix}.json` : '';
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const { name: fileName } = entry;
            const isOwnMapping = fileName === ownLidMappingReverse || fileName === ownPhoneMapping;
            if (!SESSION_RE.test(fileName) && !SENDER_KEY_RE.test(fileName) && !TCTOKEN_RE.test(fileName) && !isOwnMapping)
                continue;
            try {
                fs.unlinkSync(path.join(authPath, fileName));
                deleted += 1;
            }
            catch {
                // ignora falhas individuais
            }
        }
        log.whatsapp.child(normalizedName).warn(`repair_sessions  deleted=${deleted} session/sender-key/tctoken files`);
    }
    catch (err) {
        log.whatsapp.child(normalizedName).error('repair_sessions  falha ao ler diretório de auth', err);
        return { ok: false, deleted, restarted: false, error: 'read_auth_dir_failed' };
    }
    // Reinicia a instância para recarregar auth state sem chaves antigas em memória
    let restarted = false;
    if (ctx) {
        forceAppStateResync.add(normalizedName);
        disconnectInstance(normalizedName, { keepAutostart: true });
        const recreated = await createInstance(normalizedName, authFolder);
        restarted = recreated.ok;
    }
    return { ok: true, deleted, restarted };
}
export function removeInstance(name) {
    const removed = disconnectInstance(name);
    if (removed)
        return true;
    const normalizedName = String(name ?? '').trim();
    if (!isValidInstanceName(normalizedName))
        return false;
    autostartInstances.delete(normalizedName);
    persistAutostartState();
    lastInstanceState.delete(normalizedName);
    persistLastInstanceState();
    chatCache.delete(normalizedName);
    clearInstanceMediaBinaries(normalizedName, true);
    return true;
}
/** Checks if a list is already sorted by lastTimestamp descending (avoids redundant sort). */
function isLastTimestampSortedDesc(list) {
    for (let i = 1; i < list.length; i += 1) {
        if ((list[i - 1]?.lastTimestamp ?? 0) < (list[i]?.lastTimestamp ?? 0))
            return false;
    }
    return true;
}
export function getInstanceChatList(name) {
    // Combina cache em memória com dados persistidos no SQLite
    // Chats do SQLite que não estão em memória ainda aparecem na lista
    const memChats = chatCache.get(name);
    const dbChats = (() => { try {
        return msListChats(name);
    }
    catch {
        return [];
    } })();
    // Fast path: sem chats em memória, o SQLite já entrega a lista ordenada.
    if (!memChats || memChats.size === 0) {
        return dbChats.map((c) => ({
            jid: c.jid,
            title: c.title || c.jid.split('@')[0],
            unreadCount: c.unreadCount,
            messageCount: c.messageCount,
            lastMessage: c.lastMessage,
            lastTimestamp: c.lastTimestamp,
        }));
    }
    if (dbChats.length === 0) {
        const memOnly = Array.from(memChats.values(), (chat) => ({
            jid: chat.jid,
            title: chat.title || chat.jid.split('@')[0],
            unreadCount: chat.unreadCount,
            messageCount: chat.messages.length,
            lastMessage: chat.lastMessage || '',
            lastTimestamp: chat.lastTimestamp,
        }));
        return isLastTimestampSortedDesc(memOnly)
            ? memOnly
            : memOnly.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
    }
    const result = new Map();
    // Primeiro: dados do banco
    for (const c of dbChats) {
        result.set(c.jid, {
            jid: c.jid,
            title: c.title || c.jid.split('@')[0],
            unreadCount: c.unreadCount,
            messageCount: c.messageCount,
            lastMessage: c.lastMessage,
            lastTimestamp: c.lastTimestamp,
        });
    }
    // Sobrescreve/mescla com dados mais frescos do cache em memória
    if (memChats) {
        for (const chat of memChats.values()) {
            const existing = result.get(chat.jid);
            const memMessageCount = existing?.messageCount ?? chat.messages.length;
            result.set(chat.jid, {
                jid: chat.jid,
                title: chat.title || existing?.title || chat.jid.split('@')[0],
                unreadCount: chat.unreadCount,
                messageCount: memMessageCount,
                lastMessage: chat.lastMessage || existing?.lastMessage || '',
                lastTimestamp: Math.max(chat.lastTimestamp, existing?.lastTimestamp ?? 0),
            });
        }
    }
    const merged = [...result.values()];
    return isLastTimestampSortedDesc(merged)
        ? merged
        : merged.sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}
function toPublicCachedMessage(instance, message, delivery) {
    const media = message.media
        ? {
            ...message.media,
            url: message.media.mediaId ? buildMediaUrl(instance, message.media.mediaId) : undefined,
        }
        : undefined;
    return {
        id: message.id,
        fromMe: message.fromMe,
        text: message.text,
        timestamp: message.timestamp,
        senderName: message.senderName,
        senderNumber: message.senderNumber,
        participant: message.participant,
        quotedMessageId: message.quotedMessageId,
        media,
        contact: message.contact,
        delivery: delivery ?? message.delivery,
    };
}
async function ensureCachedMessageMedia(instance, message, jid) {
    if (!message.media || message.media.base64 || message.media.omittedReason || !message.mediaSource)
        return;
    if (message.media.mediaId)
        return;
    const lockKey = `${instance}:${jid ?? ''}:${message.id}`;
    const existing = chatMediaEnsureInFlight.get(lockKey);
    if (existing) {
        await existing;
        return;
    }
    const request = (async () => {
        const downloaded = await downloadMediaBase64(message.mediaSource.node, message.mediaSource.kind, 'chat');
        if (downloaded?.base64) {
            const nextMimeType = message.media?.mimeType ?? message.mediaSource.node.mimetype;
            if (!isSafeInlineMime(message.mediaSource.kind, typeof nextMimeType === 'string' ? nextMimeType : undefined)) {
                message.media = {
                    ...message.media,
                    omittedReason: 'download_failed',
                };
                return;
            }
            message.media = {
                ...message.media,
                base64: downloaded.base64,
                bytes: downloaded.bytes,
            };
            message.media = storeMediaBinary(instance, message.media);
            if (jid && message.media.mediaId) {
                try {
                    msUpdateMessageFields(instance, jid, message.id, {
                        media: message.media,
                    });
                }
                catch {
                    // Best-effort: cache and media index already have the deduplicated binary.
                }
            }
            return;
        }
        if (downloaded?.omittedReason) {
            message.media = {
                ...message.media,
                omittedReason: downloaded.omittedReason,
            };
        }
    })();
    chatMediaEnsureInFlight.set(lockKey, request);
    try {
        await request;
    }
    finally {
        chatMediaEnsureInFlight.delete(lockKey);
    }
}
/** Returns true if list is sorted ascending by timestamp (avoids redundant re-sort). */
function isCachedMessageTimestampSorted(list) {
    for (let i = 1; i < list.length; i += 1) {
        if ((list[i - 1]?.timestamp ?? 0) > (list[i]?.timestamp ?? 0))
            return false;
    }
    return true;
}
/** Merges two ascending-sorted arrays into a single ascending-sorted array (O(n+m)). */
function mergeSortedCachedMessages(left, right) {
    if (left.length === 0)
        return right;
    if (right.length === 0)
        return left;
    const merged = [];
    let i = 0;
    let j = 0;
    while (i < left.length && j < right.length) {
        if ((left[i]?.timestamp ?? 0) <= (right[j]?.timestamp ?? 0))
            merged.push(left[i++]);
        else
            merged.push(right[j++]);
    }
    while (i < left.length)
        merged.push(left[i++]);
    while (j < right.length)
        merged.push(right[j++]);
    return merged;
}
function getInstanceChatMessagesInternal(name, jid) {
    const chats = chatCache.get(name);
    const memMessages = chats?.get(jid)?.messages ?? [];
    const mapStoredMessage = (m) => {
        // Reconstrói `mediaSource` a partir do `media._src` persistido no SQLite.
        // O `_src` carrega o node original (url/directPath/mediaKey/etc.) serializado
        // por `serializeMediaSourceNode` — necessário para re-download retroativo de
        // mídia em mensagens carregadas do disco (path histórico).
        let mediaSource;
        let mediaForPublic;
        if (m.media) {
            const rawMedia = m.media;
            const src = rawMedia._src;
            const kind = rawMedia.kind;
            if (src && typeof src === 'object' && typeof kind === 'string' && kind in MEDIA_NODE_BY_KIND) {
                mediaSource = {
                    kind: kind,
                    node: rehydrateMediaSourceNode(src),
                };
            }
            // Remove _src do objeto media exposto publicamente — ele é detalhe de
            // implementação interna, não deve sair na API/UI.
            if ('_src' in rawMedia) {
                const { _src, ...rest } = rawMedia;
                void _src;
                mediaForPublic = rest;
            }
            else {
                mediaForPublic = rawMedia;
            }
        }
        return {
            id: m.id,
            fromMe: m.fromMe,
            text: m.text,
            timestamp: m.timestamp,
            senderName: m.senderName,
            senderNumber: m.senderNumber,
            participant: m.participant,
            quotedMessageId: m.quotedMessageId,
            media: mediaForPublic,
            contact: m.contact,
            delivery: m.delivery,
            mediaSource,
        };
    };
    // Se não há mensagens em memória, carrega do SQLite
    if (memMessages.length === 0) {
        try {
            const stored = msListMessages(name, jid, config.messages.maxPerChat);
            if (stored.length > 0) {
                const mappedStored = stored.map(mapStoredMessage);
                // Carrega no cache de memória para uso futuro
                const map = ensureInstanceChatMap(name);
                const existing = map.get(jid);
                if (!existing) {
                    map.set(jid, {
                        jid,
                        title: jid.split('@')[0],
                        unreadCount: 0,
                        lastMessage: stored[stored.length - 1]?.text ?? '',
                        lastTimestamp: stored[stored.length - 1]?.timestamp ?? 0,
                        messages: mappedStored,
                    });
                }
                return mappedStored;
            }
        }
        catch {
            // best-effort
        }
        return isCachedMessageTimestampSorted(memMessages) ? memMessages : [...memMessages].sort((a, b) => a.timestamp - b.timestamp);
    }
    // Mescla memória + SQLite para garantir mensagens históricas não em memória
    try {
        const storedCount = msCountMessages(name, jid);
        if (storedCount > memMessages.length) {
            const stored = msListMessages(name, jid, config.messages.maxPerChat);
            const memIds = new Set(memMessages.map((m) => m.id));
            const extra = stored.filter((m) => !memIds.has(m.id));
            if (extra.length > 0) {
                const mappedExtra = extra.map(mapStoredMessage);
                const baseMessages = isCachedMessageTimestampSorted(memMessages)
                    ? memMessages
                    : [...memMessages].sort((a, b) => a.timestamp - b.timestamp);
                return mergeSortedCachedMessages(baseMessages, mappedExtra);
            }
        }
    }
    catch {
        // best-effort
    }
    return isCachedMessageTimestampSorted(memMessages) ? memMessages : [...memMessages].sort((a, b) => a.timestamp - b.timestamp);
}
function buildQuotedMessage(name, jid, replyToId) {
    // Only quote messages that are already present in the live in-memory chat cache.
    // Quoting older/stale SQLite-only messages tends to produce a temporary
    // "Aguardando mensagem" placeholder on the device.
    const chat = chatCache.get(name)?.get(jid);
    const target = chat
        ? (chat.messagesById?.get(replyToId) ?? chat.messages.find((item) => item.id === replyToId))
        : undefined;
    if (!target)
        return null;
    let message;
    if (target.media?.kind === 'image') {
        message = { imageMessage: { caption: target.media.caption || target.text || '' } };
    }
    else if (target.media?.kind === 'video') {
        message = { videoMessage: { caption: target.media.caption || target.text || '' } };
    }
    else if (target.media?.kind === 'document') {
        message = { documentMessage: { fileName: target.media.fileName || 'file', caption: target.media.caption || target.text || '' } };
    }
    else if (target.media?.kind === 'audio') {
        message = { audioMessage: {} };
    }
    else if (target.contact?.displayName || target.contact?.number) {
        message = { contactMessage: { displayName: target.contact.displayName || target.contact.number || '' } };
    }
    else {
        message = { conversation: target.text || ' ' };
    }
    return {
        key: {
            remoteJid: jid,
            fromMe: target.fromMe,
            id: target.id,
            participant: target.participant,
        },
        message,
    };
}
function normalizeSignDelimiter(value) {
    if (!value)
        return '\n';
    return value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
}
function formatChatwootOutboundLabel(text, delimiter, agentName) {
    if (!agentName)
        return text;
    const label = `*${agentName}:*`;
    const body = String(text ?? '');
    return body ? `${label}${delimiter}${body}` : label;
}
function shouldSendAsVoiceNote(mimeType, fileName) {
    const mime = String(mimeType ?? '').trim().toLowerCase();
    const file = String(fileName ?? '').trim().toLowerCase();
    return mime.includes('codecs=opus') || mime === 'audio/ogg' || file.endsWith('.ogg') || file.endsWith('.opus');
}
export function getInstanceChatMessages(name, jid) {
    const items = getInstanceChatMessagesInternal(name, jid);
    const deliveries = msGetDeliveryStates(name, items.map((item) => item.id));
    return items.map((item) => toPublicCachedMessage(name, item, deliveries.get(item.id)));
}
export async function getInstanceChatMessagesWithMedia(name, jid, onlyIds) {
    purgeExpiredMediaBinaries();
    const source = getInstanceChatMessagesInternal(name, jid);
    const list = onlyIds?.size
        ? source.filter((message) => onlyIds.has(message.id))
        : source;
    const concurrency = Math.min(4, Math.max(1, list.length));
    let cursor = 0;
    const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < list.length) {
            const index = cursor++;
            const message = list[index];
            if (message)
                await ensureCachedMessageMedia(name, message, jid);
        }
    });
    await Promise.all(workers);
    const deliveries = msGetDeliveryStates(name, list.map((item) => item.id));
    return list.map((item) => toPublicCachedMessage(name, item, deliveries.get(item.id)));
}
export function getInstanceChatMediaBinary(name, mediaId) {
    purgeExpiredMediaBinaries();
    const item = chatMediaBinaryStore.get(mediaId);
    if (!item || item.instance !== name) {
        return { ok: false, error: 'not_found' };
    }
    const absolutePath = path.join(mediaStoragePath, item.relativePath);
    let bytes;
    try {
        if (!fs.existsSync(absolutePath)) {
            if (item.storageKey)
                chatMediaStorageKeyIndex.delete(item.storageKey);
            chatMediaBinaryStore.delete(mediaId);
            persistMediaIndex();
            return { ok: false, error: 'not_found' };
        }
        bytes = fs.readFileSync(absolutePath);
    }
    catch {
        return { ok: false, error: 'not_found' };
    }
    return {
        ok: true,
        mimeType: item.mimeType,
        bytes,
    };
}
export async function syncInstanceChatHistory(name, jid, options) {
    const ctx = instances.get(name);
    if (!ctx) {
        return { ok: false, imported: 0, batches: 0, done: false, error: 'instance_not_found' };
    }
    if (ctx.status !== 'connected') {
        return { ok: false, imported: 0, batches: 0, done: false, error: 'instance_not_connected' };
    }
    const settings = getInstanceGeneral(name);
    if (settings.ignoreGroups && jid.endsWith('@g.us')) {
        return { ok: false, imported: 0, batches: 0, done: false, error: 'groups_ignored_by_settings' };
    }
    const anySock = ctx.sock;
    if (typeof anySock.fetchMessageHistory !== 'function') {
        return { ok: false, imported: 0, batches: 0, done: false, error: 'history_fetch_not_supported' };
    }
    const maxBatches = Math.max(1, Math.min(Number(options?.maxBatches ?? 15), 50));
    const fetchCount = Math.max(10, Math.min(Number(options?.fetchCount ?? CONTINUOUS_HISTORY_FETCH_COUNT), 500));
    let imported = 0;
    let batches = 0;
    let done = false;
    for (let i = 0; i < maxBatches; i++) {
        const current = getInstanceChatMessages(name, jid);
        const oldest = current.length > 0 ? current[0] : undefined;
        // fetchMessageHistory requires a valid key object — use a sentinel when no messages exist
        const oldestKey = {
            remoteJid: jid,
            id: oldest?.id ?? '3EB0',
            fromMe: oldest?.fromMe ?? false,
        };
        const oldestTimestamp = oldest ? normalizeTimestamp(oldest.timestamp) : undefined;
        let response;
        try {
            response = await anySock.fetchMessageHistory(fetchCount, oldestKey, oldestTimestamp);
        }
        catch (err) {
            // First batch with sentinel key may fail if WAM is not ready — treat as empty, not error
            if (batches === 0 && imported === 0) {
                return { ok: true, imported: 0, batches: 0, done: true };
            }
            return { ok: false, imported, batches, done: false, error: 'history_fetch_failed' };
        }
        const raw = extractMessagesFromHistoryResponse(response).filter((msg) => {
            const key = (msg.key ?? {});
            return String(key.remoteJid ?? '').trim() === jid;
        });
        if (raw.length === 0) {
            done = true;
            break;
        }
        const result = await ingestHistoryMessagesChunked(name, raw);
        imported += result.inserted;
        batches += 1;
        if (result.inserted === 0) {
            done = true;
            break;
        }
    }
    return { ok: true, imported, batches, done };
}
export function markInstanceChatAsRead(name, jid) {
    const chats = chatCache.get(name);
    if (!chats)
        return;
    const chat = chats.get(jid);
    if (!chat)
        return;
    chat.unreadCount = 0;
    chats.set(jid, chat);
    try {
        msResetUnread(name, jid);
    }
    catch { /* best-effort */ }
}
export async function applyReadSettingsToCachedMessages(name) {
    const ctx = instances.get(name);
    if (!ctx || typeof ctx.sock.readMessages !== 'function') {
        return { ok: false, count: 0 };
    }
    const settings = getInstanceGeneral(name);
    if (!settings.autoReadMessages && !settings.readStatus) {
        return { ok: true, count: 0 };
    }
    const chats = chatCache.get(name);
    if (!chats) {
        return { ok: true, count: 0 };
    }
    const keys = new Map();
    for (const [jid, chat] of chats.entries()) {
        if (settings.ignoreGroups && jid.endsWith('@g.us'))
            continue;
        const readNormalChat = settings.autoReadMessages && jid !== 'status@broadcast';
        const readStatusChat = settings.readStatus && jid === 'status@broadcast';
        if (!readNormalChat && !readStatusChat)
            continue;
        for (const message of chat.messages) {
            if (message.fromMe)
                continue;
            keys.set(`${jid}:${message.id}`, {
                remoteJid: jid,
                id: message.id,
                fromMe: false,
            });
        }
        chat.unreadCount = 0;
        chats.set(jid, chat);
    }
    if (!keys.size) {
        return { ok: true, count: 0 };
    }
    // PRIO-3 (humanize): quando operador troca autoReadMessages de off→on, o
    // método antigo enfileirava TODAS as mensagens não-fromMe de TODOS os chats
    // em UM ÚNICO readMessages — um stanza com milhares de receipts.
    // Aqui quebramos em chunks com sleep aleatório entre eles. O custo extra é
    // latência total maior, mas o operador toggle não é tempo-real.
    const humanize = getHumanizeSettings(name);
    const allKeys = [...keys.values()];
    if (!humanize.enabled) {
        try {
            await ctx.sock.readMessages(allKeys);
            return { ok: true, count: allKeys.length };
        }
        catch {
            return { ok: false, count: allKeys.length };
        }
    }
    const chunkSize = Math.max(1, humanize.autoReadChunkSize);
    let okCount = 0;
    let failed = false;
    for (let i = 0; i < allKeys.length; i += chunkSize) {
        const chunk = allKeys.slice(i, i + chunkSize);
        try {
            await ctx.sock.readMessages(chunk);
            okCount += chunk.length;
        }
        catch {
            failed = true;
        }
        if (i + chunkSize < allKeys.length) {
            await humanSleep(humanRandomIntBetween(humanize.autoReadChunkSleepMinMs, humanize.autoReadChunkSleepMaxMs));
        }
    }
    return { ok: !failed, count: okCount };
}
/**
 * Send a plain-text message via an active WhatsApp instance.
 * Used by the Chatwoot webhook handler to reply from Chatwoot to WhatsApp.
 */
// Regex permissivo para JIDs válidos do WhatsApp:
// - Individual: dígitos@s.whatsapp.net
// - Grupo: dígitos-dígitos@g.us
// - LID: dígitos@lid
// - Newsletter: dígitos@newsletter
const VALID_JID_RE = /^[\d-]+@(s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)$/;
/**
 * Valida formato básico de JID para evitar injeção de JID arbitrário.
 */
function isValidJid(jid) {
    return VALID_JID_RE.test(jid);
}
/**
 * Executa um "humanized presence wrap" antes do envio: pequenas pausas
 * randomizadas (preSendDelayMs) e um loop de `composing` com heartbeats
 * para simular digitação. Após o callback, manda `paused`. Tudo best-effort
 * — falhas individuais não interrompem o envio principal.
 *
 * `typingMs` aqui já é um valor final calculado pelo caller (geralmente via
 * `computeTypingMs(instance, text)` quando humanize está habilitado).
 */
async function withHumanizedPresence(sock, jid, opts, send) {
    const preDelay = Math.max(0, opts.preSendDelayMs ?? 0);
    if (preDelay > 0) {
        await humanSleep(preDelay);
    }
    const typingMs = Math.max(0, opts.typingMs ?? 0);
    if (typingMs > 0 && typeof sock.sendPresenceUpdate === 'function') {
        const HEARTBEAT_BASE_MS = 7000;
        try {
            await sock.presenceSubscribe?.(jid);
        }
        catch { /* ignore */ }
        let remaining = typingMs;
        try {
            while (remaining > 0) {
                try {
                    await sock.sendPresenceUpdate('composing', jid);
                }
                catch { /* ignore */ }
                const heartbeat = HEARTBEAT_BASE_MS + Math.floor(Math.random() * 2000);
                const chunk = Math.min(remaining, heartbeat);
                await humanSleep(chunk);
                remaining -= chunk;
            }
        }
        catch { /* ignore */ }
    }
    try {
        return await send();
    }
    finally {
        if (typingMs > 0 && typeof sock.sendPresenceUpdate === 'function') {
            try {
                await sock.sendPresenceUpdate('paused', jid);
            }
            catch { /* ignore */ }
        }
    }
}
export async function sendInstanceTextMessage(name, jid, text, options) {
    if (!isValidJid(jid))
        return { ok: false, error: 'invalid_jid' };
    const ctx = instances.get(name);
    if (!ctx || !ctx.sock)
        return { ok: false, error: 'instance_not_found' };
    if (typeof ctx.sock.sendMessage !== 'function')
        return { ok: false, error: 'send_not_available' };
    try {
        const delimiter = normalizeSignDelimiter(options?.signDelimiter);
        const finalText = formatChatwootOutboundLabel(text, delimiter, options?.agentName);
        const quoted = options?.replyToId ? buildQuotedMessage(name, jid, options.replyToId) : undefined;
        const sent = await withHumanizedPresence(ctx.sock, jid, { typingMs: options?.typingMs, preSendDelayMs: options?.preSendDelayMs }, () => ctx.sock.sendMessage(jid, { text: finalText }, quoted ? { quoted } : undefined));
        const msgId = sent?.key?.id;
        // Se o Baileys não retornou um msgId, o envio não foi confirmado — retorna erro.
        if (!msgId) {
            return { ok: false, error: 'send_no_ack' };
        }
        markChatwootOriginated(msgId);
        // Persistently mark Chatwoot-originated outbound messages so history sync
        // never sends them back into Chatwoot after TTL expiry or process restart.
        markMessageSynced(name, msgId, 0);
        updateCachedMessage(name, {
            jid,
            id: msgId,
            fromMe: true,
            text: finalText,
            timestamp: Date.now(),
            quotedMessageId: options?.replyToId,
        });
        return { ok: true, id: msgId };
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
/**
 * Baixa o conteúdo de uma URL (ou decodifica um data:URL) e devolve um Buffer
 * + mimeType detectado quando possível. Necessário para mensagens vindas do
 * Chatwoot, em que enviar `{ url }` direto pro Baileys frequentemente falha:
 * algumas instalações servem attachments com cookies/headers que o Baileys não
 * replica, e o WhatsApp acaba recebendo um arquivo vazio/corrompido.
 *
 * Limite de tamanho: 32MB (cobre vídeos longos típicos).
 */
async function fetchMediaToBuffer(mediaUrl) {
    const MAX_BYTES = 32 * 1024 * 1024;
    if (!mediaUrl)
        return { error: 'empty_media_url' };
    // data:URL — decodifica direto, sem rede.
    if (mediaUrl.startsWith('data:')) {
        const match = /^data:([^;]+);base64,(.+)$/.exec(mediaUrl);
        if (!match)
            return { error: 'invalid_data_url' };
        const mimeType = match[1] || undefined;
        let buffer;
        try {
            buffer = Buffer.from(match[2], 'base64');
        }
        catch {
            return { error: 'invalid_data_url_payload' };
        }
        if (buffer.length === 0)
            return { error: 'empty_data_url' };
        if (buffer.length > MAX_BYTES)
            return { error: 'media_too_large' };
        return { buffer, mimeType };
    }
    // HTTP(S) — usa fetch nativo (Node 20+). Sem auth: o Chatwoot expõe data_url
    // por endpoint público assinado por padrão (ActiveStorage / S3 / etc.).
    // O AbortController cobre tanto o handshake/headers quanto o download do body.
    // Validação de segurança: bloqueia SSRF para redes privadas/internas.
    // Permite private network apenas se ALLOW_PRIVATE_NETWORK_INTEGRATIONS=true
    // (mesmo flag usado para integrações como n8n).
    const urlValidation = validateOutboundUrl(mediaUrl, {
        allowPrivateNetwork: config.security.allowPrivateNetworkIntegrations,
    });
    if (!urlValidation.ok) {
        return { error: `media_url_blocked: ${urlValidation.error}` };
    }
    const safeMediaUrl = urlValidation.normalizedUrl ?? mediaUrl;
    let response;
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), 60_000);
    try {
        response = await fetch(safeMediaUrl, { signal: controller.signal });
        if (!response.ok) {
            await response.body?.cancel().catch(() => { });
            clearTimeout(fetchTimeout);
            return { error: `media_fetch_status_${response.status}` };
        }
        const mimeType = response.headers.get('content-type')?.split(';')[0].trim() || undefined;
        const arrayBuf = await response.arrayBuffer(); // timeout ainda ativo aqui
        clearTimeout(fetchTimeout);
        if (arrayBuf.byteLength === 0)
            return { error: 'empty_media_response' };
        if (arrayBuf.byteLength > MAX_BYTES)
            return { error: 'media_too_large' };
        return { buffer: Buffer.from(arrayBuf), mimeType };
    }
    catch (err) {
        clearTimeout(fetchTimeout);
        return { error: `media_fetch_failed: ${String(err)}` };
    }
}
/**
 * Send a URL-based media message via an active WhatsApp instance.
 * Used when Chatwoot sends an attachment back to WhatsApp.
 *
 * Baixa o arquivo em memória antes de mandar para o Baileys — evita erros
 * de download silencioso quando a URL exige headers/cookies.
 */
export async function sendInstanceMediaMessage(name, jid, params) {
    if (!isValidJid(jid))
        return { ok: false, error: 'invalid_jid' };
    const ctx = instances.get(name);
    if (!ctx || !ctx.sock)
        return { ok: false, error: 'instance_not_found' };
    if (typeof ctx.sock.sendMessage !== 'function')
        return { ok: false, error: 'send_not_available' };
    try {
        // 1) Baixa a mídia em memória — buffer é mais confiável que `{ url }`.
        const fetched = await fetchMediaToBuffer(params.mediaUrl);
        if ('error' in fetched) {
            return { ok: false, error: fetched.error };
        }
        // 2) Resolve mimeType final (prioriza o que veio no payload do Chatwoot).
        let mime = (params.mimeType?.trim() || fetched.mimeType || 'application/octet-stream').toLowerCase();
        const delimiter = normalizeSignDelimiter(params.signDelimiter);
        const rawCaption = params.caption ?? '';
        const signedCaption = formatChatwootOutboundLabel(rawCaption, delimiter, params.agentName).trim();
        // Caller pode forçar PTT explicitamente (ex.: gravação de voz vinda do
        // Chatwoot ou body.ptt:true no endpoint REST). Caso contrário, cai na
        // heurística por mimetype/extensão.
        const sendAsVoiceNote = params.ptt === true || shouldSendAsVoiceNote(mime, params.fileName);
        // Quando PTT for explícito, normaliza o mime para o container que o
        // WhatsApp reconhece como nota de voz. Sem isso, o Baileys empacota
        // como anexo mesmo com ptt:true.
        if (params.ptt === true && mime.startsWith('audio/')) {
            mime = 'audio/ogg; codecs=opus';
        }
        let content;
        let needsAudioCaptionFallback = false;
        if (mime === 'image/webp') {
            content = { sticker: fetched.buffer };
        }
        else if (mime.startsWith('image/')) {
            content = { image: fetched.buffer, mimetype: mime, caption: signedCaption };
        }
        else if (mime.startsWith('video/')) {
            content = { video: fetched.buffer, mimetype: mime, caption: signedCaption };
        }
        else if (mime.startsWith('audio/')) {
            // Nota de voz no WhatsApp requer OGG/Opus. Outros formatos precisam ir
            // como audio comum para não ficarem travados no app móvel.
            needsAudioCaptionFallback = Boolean(signedCaption);
            content = { audio: fetched.buffer, mimetype: mime, ptt: sendAsVoiceNote };
        }
        else {
            content = {
                document: fetched.buffer,
                mimetype: mime,
                fileName: params.fileName ?? 'file',
                caption: signedCaption,
            };
        }
        if (needsAudioCaptionFallback) {
            const textResult = await sendInstanceTextMessage(name, jid, rawCaption, {
                replyToId: params.replyToId,
                agentName: params.agentName,
                signDelimiter: params.signDelimiter,
            });
            if (!textResult.ok) {
                log.whatsapp.child(name).warn(`audio caption fallback falhou antes da mídia para jid=${jid}: ${textResult.error || 'failed_to_send_text'}`);
            }
        }
        const quoted = params.replyToId ? buildQuotedMessage(name, jid, params.replyToId) : undefined;
        const sent = await withHumanizedPresence(ctx.sock, jid, { typingMs: params.typingMs, preSendDelayMs: params.preSendDelayMs }, () => ctx.sock.sendMessage(jid, content, quoted ? { quoted } : undefined));
        const msgId = sent?.key?.id;
        // Se o Baileys não retornou um msgId, o envio não foi confirmado — retorna erro.
        if (!msgId) {
            return { ok: false, error: 'send_no_ack' };
        }
        markChatwootOriginated(msgId);
        // Persistently mark Chatwoot-originated outbound messages so history sync
        // never sends them back into Chatwoot after TTL expiry or process restart.
        markMessageSynced(name, msgId, 0);
        const mediaKind = mime === 'image/webp'
            ? 'sticker'
            : mime.startsWith('image/')
                ? 'image'
                : mime.startsWith('video/')
                    ? 'video'
                    : mime.startsWith('audio/')
                        ? 'audio'
                        : 'document';
        const persistedText = mediaKind === 'audio'
            ? '[audio]'
            : (signedCaption || `[${mediaKind}]`);
        // Persiste base64 da mídia enviada diretamente — evita a necessidade de
        // re-download via downloadContentFromMessage (que exige mediaKey/url do WA).
        // Para note-to-self e casos onde o WA não consegue reencriptar, o base64
        // inline garante que o Chatwoot receba a mídia corretamente.
        const sentBase64 = fetched.buffer.length <= config.chatwoot.mediaMaxBytes
            ? fetched.buffer.toString('base64')
            : undefined;
        updateCachedMessage(name, {
            jid,
            id: msgId,
            fromMe: true,
            text: persistedText,
            timestamp: Date.now(),
            quotedMessageId: params.replyToId,
            media: {
                kind: mediaKind,
                mimeType: mime,
                fileName: params.fileName,
                caption: signedCaption || undefined,
                bytes: fetched.buffer.length,
                base64: sentBase64,
            },
        });
        return { ok: true, id: msgId };
    }
    catch (err) {
        return { ok: false, error: String(err) };
    }
}
