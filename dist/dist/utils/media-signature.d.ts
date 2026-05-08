export declare function signMediaUrlToken(secret: string, instance: string, mediaId: string, exp: number): string;
export declare function verifyMediaUrlToken(secret: string, instance: string, mediaId: string, expRaw: unknown, sigRaw: unknown): {
    ok: true;
    exp: number;
} | {
    ok: false;
    error: 'invalid_token' | 'expired_token';
};
//# sourceMappingURL=media-signature.d.ts.map