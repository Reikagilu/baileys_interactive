import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { validateOutboundUrl } from '../utils/url-security.js';

export interface ChatwootConfig {
  enabled: boolean;
  baseUrl: string;
  accountId: string;
  inboxId: string;
  apiAccessToken: string;
  // Extended fields
  nameInbox: string;
  webhookSlug: string;   // slug used in webhook URL: /chatwoot/webhook/:slug
  signMessages: boolean;
  signDelimiter: string;
  organization: string;
  logoUrl: string;
  conversationPending: boolean;
  reopenConversation: boolean;
  importContacts: boolean;
  importMessages: boolean;
  daysLimitImportMessages: number;
  ignoreJids: string[];
  autoCreate: boolean;
}

export interface N8nConfig {
  enabled: boolean;
  webhookUrl: string;
  authHeaderName: string;
  authHeaderValue: string;
}

export interface InstanceIntegrations {
  instance: string;
  chatwoot: ChatwootConfig;
  n8n: N8nConfig;
  createdAt: number;
  updatedAt: number;
}

function defaultChatwoot(): ChatwootConfig {
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

function defaultN8n(): N8nConfig {
  return {
    enabled: false,
    webhookUrl: '',
    authHeaderName: 'x-api-key',
    authHeaderValue: '',
  };
}

function normalizeBaseUrl(input: string): string {
  const trimmed = String(input || '').trim();
  return trimmed.replace(/\/$/, '');
}

function openDatabase(dbPath: string): DatabaseSync {
  const resolved = path.resolve(process.cwd(), dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const database = new DatabaseSync(resolved);
  database.exec('PRAGMA busy_timeout = 5000;');
  try {
    database.exec('PRAGMA journal_mode = WAL;');
  } catch {
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

function parseJson<T extends object>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
    // Merge field-by-field: keep fallback value when parsed field is null/undefined
    // to avoid silently overwriting arrays (e.g. ignoreJids) with null from stored JSON.
    const result = { ...fallback } as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v !== null && v !== undefined) result[k] = v;
    }
    return result as T;
  } catch {
    return fallback;
  }
}

/**
 * Converte uma row do DB em InstanceIntegrations.
 * @param redactSecrets Quando true (padrão: false), mascara apiAccessToken e
 *   authHeaderValue para evitar vazamento em listagens/reads pela API pública.
 *   Use false apenas internamente (quando o token é necessário para chamar Chatwoot/n8n).
 */
function toRow(row: Record<string, unknown>, redactSecrets = false): InstanceIntegrations {
  const chatwoot = parseJson<ChatwootConfig>(row.chatwoot_json, defaultChatwoot());
  const n8n = parseJson<N8nConfig>(row.n8n_json, defaultN8n());
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
export function redactIntegrations(integration: InstanceIntegrations): InstanceIntegrations {
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
export function toPublicRow(row: Record<string, unknown>): InstanceIntegrations {
  return toRow(row, true);
}

export function getInstanceIntegrations(instance: string): InstanceIntegrations {
  const normalized = String(instance || '').trim();
  const row = db.prepare('SELECT * FROM integration_configs WHERE instance = ?').get(normalized) as
    | Record<string, unknown>
    | undefined;

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

// Cache for slug→instance lookups. Invalidated on every config update.
// TTL of 60s as safety net in case invalidation is missed.
// MAX_SLUG_CACHE_SIZE caps memory usage against slug-spray attacks.
const _slugCache = new Map<string, { instance: string | null; exp: number }>();
const SLUG_CACHE_TTL_MS = 60_000;
const MAX_SLUG_CACHE_SIZE = 2000;

export function invalidateSlugCache(): void {
  _slugCache.clear();
}

/**
 * Find the instance name that has a given webhookSlug configured.
 * Returns null if not found.
 */
export function findInstanceByWebhookSlug(slug: string): string | null {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) return null;

  const cached = _slugCache.get(normalized);
  if (cached) {
    if (cached.exp > Date.now()) return cached.instance;
    _slugCache.delete(normalized); // expired
  }

  const rows = db
    .prepare('SELECT instance, chatwoot_json FROM integration_configs')
    .all() as Array<Record<string, unknown>>;
  let found: string | null = null;
  for (const row of rows) {
    const instance = String(row.instance ?? '').trim();
    const cfg = parseJson<ChatwootConfig>(row.chatwoot_json, defaultChatwoot());
    const effectiveSlug = (cfg.webhookSlug?.trim() || instance).toLowerCase();
    if (effectiveSlug === normalized) {
      found = instance;
      break;
    }
  }

  // Evict oldest entries when cache is full to bound memory usage.
  if (_slugCache.size >= MAX_SLUG_CACHE_SIZE) {
    const firstKey = _slugCache.keys().next().value;
    if (firstKey !== undefined) _slugCache.delete(firstKey);
  }
  _slugCache.set(normalized, { instance: found, exp: Date.now() + SLUG_CACHE_TTL_MS });
  return found;
}

export function listIntegrationInstances(redactSecrets = true): InstanceIntegrations[] {
  const rows = db.prepare('SELECT * FROM integration_configs ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map((r) => toRow(r, redactSecrets));
}

function saveInstanceIntegrations(next: InstanceIntegrations): InstanceIntegrations {
  const now = Date.now();
  const existing = db.prepare('SELECT instance, created_at FROM integration_configs WHERE instance = ?').get(next.instance) as
    | Record<string, unknown>
    | undefined;
  const createdAt = existing ? Number(existing.created_at) : now;

  db.prepare(
    `INSERT INTO integration_configs (instance, chatwoot_json, n8n_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(instance) DO UPDATE SET
       chatwoot_json = excluded.chatwoot_json,
       n8n_json = excluded.n8n_json,
       updated_at = excluded.updated_at`
  ).run(next.instance, JSON.stringify(next.chatwoot), JSON.stringify(next.n8n), createdAt, now);

  // Invalidate slug cache whenever config changes — ensures findInstanceByWebhookSlug
  // picks up new/changed webhookSlug values immediately.
  invalidateSlugCache();

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
function pruneUndefined<T extends object>(patch: Partial<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const key of Object.keys(patch) as Array<keyof T>) {
    const value = patch[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function updateChatwootConfig(instance: string, patch: Partial<ChatwootConfig>): InstanceIntegrations {
  const current = getInstanceIntegrations(instance);
  const cleanPatch = pruneUndefined(patch);
  const next: InstanceIntegrations = {
    ...current,
    chatwoot: {
      ...current.chatwoot,
      ...cleanPatch,
      baseUrl: normalizeBaseUrl(cleanPatch.baseUrl ?? current.chatwoot.baseUrl),
    },
  };
  return saveInstanceIntegrations(next);
}

export function updateN8nConfig(instance: string, patch: Partial<N8nConfig>): InstanceIntegrations {
  const current = getInstanceIntegrations(instance);
  const cleanPatch = pruneUndefined(patch);
  const next: InstanceIntegrations = {
    ...current,
    n8n: {
      ...current.n8n,
      ...cleanPatch,
    },
  };
  return saveInstanceIntegrations(next);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function testChatwoot(instance: string): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
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
    const res = await fetchWithTimeout(
      `${baseUrl}/api/v1/profile`,
      {
        method: 'GET',
        headers: {
          api_access_token: cfg.apiAccessToken,
          'content-type': 'application/json',
        },
      },
      config.integrations.requestTimeoutMs
    );
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      error: res.status >= 200 && res.status < 300 ? undefined : `chatwoot_http_${res.status}`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function testN8n(instance: string): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
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

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (cfg.authHeaderName && cfg.authHeaderValue) {
    headers[cfg.authHeaderName] = cfg.authHeaderValue;
  }

  try {
    const res = await fetchWithTimeout(
      webhookUrl,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          source: 'Beyound',
          event: 'integration.test',
          instance,
          emittedAt: new Date().toISOString(),
        }),
      },
      config.integrations.requestTimeoutMs
    );

    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      error: res.status >= 200 && res.status < 300 ? undefined : `n8n_http_${res.status}`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
