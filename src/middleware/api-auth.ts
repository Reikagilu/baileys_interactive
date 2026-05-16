import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';
import { sendError } from '../utils/api-response.js';

interface KeyRecord {
  keyId: string;
  key: string;
  scopes: string[];
}

interface ApiPrincipal {
  keyId: string;
  scopes: string[];
}

let cachedSource = '';
let cachedRecords: KeyRecord[] = [];

/**
 * Comparação de strings timing-safe com padding para prevenir timing oracle
 * por comprimento. Idêntico ao padrão de safeEqual em index.ts.
 * A versão anterior fazia early-return em ab.length !== bb.length, vazando
 * o comprimento esperado da key via canal de tempo.
 */
function safeKeyEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  const maxLen = Math.max(ab.length, bb.length);
  const pa = Buffer.concat([ab, Buffer.alloc(maxLen - ab.length)]);
  const pb = Buffer.concat([bb, Buffer.alloc(maxLen - bb.length)]);
  // timingSafeEqual exige buffers de mesmo tamanho — garantido pelo padding acima.
  // O check de comprimento ao final é necessário para correção: dois buffers
  // com padding podem ter conteúdo igual mas origens de tamanho diferente.
  return timingSafeEqual(pa, pb) && ab.length === bb.length;
}

function normalizeScopes(scopes: unknown): string[] {
  if (!Array.isArray(scopes)) return [];
  return scopes.map((scope) => String(scope || '').trim()).filter(Boolean);
}

function parseConfiguredKeys(): KeyRecord[] {
  const source = `${config.apiKey}|${config.apiKeysJson}`;
  if (source === cachedSource) return cachedRecords;
  const records: KeyRecord[] = [];
  if (config.apiKey && config.apiKey.trim()) {
    records.push({ keyId: 'default', key: config.apiKey.trim(), scopes: ['*'] });
  }
  if (config.apiKeysJson.trim()) {
    try {
      const parsed = JSON.parse(config.apiKeysJson);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue;
          const key = String((item as any).key ?? '').trim();
          if (!key) continue;
          const enabledRaw = (item as any).enabled;
          if (enabledRaw === false) continue;
          const keyId =
            String((item as any).id ?? `key_${records.length + 1}`).trim() ||
            `key_${records.length + 1}`;
          const scopes = normalizeScopes((item as any).scopes);
          // Default para [] (sem acesso) em vez de ['*'] (superuser), para não
          // criar keys root acidentalmente quando o campo scopes for omitido.
          // Use ['*'] explicitamente no JSON quando quiser acesso total.
          records.push({ keyId, key, scopes });
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
  return (req: Request, res: Response, next: NextFunction) => {
    const records = parseConfiguredKeys();
    if (!records.length) {
      // Sem keys configuradas: em produção o processo deveria ter abortado
      // no boot (index.ts:116). Em dev/test, permitir acesso sem auth.
      next();
      return;
    }
    const rawKey = String(req.header('x-api-key') ?? '').trim();
    // Rejeitar headers excessivamente longos antes de alocar Buffers.
    const key = rawKey.length > 512 ? '' : rawKey;
    if (!key) {
      return sendError(res, 401, 'missing_api_key');
    }
    // Iterar TODAS as records mesmo após encontrar match para prevenir timing
    // oracle por posição da key na lista (records.find interrompe cedo).
    let matched: KeyRecord | undefined;
    for (const record of records) {
      if (safeKeyEqual(record.key, key)) matched = record;
    }
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
  const principal = res.locals?.principal;
  return principal ?? null;
}
