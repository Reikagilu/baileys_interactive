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

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') return fallback;
    return { ...fallback, ...parsed } as T;
  } catch {
    return fallback;
  }
}

function toRow(row: Record<string, unknown>): InstanceIntegrations {
  return {
    instance: String(row.instance),
    chatwoot: parseJson<ChatwootConfig>(row.chatwoot_json, defaultChatwoot()),
    n8n: parseJson<N8nConfig>(row.n8n_json, defaultN8n()),
    createdAt: Number(row.created_at ?? Date.now()),
    updatedAt: Number(row.updated_at ?? Date.now()),
  };
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

export function listIntegrationInstances(): InstanceIntegrations[] {
  const rows = db.prepare('SELECT * FROM integration_configs ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
  return rows.map(toRow);
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

  return {
    ...next,
    createdAt,
    updatedAt: now,
  };
}

export function updateChatwootConfig(instance: string, patch: Partial<ChatwootConfig>): InstanceIntegrations {
  const current = getInstanceIntegrations(instance);
  const next: InstanceIntegrations = {
    ...current,
    chatwoot: {
      ...current.chatwoot,
      ...patch,
      baseUrl: normalizeBaseUrl(patch.baseUrl ?? current.chatwoot.baseUrl),
    },
  };
  return saveInstanceIntegrations(next);
}

export function updateN8nConfig(instance: string, patch: Partial<N8nConfig>): InstanceIntegrations {
  const current = getInstanceIntegrations(instance);
  const next: InstanceIntegrations = {
    ...current,
    n8n: {
      ...current.n8n,
      ...patch,
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
