import type { Request, Response, NextFunction } from 'express';
interface ApiPrincipal {
    keyId: string;
    scopes: string[];
}
export declare function requireApiKey(requiredScopes?: string[]): (req: Request, res: Response, next: NextFunction) => Response;
export declare function getApiPrincipal(res: Response): ApiPrincipal | null;
export {};
