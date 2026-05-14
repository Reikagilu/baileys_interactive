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
export declare function markChatwootOriginated(msgId: string): void;
export declare function isChatwootOriginated(msgId: string): boolean;
