import type { NextFunction, Request, Response } from 'express';
interface ApiPrincipal {
    keyId: string;
    scopes: string[];
}
export declare function requireApiKey(requiredScopes?: string[]): (req: Request, res: Response, next: NextFunction) => void | Response;
export declare function getApiPrincipal(res: Response): ApiPrincipal | null;
export {};
