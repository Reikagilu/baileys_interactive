import type { Response } from 'express';

type JsonRecord = Record<string, unknown>;

function getRequestId(res: Response): string | undefined {
  const value = res.locals?.requestId;
  return typeof value === 'string' && value ? value : undefined;
}

export function sendOk(res: Response, data: JsonRecord = {}, status = 200): Response {
  return res.status(status).json({ ok: true, requestId: getRequestId(res), ...data });
}

export function sendError(
  res: Response,
  status: number,
  error: string,
  message?: string,
  details?: unknown
): Response {
  const payload: JsonRecord = { ok: false, error, requestId: getRequestId(res) };
  if (message) payload.message = message;
  if (details !== undefined) payload.details = details;
  return res.status(status).json(payload);
}
