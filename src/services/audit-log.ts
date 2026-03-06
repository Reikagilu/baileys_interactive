import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { getApiPrincipal } from '../middleware/api-auth.js';

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

const recent: AuditEvent[] = [];
let initialized = false;
let logPath = '';

function initAudit(): void {
  if (initialized) return;
  logPath = ensureLogPath();
  initialized = true;
}

function ensureLogPath(): string {
  const filePath = path.resolve(process.cwd(), config.audit.logPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return filePath;
}

function pushRecent(event: AuditEvent): void {
  recent.push(event);
  const max = config.audit.maxInMemoryEvents;
  if (recent.length > max) {
    recent.splice(0, recent.length - max);
  }
}

export function writeAuditEvent(
  req: Request,
  res: Response,
  input: { action: string; target?: string; outcome?: 'success' | 'failure'; details?: unknown }
): void {
  const principal = getApiPrincipal(res);
  const event: AuditEvent = {
    ts: new Date().toISOString(),
    requestId: res.locals?.requestId,
    action: input.action,
    target: input.target,
    outcome: input.outcome ?? 'success',
    actor: {
      keyId: principal?.keyId ?? 'anonymous',
      scopes: principal?.scopes ?? [],
    },
    request: {
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
    },
    details: input.details,
  };

  pushRecent(event);

  initAudit();

  try {
    fs.appendFile(logPath, `${JSON.stringify(event)}\n`, 'utf8', () => {});
  } catch {
    // keep request flow resilient even if audit file cannot be written
  }
}

export function listRecentAuditEvents(limit = 100): AuditEvent[] {
  const normalized = Math.min(Math.max(limit, 1), 1000);
  return recent.slice(-normalized).reverse();
}
