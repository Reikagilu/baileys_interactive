import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Gera um token HMAC-SHA256 assinado para URLs de mídia temporárias.
 * Formato: `sig` = HMAC(secret, `${instance}:${mediaId}:${exp}`)
 */
export function signMediaUrlToken(
  secret: string,
  instance: string,
  mediaId: string,
  exp: number,
): string {
  const payload = `${instance}:${mediaId}:${exp}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Verifica um token de URL de mídia assinado.
 * Retorna `{ ok: true, exp }` se válido, ou `{ ok: false, error }` se inválido/expirado.
 */
export function verifyMediaUrlToken(
  secret: string,
  instance: string,
  mediaId: string,
  expRaw: unknown,
  sigRaw: unknown,
): { ok: true; exp: number } | { ok: false; error: 'invalid_token' | 'expired_token' } {
  const expStr = String(expRaw ?? '').trim();
  const sig = String(sigRaw ?? '').trim();
  if (!expStr || !sig) return { ok: false, error: 'invalid_token' };

  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { ok: false, error: 'invalid_token' };

  // Verificar expiração primeiro (não vaza info sobre assinatura)
  if (Date.now() > exp) return { ok: false, error: 'expired_token' };

  // Verificar assinatura timing-safe
  const expected = signMediaUrlToken(secret, instance, mediaId, exp);
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig.length === expected.length ? sig : '', 'hex');
    if (a.length !== b.length) return { ok: false, error: 'invalid_token' };
    if (!timingSafeEqual(a, b)) return { ok: false, error: 'invalid_token' };
  } catch {
    return { ok: false, error: 'invalid_token' };
  }

  return { ok: true, exp };
}
