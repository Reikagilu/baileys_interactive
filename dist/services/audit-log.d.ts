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
export declare function writeAuditEvent(req: Request, res: Response, input: {
    action: string;
    target?: string;
    outcome?: 'success' | 'failure';
    details?: unknown;
}): void;
export declare function listRecentAuditEvents(limit?: number): AuditEvent[];
export {};
