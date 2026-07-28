import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { validateOutboundUrl } from '../utils/url-security.js';
import { updateInstanceGeneral } from './instance-config.js';
import { log } from '../utils/logger.js';
import { discardResponseBody } from '../utils/http-response.js';
function defaultChatwoot() {
    return {
        enabled: false,
        baseUrl: '',
        accountId: '',
        inboxId: '',
        apiAccessToken: '',
        nameInbox: 'WhatsApp',
        webhookSlug: '',
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
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return fallback;
        // Merge field-by-field: keep fallback value when parsed field is null/undefined
        // to avoid silently overwriting arrays (e.g. ignoreJids) with null from stored JSON.
        const result = { ...fallback };
        for (const [k, v] of Object.entries(parsed)) {
            if (v !== null && v !== undefined)
                result[k] = v;
        }
        return result;
    }
    catch {
        return fallback;
    }
}
/**
 * Converte uma row do DB em InstanceIntegrations.
 * @param redactSecrets Quando true (padrão: false), mascara apiAccessToken e
 *   authHeaderValue para evitar vazamento em listagens/reads pela API pública.
 *   Use false apenas internamente (quando o token é necessário para chamar Chatwoot/n8n).
 */
function toRow(row, redactSecrets = false) {
    const chatwoot = parseJson(row.chatwoot_json, defaultChatwoot());
    const n8n = parseJson(row.n8n_json, defaultN8n());
    if (redactSecrets) {
        chatwoot.apiAccessToken = chatwoot.apiAccessToken ? '***' : '';
        n8n.authHeaderValue = n8n.authHeaderValue ? '***' : '';
    }
    return {
        instance: String(row.instance),
        chatwoot,
        n8n,
        createdAt: Number(row.created_at ?? Date.now()),
        updatedAt: Number(row.updated_at ?? Date.now()),
    };
}
/**
 * Mascara tokens sensíveis de um objeto InstanceIntegrations já parsed.
 * Use quando o objeto foi obtido via getInstanceIntegrations() e precisa
 * ser serializado para resposta de API.
 */
export function redactIntegrations(integration) {
    return {
        ...integration,
        chatwoot: {
            ...integration.chatwoot,
            apiAccessToken: integration.chatwoot.apiAccessToken ? '***' : '',
        },
        n8n: {
            ...integration.n8n,
            authHeaderValue: integration.n8n.authHeaderValue ? '***' : '',
        },
    };
}
/** Versão pública (mascara tokens sensíveis). */
export function toPublicRow(row) {
    return toRow(row, true);
}
export function getInstanceIntegrations(instance) {
    const normalized = String(instance || '').trim();
    // Fast path: serve from cache when fresh.
    const cached = _integrationsCache.get(normalized);
    if (cached && cached.exp > Date.now())
        return cached.value;
    const row = db.prepare('SELECT * FROM integration_configs WHERE instance = ?').get(normalized);
    let value;
    if (!row) {
        const now = Date.now();
        value = {
            instance: normalized,
            chatwoot: defaultChatwoot(),
            n8n: defaultN8n(),
            createdAt: now,
            updatedAt: now,
        };
    }
    else {
        value = toRow(row);
    }
    _integrationsCache.set(normalized, { value, exp: Date.now() + INTEGRATIONS_CACHE_TTL_MS });
    return value;
}
// ─── Cache for getInstanceIntegrations ───────────────────────────────────────
// getInstanceIntegrations is called on every messages.upsert (via dispatchToChatwoot),
// contacts.update, chats.update, etc. Without a cache each call does a SQLite
// SELECT. A short TTL of 5s keeps the data fresh while eliminating most DB reads
// under sustained message load.
const _integrationsCache = new Map();
const INTEGRATIONS_CACHE_TTL_MS = 5_000;
function invalidateIntegrationsCache(instance) {
    _integrationsCache.delete(instance);
}
// ─── Cache for slug→instance lookups ─────────────────────────────────────────
// Invalidated on every config update.
// TTL of 60s as safety net in case invalidation is missed.
// MAX_SLUG_CACHE_SIZE caps memory usage against slug-spray attacks.
const _slugCache = new Map();
const SLUG_CACHE_TTL_MS = 60_000;
const MAX_SLUG_CACHE_SIZE = 2000;
export function invalidateSlugCache() {
    _slugCache.clear();
}
/**
 * Find the instance name that has a given webhookSlug configured.
 * Returns null if not found.
 */
export function findInstanceByWebhookSlug(slug) {
    const normalized = String(slug || '').trim().toLowerCase();
    if (!normalized)
        return null;
    const cached = _slugCache.get(normalized);
    if (cached) {
        if (cached.exp > Date.now())
            return cached.instance;
        _slugCache.delete(normalized); // expired
    }
    const rows = db
        .prepare('SELECT instance, chatwoot_json FROM integration_configs')
        .all();
    let found = null;
    for (const row of rows) {
        const instance = String(row.instance ?? '').trim();
        const cfg = parseJson(row.chatwoot_json, defaultChatwoot());
        const effectiveSlug = (cfg.webhookSlug?.trim() || instance).toLowerCase();
        if (effectiveSlug === normalized) {
            found = instance;
            break;
        }
    }
    // Evict oldest entries when cache is full to bound memory usage.
    if (_slugCache.size >= MAX_SLUG_CACHE_SIZE) {
        const firstKey = _slugCache.keys().next().value;
        if (firstKey !== undefined)
            _slugCache.delete(firstKey);
    }
    _slugCache.set(normalized, { instance: found, exp: Date.now() + SLUG_CACHE_TTL_MS });
    return found;
}
export function listIntegrationInstances(redactSecrets = true) {
    const rows = db.prepare('SELECT * FROM integration_configs ORDER BY updated_at DESC').all();
    return rows.map((r) => toRow(r, redactSecrets));
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
    // Invalidate caches whenever config changes.
    invalidateSlugCache();
    invalidateIntegrationsCache(next.instance);
    return {
        ...next,
        createdAt,
        updatedAt: now,
    };
}
/**
 * Remove keys whose value is `undefined` to make patches truly partial.
 * Sem isso, o spread `{...current, ...patch}` mant\u00e9m chaves com `undefined`,
 * que `JSON.stringify` em seguida omite, apagando dados existentes no banco.
 */
function pruneUndefined(patch) {
    const out = {};
    for (const key of Object.keys(patch)) {
        const value = patch[key];
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
export function updateChatwootConfig(instance, patch) {
    const current = getInstanceIntegrations(instance);
    const cleanPatch = pruneUndefined(patch);
    const next = {
        ...current,
        chatwoot: {
            ...current.chatwoot,
            ...cleanPatch,
            baseUrl: normalizeBaseUrl(cleanPatch.baseUrl ?? current.chatwoot.baseUrl),
        },
    };
    return saveInstanceIntegrations(next);
}
export function updateN8nConfig(instance, patch) {
    const current = getInstanceIntegrations(instance);
    const cleanPatch = pruneUndefined(patch);
    const next = {
        ...current,
        n8n: {
            ...current.n8n,
            ...cleanPatch,
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
        const status = res.status;
        await discardResponseBody(res);
        return { ok: status >= 200 && status < 300, status,
            error: status >= 200 && status < 300 ? undefined : `chatwoot_http_${status}` };
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
        const status = res.status;
        await discardResponseBody(res);
        return { ok: status >= 200 && status < 300, status,
            error: status >= 200 && status < 300 ? undefined : `n8n_http_${status}` };
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
// ─── One-shot migration: legacy chatwoot.importContacts → general.importContacts ─
/**
 * Copia o valor antigo de `chatwoot.importContacts` (em `integration_configs`)
 * para `GeneralConfig.importContacts` (em `panel_config` / `instance-config`)
 * em todas as instâncias que ainda não foram migradas.
 *
 * Estratégia:
 *  - Para cada linha em `integration_configs`, lê `chatwoot_json` e extrai
 *    `importContacts` (se existir).
 *  - Se o General atual da instância tiver `importContacts === false` (default)
 *    E o legacy estiver `true`, sobrescreve para `true`.
 *  - Se ambos forem `false` ou se General já estiver `true`, não faz nada.
 *  - Não modifica `chatwoot_json` (mantém o campo lá como compat retroativa).
 *
 * Idempotente: pode ser chamada toda inicialização sem efeitos colaterais
 * acumulativos. Falhas em uma instância são logadas e não interrompem as demais.
 */
export function migrateLegacyImportContactsFlag() {
    let migrated = 0;
    let scanned = 0;
    try {
        const rows = db
            .prepare('SELECT instance, chatwoot_json FROM integration_configs')
            .all();
        for (const row of rows) {
            scanned += 1;
            try {
                const parsed = JSON.parse(row.chatwoot_json);
                const legacyValue = parsed && typeof parsed === 'object' ? parsed.importContacts : undefined;
                if (legacyValue !== true)
                    continue;
                // Apenas promove se o General atual ainda estiver com o default false.
                // Não rebaixa: se o usuário já marcou true no General, mantém.
                // (updateInstanceGeneral mescla com o estado atual.)
                updateInstanceGeneral(row.instance, { importContacts: true });
                migrated += 1;
            }
            catch (err) {
                log.app.warn('failed to migrate legacy importContacts flag for instance', { instance: row.instance, err: err?.message });
            }
        }
    }
    catch (err) {
        log.app.warn('failed to scan integration_configs for legacy importContacts migration', { err: err?.message });
        return;
    }
    if (migrated > 0) {
        log.app.info('migrated legacy chatwoot.importContacts → general.importContacts', { scanned, migrated });
    }
}
