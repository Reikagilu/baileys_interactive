/**
 * Tracks message IDs sent by the system (Chatwoot → WhatsApp) to prevent
 * infinite dispatch loops. Since whatsapp.ts imports chatwoot-bridge.ts and
 * chatwoot-bridge.ts would otherwise need to import whatsapp.ts, this module
 * acts as a shared, dependency-free tracking store.
 */
export declare function markChatwootOriginated(msgId: string): void;
export declare function isChatwootOriginated(msgId: string): boolean;
