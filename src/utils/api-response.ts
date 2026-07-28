import type { Response } from 'express';

type JsonRecord = Record<string, unknown>;

/**
 * Envia uma resposta de sucesso padronizada.
 * Status padrão: 200.
 */
export function sendOk(res: Response, data?: JsonRecord, status = 200): Response {
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
  return res.status(status).json({
    ok: true,
    ...(requestId ? { requestId } : {}),
    ...data,
  });
}

/**
 * Envia uma resposta de erro padronizada.
 */
export function sendError(
  res: Response,
  status: number,
  error: string,
  message?: string,
  details?: unknown,
): Response {
  const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
  const body: Record<string, unknown> = { ok: false, error };
  if (requestId) body.requestId = requestId;
  if (message) body.message = message;
  if (details !== undefined) body.details = details;
  return res.status(status).json(body);
}
