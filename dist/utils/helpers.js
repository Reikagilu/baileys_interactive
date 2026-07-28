/**
 * Formata número para JID do WhatsApp (5511999999999@s.whatsapp.net)
 */
export function toJid(phone) {
    const raw = String(phone ?? '').trim();
    if (/^\d+@s\.whatsapp\.net$/i.test(raw))
        return raw.toLowerCase();
    const digits = raw.replace(/\D+/g, '');
    // Raw destinations must be plausible E.164 numbers. Preserve already formed
    // JIDs for protocol/internal callers, but reject accidental short inputs.
    if (digits.length < 8 || digits.length > 15)
        return null;
    return `${digits}@s.whatsapp.net`;
}
export const INSTANCE_NAME_PATTERN = /^[a-z0-9_-]{1,64}$/i;
export function isValidInstanceName(value) {
    return typeof value === 'string' && INSTANCE_NAME_PATTERN.test(value.trim());
}
export function normalizeInstanceName(value, fallback) {
    const normalized = String(value ?? fallback ?? '').trim();
    return isValidInstanceName(normalized) ? normalized : null;
}
/**
 * Verifica se a instância está conectada
 */
export function isConnected(ctx) {
    return Boolean(ctx && ctx.sock && ctx.status === 'connected');
}
/**
 * Verifica se string é URL
 */
export function isUrl(str) {
    if (typeof str !== 'string')
        return false;
    try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}
