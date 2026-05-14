import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { sendError } from '../utils/api-response.js';
let cachedSource = '';
let cachedRecords = [];
function safeKeyEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length)
        return false;
    return timingSafeEqual(ab, bb);
}
function normalizeScopes(scopes) {
    if (!Array.isArray(scopes))
        return [];
    return scopes.map((scope) => String(scope || '').trim()).filter(Boolean);
}
function parseConfiguredKeys() {
    const source = `${config.apiKey}|${config.apiKeysJson}`;
    if (source === cachedSource)
        return cachedRecords;
    const records = [];
    if (config.apiKey && config.apiKey.trim()) {
        records.push({ keyId: 'default', key: config.apiKey.trim(), scopes: ['*'] });
    }
    if (config.apiKeysJson.trim()) {
        try {
            const parsed = JSON.parse(config.apiKeysJson);
            if (Array.isArray(parsed)) {
                for (const item of parsed) {
                    if (!item || typeof item !== 'object')
                        continue;
                    const key = String(item.key ?? '').trim();
                    if (!key)
                        continue;
                    const enabledRaw = item.enabled;
                    if (enabledRaw === false)
                        continue;
                    const keyId = String(item.id ?? `key_${records.length + 1}`).trim() ||
                        `key_${records.length + 1}`;
                    const scopes = normalizeScopes(item.scopes);
                    records.push({ keyId, key, scopes: scopes.length ? scopes : ['*'] });
                }
            }
        }
        catch {
            // ignore invalid JSON and fallback to API_KEY only
        }
    }
    cachedSource = source;
    cachedRecords = records;
    return records;
}
function hasRequiredScope(principalScopes, requiredScopes) {
    if (!requiredScopes.length)
        return true;
    if (principalScopes.includes('*'))
        return true;
    return requiredScopes.every((required) => {
        if (principalScopes.includes(required))
            return true;
        const [requiredPrefix] = required.split(':');
        return principalScopes.includes(`${requiredPrefix}:*`);
    });
}
export function requireApiKey(requiredScopes = []) {
    return (req, res, next) => {
        const records = parseConfiguredKeys();
        if (!records.length) {
            next();
            return;
        }
        const key = String(req.header('x-api-key') ?? '').trim();
        if (!key) {
            return sendError(res, 401, 'missing_api_key');
        }
        const matched = records.find((record) => safeKeyEqual(record.key, key));
        if (!matched) {
            return sendError(res, 401, 'invalid_api_key');
        }
        if (!hasRequiredScope(matched.scopes, requiredScopes)) {
            return sendError(res, 403, 'insufficient_scope', 'API key is valid but lacks required permissions.', {
                requiredScopes,
                keyId: matched.keyId,
            });
        }
        const principal = {
            keyId: matched.keyId,
            scopes: matched.scopes,
        };
        res.locals.principal = principal;
        next();
    };
}
export function getApiPrincipal(res) {
    const principal = res.locals?.principal;
    return principal ?? null;
}
//# sourceMappingURL=api-auth.js.map