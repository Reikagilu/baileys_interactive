export function signMediaUrlToken(secret: string, instance: string, mediaId: string, exp: number): string { return undefined as any; }
export function verifyMediaUrlToken(secret: string, instance: string, mediaId: string, expRaw: unknown, sigRaw: unknown): {
    ok: true;
    exp: number;
} | {
    ok: false;
    error: 'invalid_token' | 'expired_token';
} { return undefined as any; }
