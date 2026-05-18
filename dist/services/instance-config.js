import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { validateOutboundUrl } from '../utils/url-security.js';
export const INSTANCE_EVENT_NAMES = [
    'APPLICATION_STARTUP',
    'CALL',
    'CHATS_DELETE',
    'CHATS_SET',
    'CHATS_UPDATE',
    'CHATS_UPSERT',
    'CONNECTION_UPDATE',
    'CONTACTS_SET',
    'CONTACTS_UPDATE',
    'CONTACTS_UPSERT',
    'GROUP_PARTICIPANTS_UPDATE',
    'GROUP_UPDATE',
    'GROUPS_UPSERT',
    'LABELS_ASSOCIATION',
    'LABELS_EDIT',
    'LOGOUT_INSTANCE',
    'MESSAGES_DELETE',
    'MESSAGES_SET',
    'MESSAGES_UPDATE',
    'MESSAGES_UPSERT',
    'PRESENCE_UPDATE',
    'QRCODE_UPDATED',
    'REMOVE_INSTANCE',
    'SEND_MESSAGE',
    'TYPEBOT_CHANGE_STATUS',
    'TYPEBOT_START',
];
function defaultProxy() {
    return { enabled: false, protocol: 'http', host: '', port: '', username: '', password: '' };
}
function defaultGeneral() {
    return {
        rejectCalls: false,
        ignoreGroups: false,
        alwaysOnline: false,
        autoReadMessages: false,
        syncFullHistory: false,
        readStatus: false,
        importContacts: false,
    };
}
function defaultEvents() {
    const toggles = Object.fromEntries(INSTANCE_EVENT_NAMES.map((name) => [name, false]));
    return { webhookUrl: '', toggles };
}
// ---------------------------------------------------------------------------
// In-memory cache for panel config reads (TTL 5s).
// getInstancePanelConfig is called on every socket event handler (messages,
// chats, contacts) — caching eliminates the SQLite SELECT hot-path.
// ---------------------------------------------------------------------------
const _configCache = new Map();
const CONFIG_CACHE_TTL_MS = 5_000;
function invalidatePanelConfigCache(instance) {
    _configCache.delete(instance);
}
// ---------------------------------------------------------------------------
// Lazy-init DB
// ---------------------------------------------------------------------------
let _db = null;
function getDb() {
    if (_db)
        return _db;
    const resolved = path.resolve(process.cwd(), config.integrations.dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const db = new DatabaseSync(resolved);
    db.exec('PRAGMA busy_timeout = 5000;');
    try {
        db.exec('PRAGMA journal_mode = WAL;');
    }
    catch { /* can be locked */ }
    db.exec(`
      CREATE TABLE IF NOT EXISTS instance_panel_configs (
        instance TEXT PRIMARY KEY,
        proxy_json TEXT NOT NULL,
        general_json TEXT NOT NULL,
        events_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    _db = db;
    return _db;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parseObject(raw, fallback) {
    if (typeof raw !== 'string')
        return fallback;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object')
            return fallback;
        // Strict merge: só aceita campos presentes no fallback
        const result = { ...fallback };
        for (const key of Object.keys(fallback)) {
            if (key in parsed)
                result[key] = parsed[key];
        }
        return result;
    }
    catch {
        return fallback;
    }
}
function parseEvents(raw) {
    const base = defaultEvents();
    if (typeof raw !== 'string')
        return base;
    try {
        const parsed = JSON.parse(raw);
        const toggles = { ...base.toggles };
        const source = parsed?.toggles && typeof parsed.toggles === 'object' ? parsed.toggles : {};
        for (const eventName of INSTANCE_EVENT_NAMES) {
            toggles[eventName] = Boolean(source[eventName]);
        }
        return {
            webhookUrl: String(parsed?.webhookUrl ?? '').trim(),
            toggles,
        };
    }
    catch {
        return base;
    }
}
function mapRow(row) {
    return {
        instance: String(row.instance),
        proxy: parseObject(row.proxy_json, defaultProxy()),
        general: parseObject(row.general_json, defaultGeneral()),
        events: parseEvents(row.events_json),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}
function persist(cfg) {
    const db = getDb();
    const now = Date.now();
    const existing = db.prepare('SELECT created_at FROM instance_panel_configs WHERE instance = ?').get(cfg.instance);
    const createdAt = existing ? Number(existing.created_at) : now;
    db.prepare(`INSERT INTO instance_panel_configs (instance, proxy_json, general_json, events_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(instance) DO UPDATE SET
       proxy_json = excluded.proxy_json,
       general_json = excluded.general_json,
       events_json = excluded.events_json,
       updated_at = excluded.updated_at`).run(cfg.instance, JSON.stringify(cfg.proxy), JSON.stringify(cfg.general), JSON.stringify(cfg.events), createdAt, now);
    const updated = { ...cfg, createdAt, updatedAt: now };
    // Invalidate the read cache so the next getInstancePanelConfig reflects the write.
    invalidatePanelConfigCache(cfg.instance);
    return updated;
}
// ---------------------------------------------------------------------------
// Exports públicos
// ---------------------------------------------------------------------------
export function getInstancePanelConfig(instance) {
    const key = String(instance ?? '').trim();
    const now = Date.now();
    const cached = _configCache.get(key);
    if (cached && cached.exp > now)
        return cached.value;
    const db = getDb();
    const row = db.prepare('SELECT * FROM instance_panel_configs WHERE instance = ?').get(key);
    const value = row
        ? mapRow(row)
        : { instance: key, proxy: defaultProxy(), general: defaultGeneral(), events: defaultEvents(), createdAt: now, updatedAt: now };
    _configCache.set(key, { value, exp: now + CONFIG_CACHE_TTL_MS });
    return value;
}
const ALLOWED_PROXY_PROTOCOLS = new Set(['http', 'https', 'socks4', 'socks5']);
export function updateInstanceProxy(instance, patch) {
    const current = getInstancePanelConfig(instance);
    const protocol = String(patch.protocol ?? current.proxy.protocol).trim().toLowerCase() || 'http';
    if (!ALLOWED_PROXY_PROTOCOLS.has(protocol)) {
        throw new Error(`Invalid proxy protocol: ${protocol}. Allowed: ${[...ALLOWED_PROXY_PROTOCOLS].join(', ')}`);
    }
    return persist({
        ...current,
        proxy: {
            enabled: patch.enabled ?? current.proxy.enabled,
            protocol,
            host: String(patch.host ?? current.proxy.host).trim(),
            port: String(patch.port ?? current.proxy.port).trim(),
            username: String(patch.username ?? current.proxy.username).trim(),
            password: String(patch.password ?? current.proxy.password).trim(),
        },
    });
}
export function updateInstanceGeneral(instance, patch) {
    const current = getInstancePanelConfig(instance);
    return persist({
        ...current,
        general: {
            rejectCalls: patch.rejectCalls ?? current.general.rejectCalls,
            ignoreGroups: patch.ignoreGroups ?? current.general.ignoreGroups,
            alwaysOnline: patch.alwaysOnline ?? current.general.alwaysOnline,
            autoReadMessages: patch.autoReadMessages ?? current.general.autoReadMessages,
            syncFullHistory: patch.syncFullHistory ?? current.general.syncFullHistory,
            readStatus: patch.readStatus ?? current.general.readStatus,
            importContacts: patch.importContacts ?? current.general.importContacts,
        },
    });
}
export function updateInstanceEvents(instance, patch) {
    const current = getInstancePanelConfig(instance);
    const nextToggles = { ...current.events.toggles };
    if (patch.toggles) {
        for (const eventName of INSTANCE_EVENT_NAMES) {
            if (typeof patch.toggles[eventName] === 'boolean') {
                nextToggles[eventName] = Boolean(patch.toggles[eventName]);
            }
        }
    }
    return persist({
        ...current,
        events: {
            webhookUrl: patch.webhookUrl !== undefined ? String(patch.webhookUrl).trim() : current.events.webhookUrl,
            toggles: nextToggles,
        },
    });
}
export function getInstanceGeneral(instance) {
    return getInstancePanelConfig(instance).general;
}
export async function emitInstanceEvent(instance, eventName, payload, options) {
    const cfg = getInstancePanelConfig(instance);
    if (!cfg.events.webhookUrl) {
        return { ok: false, skipped: true, error: 'webhook_url_not_configured' };
    }
    if (!options?.ignoreToggle && !cfg.events.toggles[eventName]) {
        return { ok: false, skipped: true, error: 'event_toggle_disabled' };
    }
    const urlValidation = validateOutboundUrl(cfg.events.webhookUrl, {
        allowPrivateNetwork: config.security.allowPrivateNetworkWebhooks,
    });
    if (!urlValidation.ok) {
        return { ok: false, skipped: false, error: 'webhook_url_blocked' };
    }
    const targetUrl = urlValidation.normalizedUrl ?? cfg.events.webhookUrl;
    const body = JSON.stringify({ event: eventName, instance, emittedAt: new Date().toISOString(), payload });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.integrations.requestTimeoutMs);
    try {
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: controller.signal,
        });
        if (!response.ok) {
            return { ok: false, skipped: false, status: response.status, error: `webhook_http_${response.status}` };
        }
        return { ok: true, skipped: false, status: response.status };
    }
    catch (error) {
        return { ok: false, skipped: false, error: error instanceof Error ? error.message : String(error) };
    }
    finally {
        clearTimeout(timeout);
    }
}
