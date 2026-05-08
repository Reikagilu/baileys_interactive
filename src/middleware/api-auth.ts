import type { NextFunction, Request, Response } from 'express';
interface ApiPrincipal {
    keyId: string;
    scopes: string[];
}
export function requireApiKey(requiredScopes?: string[]): (req: Request, res: Response, next: NextFunction) => void | Response { return undefined as any; }
export function getApiPrincipal(res: Response): ApiPrincipal | null { return undefined as any; }
export {};
