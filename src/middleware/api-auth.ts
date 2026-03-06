import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { sendError } from '../utils/api-response.js';

interface ApiPrincipal {
  keyId: string;
  scopes: string[];
}

interface ApiKeyRecord extends ApiPrincipal {
  key: string;
}

let cachedSource = '';
let cachedRecords: ApiKeyRecord[] = [];

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  return scopes.map((scope) => String(scope || '').trim()).filter(Boolean);
}

function parseConfiguredKeys(): ApiKeyRecord[] {
  const source = `${config.apiKey}|${config.apiKeysJson}`;
  if (source === cachedSource) return cachedRecords;

  const records: ApiKeyRecord[] = [];
  if (config.apiKey && config.apiKey.trim()) {
    records.push({ keyId: 'default', key: config.apiKey.trim(), scopes: ['*'] });
  }

  if (config.apiKeysJson.trim()) {
    try {
      const parsed = JSON.parse(config.apiKeysJson) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const key = String((item as { key?: unknown }).key ?? '').trim();
          if (!key) continue;
          const enabledRaw = (item as { enabled?: unknown }).enabled;
          if (enabledRaw === false) continue;

          const keyId = String((item as { id?: unknown }).id ?? `key_${records.length + 1}`).trim() || `key_${records.length + 1}`;
          const scopes = normalizeScopes((item as { scopes?: unknown }).scopes);
          records.push({ keyId, key, scopes: scopes.length ? scopes : ['*'] });
        }
      }
    } catch {
      // ignore invalid JSON and fallback to API_KEY only
    }
  }

  cachedSource = source;
  cachedRecords = records;
  return records;
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
  return (req: Request, res: Response, next: NextFunction): void | Response => {
    const records = parseConfiguredKeys();
    if (!records.length) {
      next();
      return;
    }

    const key = String(req.header('x-api-key') ?? '').trim();
    if (!key) {
      return sendError(res, 401, 'missing_api_key');
    }

    const matched = records.find((record) => record.key === key);
    if (!matched) {
      return sendError(res, 401, 'invalid_api_key');
    }

    if (!hasRequiredScope(matched.scopes, requiredScopes)) {
      return sendError(res, 403, 'insufficient_scope', 'API key is valid but lacks required permissions.', {
        requiredScopes,
        keyId: matched.keyId,
      });
    }

    const principal: ApiPrincipal = {
      keyId: matched.keyId,
      scopes: matched.scopes,
    };

    res.locals.principal = principal;
    next();
  };
}

export function getApiPrincipal(res: Response): ApiPrincipal | null {
  const principal = res.locals?.principal as ApiPrincipal | undefined;
  return principal ?? null;
}
