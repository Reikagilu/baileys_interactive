/**
 * Tracks message IDs sent by the system (Chatwoot → WhatsApp) to prevent
 * infinite dispatch loops. Since whatsapp.ts imports chatwoot-bridge.ts and
 * chatwoot-bridge.ts would otherwise need to import whatsapp.ts, this module
 * acts as a shared, dependency-free tracking store.
 */
/** msgId → expireTimestamp */
const chatwootOriginatedIds = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes
export function markChatwootOriginated(msgId) {
    chatwootOriginatedIds.set(msgId, Date.now() + TTL_MS);
    // Prune expired entries to avoid memory growth
    const now = Date.now();
    for (const [id, exp] of chatwootOriginatedIds) {
        if (exp < now)
            chatwootOriginatedIds.delete(id);
    }
}
export function isChatwootOriginated(msgId) {
    const exp = chatwootOriginatedIds.get(msgId);
    if (!exp)
        return false;
    if (exp < Date.now()) {
        chatwootOriginatedIds.delete(msgId);
        return false;
    }
    return true;
}
//# sourceMappingURL=chatwoot-tracking.js.map