/**
 * Formata número para JID do WhatsApp (5511999999999@s.whatsapp.net)
 */
export function toJid(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== 'string') return null;
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.length < 10) return null;
  if (phone.includes('@')) return phone;
  return `${cleaned}@s.whatsapp.net`;
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
