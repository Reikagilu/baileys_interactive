import type { Response } from 'express';
type JsonRecord = Record<string, unknown>;
export declare function sendOk(res: Response, data?: JsonRecord, status?: number): Response;
export declare function sendError(res: Response, status: number, error: string, message?: string, details?: unknown): Response;
export {};
//# sourceMappingURL=api-response.d.ts.map