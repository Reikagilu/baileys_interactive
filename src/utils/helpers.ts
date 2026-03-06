/**
 * Formata número para JID do WhatsApp (5511999999999@s.whatsapp.net)
 */
export function toJid(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  if (phone.includes('@')) return phone;
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length < 10) return null;
  return `${cleaned}@s.whatsapp.net`;
}

export const INSTANCE_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidInstanceName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return INSTANCE_NAME_PATTERN.test(value.trim());
}

export function normalizeInstanceName(value: unknown, fallback?: string): string | null {
  const raw = value == null || String(value).trim() === '' ? fallback ?? '' : String(value);
  const name = raw.trim();
  if (!name) return null;
  return isValidInstanceName(name) ? name : null;
}

/**
 * Verifica se a instância está conectada
 */
export function isConnected(ctx: { sock?: unknown; status?: string } | null): boolean {
  return Boolean(ctx?.sock && ctx.status === 'connected');
}

/**
 * Verifica se string é URL
 */
export function isUrl(str: unknown): str is string {
  if (typeof str !== 'string') return false;
  return /^https?:\/\//i.test(str.trim());
}
