/**
 * Tracks message IDs sent by the system (Chatwoot → WhatsApp) to prevent
 * infinite dispatch loops. Since whatsapp.ts imports chatwoot-bridge.ts and
 * chatwoot-bridge.ts would otherwise need to import whatsapp.ts, this module
 * acts as a shared, dependency-free tracking store.
 *
 * Para evitar duplicação quando uma mensagem demora muito a chegar (atraso
 * de Baileys, reconexão, etc), o tracking tem duas camadas:
 *   1) Cache em memória rápido (Map) — TTL de 24h.
 *   2) Persistência via SQLite (delegada a chatwoot-sync-store) — sobrevive
 *      a restarts e dura ~7 dias.
 *
 * `isChatwootOriginated` checa ambas: memória primeiro (rápido), e se não
 * achar, consulta SQLite. Assim o filtro de duplicação é à prova de delays.
 */
import { persistChatwootOriginated, isChatwootOriginatedPersisted, } from './chatwoot-sync-store.js';
/** msgId → expireTimestamp */
const chatwootOriginatedIds = new Map();
// TTL em memória: 24h — cobre quaisquer atrasos plausíveis de entrega Baileys.
const MEMORY_TTL_MS = 24 * 60 * 60 * 1000;
function pruneExpired(now) {
    for (const [id, exp] of chatwootOriginatedIds) {
        if (exp < now)
            chatwootOriginatedIds.delete(id);
    }
}
export function markChatwootOriginated(msgId) {
    if (!msgId)
        return;
    const now = Date.now();
    chatwootOriginatedIds.set(msgId, now + MEMORY_TTL_MS);
    // Persist async (fire-and-forget). SQLite write é síncrono mas barato.
    try {
        persistChatwootOriginated(msgId);
    }
    catch {
        // Silencia: a barreira de memória já cobre 24h.
    }
    // Prune ocasional (custo amortizado baixo).
    if (chatwootOriginatedIds.size > 256 && Math.random() < 0.05) {
        pruneExpired(now);
    }
}
export function isChatwootOriginated(msgId) {
    if (!msgId)
        return false;
    const exp = chatwootOriginatedIds.get(msgId);
    if (exp && exp >= Date.now())
        return true;
    if (exp && exp < Date.now())
        chatwootOriginatedIds.delete(msgId);
    // Fallback: SQLite (cobre restarts / atrasos > 24h até o TTL persistido).
    try {
        return isChatwootOriginatedPersisted(msgId);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=chatwoot-tracking.js.map