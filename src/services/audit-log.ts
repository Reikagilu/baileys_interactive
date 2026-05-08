import type { Request, Response } from 'express';
interface AuditEvent {
    ts: string;
    requestId?: string;
    action: string;
    target?: string;
    outcome: 'success' | 'failure';
    actor: {
        keyId: string;
        scopes: string[];
    };
    request: {
        method: string;
        path: string;
        ip?: string;
    };
    details?: unknown;
}
export function writeAuditEvent(req: Request, res: Response, input: {
    action: string;
    target?: string;
    outcome?: 'success' | 'failure';
    details?: unknown;
}): void { return undefined as any; }
export function listRecentAuditEvents(limit?: number): AuditEvent[] { return undefined as any; }
export {};
