interface IdempotentEntry {
    key: string;
    scope: string;
    result: Record<string, unknown>;
    statusCode: number;
    createdAt: number;
    expiresAt: number;
}
export function getIdempotentResult(key: string, scope: string): IdempotentEntry | null { return undefined as any; }
export function storeIdempotentResult(key: string, scope: string, result: Record<string, unknown>, statusCode?: number): void { return undefined as any; }
export {};
