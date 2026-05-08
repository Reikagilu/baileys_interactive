/**
 * Formata número para JID do WhatsApp (5511999999999@s.whatsapp.net)
 */
export function toJid(phone: string | null | undefined): string | null { return undefined as any; }
export const INSTANCE_NAME_PATTERN: RegExp = /^[a-z0-9_-]{1,64}$/i;
export function isValidInstanceName(value: unknown): value is string { return undefined as any; }
export function normalizeInstanceName(value: unknown, fallback?: string): string | null { return undefined as any; }
/**
 * Verifica se a instância está conectada
 */
export function isConnected(ctx: {
    sock?: unknown;
    status?: string;
} | null): boolean { return undefined as any; }
/**
 * Verifica se string é URL
 */
export function isUrl(str: unknown): str is string { return undefined as any; }
