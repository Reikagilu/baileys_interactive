import crypto from 'node:crypto';

function toBase64Url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : normalized + '='.repeat(4 - pad);
  return Buffer.from(padded, 'base64');
}

function mediaSignaturePayload(instance: string, mediaId: string, exp: number): string {
  return `${instance}:${mediaId}:${exp}`;
}

export function signMediaUrlToken(secret: string, instance: string, mediaId: string, exp: number): string {
  const payload = mediaSignaturePayload(instance, mediaId, exp);
  const mac = crypto.createHmac('sha256', secret).update(payload).digest();
  return toBase64Url(mac);
}

export function verifyMediaUrlToken(
  secret: string,
  instance: string,
  mediaId: string,
  expRaw: unknown,
  sigRaw: unknown
): { ok: true; exp: number } | { ok: false; error: 'invalid_token' | 'expired_token' } {
  const exp = Number.parseInt(String(expRaw ?? ''), 10);
  const sig = String(sigRaw ?? '').trim();
  if (!Number.isFinite(exp) || exp <= 0 || !sig) {
    return { ok: false, error: 'invalid_token' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (exp < nowSeconds) {
    return { ok: false, error: 'expired_token' };
  }

  const expected = signMediaUrlToken(secret, instance, mediaId, exp);
  try {
    const expectedBytes = fromBase64Url(expected);
    const sigBytes = fromBase64Url(sig);
    if (expectedBytes.length !== sigBytes.length) {
      return { ok: false, error: 'invalid_token' };
    }
    if (!crypto.timingSafeEqual(expectedBytes, sigBytes)) {
      return { ok: false, error: 'invalid_token' };
    }
    return { ok: true, exp };
  } catch {
    return { ok: false, error: 'invalid_token' };
  }
}
