import type { Response } from 'express';
type JsonRecord = Record<string, unknown>;
export function sendOk(res: Response, data?: JsonRecord, status?: number): Response { return undefined as any; }
export function sendError(res: Response, status: number, error: string, message?: string, details?: unknown): Response { return undefined as any; }
export {};
