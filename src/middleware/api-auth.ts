import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { sendError } from '../utils/api-response.js';

export interface KeyRecord {
  keyId: string;
  key: string;
  scopes: string[];
}

export interface ApiKeyConfiguration {
  records: KeyRecord[];
  errors: string[];
}

interface ApiPrincipal {
  keyId: string;
  scopes: string[];
}

let cachedSource = '';
let cachedConfiguration: ApiKeyConfiguration = { records: [], errors: [] };

function safeKeyEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  const maxLen = Math.max(ab.length, bb.length);
  const pa = Buffer.concat([ab, Buffer.alloc(maxLen - ab.length)]);
  const pb = Buffer.concat([bb, Buffer.alloc(maxLen - bb.length)]);
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

function normalizeScopes(scopes: unknown): string[] | null {
  if (scopes === undefined) return [];
  if (!Array.isArray(scopes)) return null;
  return scopes.map((scope) => String(scope || '').trim()).filter(Boolean);
}

/** Parse both the documented object form and the array form used by older installs. */
export function parseApiKeyConfiguration(apiKey: string, apiKeysJson: string): ApiKeyConfiguration {
  const records: KeyRecord[] = [];
  const errors: string[] = [];
  const defaultKey = apiKey.trim();
  if (defaultKey) records.push({ keyId: 'default', key: defaultKey, scopes: ['*'] });

  const jsonSource = apiKeysJson.trim();
  if (jsonSource) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonSource);
    } catch {
      return { records, errors: ['API_KEYS_JSON is not valid JSON'] };
    }

    let entries: Array<[string | undefined, unknown]> = [];
    if (Array.isArray(parsed)) {
      entries = parsed.map((item) => [undefined, item]);
    } else if (parsed && typeof parsed === 'object') {
      entries = Object.entries(parsed as Record<string, unknown>);
    } else {
      errors.push('API_KEYS_JSON must be an array or object');
    }

    for (const [objectId, item] of entries) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push('API_KEYS_JSON contains a non-object key record');
        continue;
      }
      const raw = item as Record<string, unknown>;
      if (raw.enabled === false) continue;
      const key = String(raw.key ?? '').trim();
      if (!key) {
        errors.push('API_KEYS_JSON contains an enabled record without key');
        continue;
      }
      const scopes = normalizeScopes(raw.scopes);
      if (scopes === null) {
        errors.push('API_KEYS_JSON record scopes must be an array');
        continue;
      }
      const fallbackId = objectId || `key_${records.length + 1}`;
      const keyId = String(raw.id ?? fallbackId).trim();
      if (!keyId) {
        errors.push('API_KEYS_JSON contains a record without id');
        continue;
      }
      records.push({ keyId, key, scopes });
    }
  }

  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const record of records) {
    if (ids.has(record.keyId)) errors.push(`duplicate API key id: ${record.keyId}`);
    if (keys.has(record.key)) errors.push(`duplicate API key material: ${record.keyId}`);
    ids.add(record.keyId);
    keys.add(record.key);
  }
  return { records, errors };
}

export function getApiKeyConfiguration(): ApiKeyConfiguration {
  const source = `${config.apiKey}|${config.apiKeysJson}`;
  if (source !== cachedSource) {
    cachedSource = source;
    cachedConfiguration = parseApiKeyConfiguration(config.apiKey, config.apiKeysJson);
  }
  return cachedConfiguration;
}

function hasRequiredScope(principalScopes: string[], requiredScopes: string[]): boolean {
  if (!requiredScopes.length) return true;
  if (principalScopes.includes('*')) return true;
  return requiredScopes.every((required) => {
    if (principalScopes.includes(required)) return true;
    const [requiredPrefix] = required.split(':');
    return principalScopes.includes(`${requiredPrefix}:*`);
  });
}

export function requireApiKey(requiredScopes: string[] = []) {
  return (req: Request, res: Response, next: NextFunction) => {
    const configuration = getApiKeyConfiguration();
    if (configuration.errors.length || !configuration.records.length) {
      return sendError(res, 503, 'api_auth_not_configured', 'API authentication is unavailable.');
    }
    const rawKey = String(req.header('x-api-key') ?? '').trim();
    const key = rawKey.length > 512 ? '' : rawKey;
    if (!key) return sendError(res, 401, 'missing_api_key');

    let matched: KeyRecord | undefined;
    for (const record of configuration.records) {
      if (safeKeyEqual(record.key, key)) matched = record;
    }
    if (!matched) return sendError(res, 401, 'invalid_api_key');
    if (!hasRequiredScope(matched.scopes, requiredScopes)) {
      return sendError(res, 403, 'insufficient_scope', 'API key is valid but lacks required permissions.', {
        requiredScopes,
        keyId: matched.keyId,
      });
    }
    res.locals.principal = { keyId: matched.keyId, scopes: matched.scopes } satisfies ApiPrincipal;
    next();
  };
}

export function getApiPrincipal(res: Response): ApiPrincipal | null {
  return res.locals?.principal ?? null;
}
