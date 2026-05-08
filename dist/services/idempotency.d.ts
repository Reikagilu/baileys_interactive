interface IdempotentEntry {
    key: string;
    scope: string;
    result: Record<string, unknown>;
    statusCode: number;
    createdAt: number;
    expiresAt: number;
}
export declare function getIdempotentResult(key: string, scope: string): IdempotentEntry | null;
export declare function storeIdempotentResult(key: string, scope: string, result: Record<string, unknown>, statusCode?: number): void;
export {};
