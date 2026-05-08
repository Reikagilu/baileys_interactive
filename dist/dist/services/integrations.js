import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { validateOutboundUrl } from '../utils/url-security.js';
function defaultChatwoot() {
    return {
        enabled: false,
        baseUrl: '',
        accountId: '',
        inboxId: '',
        apiAccessToken: '',
        nameInbox: 'WhatsApp',
        signMessages: false,
        signDelimiter: '\\n',
        organization: '',
        logoUrl: '',
        conversationPending: false,
        reopenConversation: true,
        importContacts: false,
        importMessages: true,
        daysLimitImportMessages: 7,
        ignoreJids: [],
        autoCreate: false,
    };
}
function defaultN8n() {
    return {
        enabled: false,
        webhookUrl: '',
        authHeaderName: 'x-api-key',
        authHeaderValue: '',
    };
}
function normalizeBaseUrl(input) {
    const trimmed = String(input || '').trim();
    return trimmed.replace(/\/$/, '');
}
function openDatabase(dbPath) {
    const resolved = path.resolve(process.cwd(), dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const database = new DatabaseSync(resolved);
    database.exec('PRAGMA busy_timeout = 5000;');
    try {
        database.exec('PRAGMA journal_mode = WAL;');
    }
    catch {
        // optional in some environments
    }
    return database;
}
const db = openDatabase(config.integrations.dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS integration_configs (
    instance TEXT PRIMARY KEY,
    chatwoot_json TEXT NOT NULL,
    n8n_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
function parseJson(value, fallback) {
    if (typeof value !== 'string')
        return fallback;
    try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object')
            return fallback;
        return { ...fallback, ...parsed };
    }
    catch {
        return fallback;
    }
}
function toRow(row) {
    return {
        instance: String(row.instance),
        chatwoot: parseJson(row.chatwoot_json, defaultChatwoot()),
        n8n: parseJson(row.n8n_json, defaultN8n()),
        createdAt: Number(row.created_at ?? Date.now()),
        updatedAt: Number(row.updated_at ?? Date.now()),
    };
}
export function getInstanceIntegrations(instance) {
    const normalized = String(instance || '').trim();
    const row = db.prepare('SELECT * FROM integration_configs WHERE instance = ?').get(normalized);
    if (!row) {
        const now = Date.now();
        return {
            instance: normalized,
            chatwoot: defaultChatwoot(),
            n8n: defaultN8n(),
            createdAt: now,
            updatedAt: now,
        };
    }
    return toRow(row);
}
export function listIntegrationInstances() {
    const rows = db.prepare('SELECT * FROM integration_configs ORDER BY updated_at DESC').all();
    return rows.map(toRow);
}
function saveInstanceIntegrations(next) {
    const now = Date.now();
    const existing = db.prepare('SELECT instance, created_at FROM integration_configs WHERE instance = ?').get(next.instance);
    const createdAt = existing ? Number(existing.created_at) : now;
    db.prepare(`INSERT INTO integration_configs (instance, chatwoot_json, n8n_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(instance) DO UPDATE SET
       chatwoot_json = excluded.chatwoot_json,
       n8n_json = excluded.n8n_json,
       updated_at = excluded.updated_at`).run(next.instance, JSON.stringify(next.chatwoot), JSON.stringify(next.n8n), createdAt, now);
    return {
        ...next,
        createdAt,
        updatedAt: now,
    };
}
export function updateChatwootConfig(instance, patch) {
    const current = getInstanceIntegrations(instance);
    const next = {
        ...current,
        chatwoot: {
            ...current.chatwoot,
            ...patch,
            baseUrl: normalizeBaseUrl(patch.baseUrl ?? current.chatwoot.baseUrl),
        },
    };
    return saveInstanceIntegrations(next);
}
export function updateN8nConfig(instance, patch) {
    const current = getInstanceIntegrations(instance);
    const next = {
        ...current,
        n8n: {
            ...current.n8n,
            ...patch,
        },
    };
    return saveInstanceIntegrations(next);
}
async function fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function testChatwoot(instance) {
    const cfg = getInstanceIntegrations(instance).chatwoot;
    if (!cfg.baseUrl || !cfg.apiAccessToken) {
        return { ok: false, error: 'chatwoot_not_configured' };
    }
    const urlValidation = validateOutboundUrl(cfg.baseUrl, {
        allowPrivateNetwork: config.security.allowPrivateNetworkIntegrations,
    });
    if (!urlValidation.ok) {
        return { ok: false, error: 'chatwoot_url_blocked' };
    }
    const baseUrl = (urlValidation.normalizedUrl ?? cfg.baseUrl).replace(/\/$/, '');
    try {
        const res = await fetchWithTimeout(`${baseUrl}/api/v1/profile`, {
            method: 'GET',
            headers: {
                api_access_token: cfg.apiAccessToken,
                'content-type': 'application/json',
            },
        }, config.integrations.requestTimeoutMs);
        return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            error: res.status >= 200 && res.status < 300 ? undefined : `chatwoot_http_${res.status}`,
        };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
export async function testN8n(instance) {
    const cfg = getInstanceIntegrations(instance).n8n;
    if (!cfg.webhookUrl) {
        return { ok: false, error: 'n8n_not_configured' };
    }
    const urlValidation = validateOutboundUrl(cfg.webhookUrl, {
        allowPrivateNetwork: config.security.allowPrivateNetworkIntegrations,
    });
    if (!urlValidation.ok) {
        return { ok: false, error: 'n8n_url_blocked' };
    }
    const webhookUrl = urlValidation.normalizedUrl ?? cfg.webhookUrl;
    const headers = {
        'content-type': 'application/json',
    };
    if (cfg.authHeaderName && cfg.authHeaderValue) {
        headers[cfg.authHeaderName] = cfg.authHeaderValue;
    }
    try {
        const res = await fetchWithTimeout(webhookUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                source: 'Beyound',
                event: 'integration.test',
                instance,
                emittedAt: new Date().toISOString(),
            }),
        }, config.integrations.requestTimeoutMs);
        return {
            ok: res.status >= 200 && res.status < 300,
            status: res.status,
            error: res.status >= 200 && res.status < 300 ? undefined : `n8n_http_${res.status}`,
        };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
//# sourceMappingURL=integrations.js.map