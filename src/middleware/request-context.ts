import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

function sanitizeRequestPath(pathValue: string): string {
  if (!pathValue) return '/';
  if (pathValue.length > 120) return `${pathValue.slice(0, 120)}...`;
  return pathValue;
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incomingRequestId = req.header('x-request-id');
  const requestId = incomingRequestId && incomingRequestId.trim() ? incomingRequestId.trim() : randomUUID();
  const startedAt = Date.now();

  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    if (!config.logging.requestLogsEnabled) return;
    const pathValue = req.originalUrl || req.url;
    if (pathValue.startsWith('/health') || pathValue.startsWith('/ready') || pathValue.startsWith('/metrics')) return;

    const durationMs = Date.now() - startedAt;
    const line = {
      ts: new Date().toISOString(),
      level: 'info',
      requestId,
      method: req.method,
      path: sanitizeRequestPath(req.originalUrl || req.url),
      status: res.statusCode,
      durationMs,
    };
    console.log(JSON.stringify(line));
  });

  next();
}
