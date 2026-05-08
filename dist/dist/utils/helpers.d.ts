/**
 * Formata número para JID do WhatsApp (5511999999999@s.whatsapp.net)
 */
export declare function toJid(phone: string | null | undefined): string | null;
export declare const INSTANCE_NAME_PATTERN: RegExp;
export declare function isValidInstanceName(value: unknown): value is string;
export declare function normalizeInstanceName(value: unknown, fallback?: string): string | null;
/**
 * Verifica se a instância está conectada
 */
export declare function isConnected(ctx: {
    sock?: unknown;
    status?: string;
} | null): boolean;
/**
 * Verifica se string é URL
 */
export declare function isUrl(str: unknown): str is string;
//# sourceMappingURL=helpers.d.ts.map