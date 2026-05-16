/**
 * Formata número para JID do WhatsApp (5511999999999@s.whatsapp.net)
 */
export function toJid(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D+/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}
export const INSTANCE_NAME_PATTERN: RegExp = /^[a-z0-9_-]{1,64}$/i;
export function isValidInstanceName(value: unknown): value is string {
  return typeof value === 'string' && INSTANCE_NAME_PATTERN.test(value.trim());
}
export function normalizeInstanceName(value: unknown, fallback?: string): string | null {
  const normalized = String(value ?? fallback ?? '').trim();
  return isValidInstanceName(normalized) ? normalized : null;
}
/**
 * Verifica se a instância está conectada
 */
export function isConnected(ctx: {
    sock?: unknown;
    status?: string;
} | null): boolean {
  return Boolean(ctx && ctx.sock && ctx.status === 'connected');
}
/**
 * Verifica se string é URL
 */
export function isUrl(str: unknown): str is string {
  if (typeof str !== 'string') return false;
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
