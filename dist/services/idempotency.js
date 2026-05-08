import { createHash } from 'node:crypto';
import { config } from '../config.js';
const store = new Map();
function makeStoreKey(key, scope) {
    const digest = createHash('sha256').update(`${scope}:${key}`).digest('hex');
    return digest;
}
function pruneExpired() {
    const now = Date.now();
    for (const [entryKey, entry] of store.entries()) {
        if (entry.expiresAt <= now) {
            store.delete(entryKey);
        }
    }
}
function trimToLimit() {
    if (store.size <= config.idempotency.maxEntries)
        return;
    const sorted = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const overBy = store.size - config.idempotency.maxEntries;
    for (let index = 0; index < overBy; index += 1) {
        const [entryKey] = sorted[index] ?? [];
        if (entryKey)
            store.delete(entryKey);
    }
}
export function getIdempotentResult(key, scope) {
    if (!config.idempotency.enabled)
        return null;
    if (!key)
        return null;
    pruneExpired();
    const entry = store.get(makeStoreKey(key, scope));
    if (!entry)
        return null;
    if (entry.expiresAt <= Date.now()) {
        store.delete(makeStoreKey(key, scope));
        return null;
    }
    return entry;
}
export function storeIdempotentResult(key, scope, result, statusCode = 200) {
    if (!config.idempotency.enabled)
        return;
    if (!key)
        return;
    const now = Date.now();
    const entry = {
        key,
        scope,
        result,
        statusCode,
        createdAt: now,
        expiresAt: now + config.idempotency.ttlMs,
    };
    store.set(makeStoreKey(key, scope), entry);
    trimToLimit();
}
//# sourceMappingURL=idempotency.js.map