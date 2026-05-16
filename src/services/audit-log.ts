import type { Request, Response } from 'express';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../utils/logger.js';

export interface AuditEvent {
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

// ---------------------------------------------------------------------------
// Lazy SQLite singleton — same pattern as other stores in this codebase.
// ---------------------------------------------------------------------------
let _db: DatabaseSync | null = null;
const _stmts = new Map<string, StatementSync>();
const _ringBuffer: AuditEvent[] = [];
const _maxInMemory = config.audit.maxInMemoryEvents;

function getDb(): DatabaseSync {
  if (_db) return _db;
  try {
    const dbPath = config.audit.logPath.endsWith('.sqlite')
      ? config.audit.logPath
      : path.join(path.dirname(config.audit.logPath), 'audit.sqlite');
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      request_id TEXT,
      action TEXT NOT NULL,
      target TEXT,
      outcome TEXT NOT NULL,
      actor_key_id TEXT NOT NULL,
      actor_scopes TEXT NOT NULL,
      req_method TEXT NOT NULL,
      req_path TEXT NOT NULL,
      req_ip TEXT,
      details_json TEXT,
      created_at INTEGER NOT NULL
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at DESC)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_audit_events_action ON audit_events(action)');
    _db = db;
    return db;
  } catch (err) {
    log.security.error('audit-log getDb failed', err);
    throw err;
  }
}

function stmt(key: string, sql: string): StatementSync {
  let cached = _stmts.get(key);
  if (!cached) {
    cached = getDb().prepare(sql);
    _stmts.set(key, cached);
  }
  return cached;
}

function readPrincipal(res: Response): { keyId: string; scopes: string[] } {
  const principal = (res.locals?.principal ?? {}) as { keyId?: string; scopes?: string[] };
  return {
    keyId: principal.keyId ?? 'anonymous',
    scopes: Array.isArray(principal.scopes) ? principal.scopes : [],
  };
}

function readClientIp(req: Request): string | undefined {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return req.ip || req.socket?.remoteAddress || undefined;
}

export function writeAuditEvent(
  req: Request,
  res: Response,
  input: {
    action: string;
    target?: string;
    outcome?: 'success' | 'failure';
    details?: unknown;
  }
): void {
  try {
    const now = Date.now();
    const event: AuditEvent = {
      ts: new Date(now).toISOString(),
      requestId: (res.locals?.requestId as string | undefined) ?? undefined,
      action: input.action,
      target: input.target,
      outcome: input.outcome ?? 'success',
      actor: readPrincipal(res),
      request: {
        method: req.method,
        path: typeof req.originalUrl === 'string' ? req.originalUrl.slice(0, 256) : req.path,
        ip: readClientIp(req),
      },
      details: input.details,
    };

    // Ring buffer (fast read for ops endpoint)
    _ringBuffer.push(event);
    if (_ringBuffer.length > _maxInMemory) _ringBuffer.shift();

    // Persist (best-effort; never throw to caller)
    try {
      stmt(
        'audit.insert',
        `INSERT INTO audit_events (ts, request_id, action, target, outcome, actor_key_id, actor_scopes, req_method, req_path, req_ip, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        event.ts,
        event.requestId ?? null,
        event.action,
        event.target ?? null,
        event.outcome,
        event.actor.keyId,
        JSON.stringify(event.actor.scopes),
        event.request.method,
        event.request.path,
        event.request.ip ?? null,
        event.details !== undefined ? JSON.stringify(event.details) : null,
        now
      );
    } catch (err) {
      log.security.warn('audit-log persist_failed', err);
    }
  } catch (err) {
    // Never break caller; just log.
    log.security.warn('audit-log write_failed', err);
  }
}

export function listRecentAuditEvents(limit: number = 100): AuditEvent[] {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 0), 1000);
  // Fast path: return from ring buffer if it has enough entries (most common case).
  if (_ringBuffer.length >= safeLimit) {
    return _ringBuffer.slice(-safeLimit).reverse();
  }
  try {
    const rows = stmt(
      'audit.list',
      `SELECT ts, request_id, action, target, outcome, actor_key_id, actor_scopes,
              req_method, req_path, req_ip, details_json
       FROM audit_events
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(safeLimit) as Array<{
      ts: string;
      request_id: string | null;
      action: string;
      target: string | null;
      outcome: string;
      actor_key_id: string;
      actor_scopes: string;
      req_method: string;
      req_path: string;
      req_ip: string | null;
      details_json: string | null;
    }>;
    return rows.map((r) => {
      let scopes: string[] = [];
      try {
        scopes = JSON.parse(r.actor_scopes);
      } catch { /* ignore */ }
      let details: unknown;
      if (r.details_json) {
        try {
          details = JSON.parse(r.details_json);
        } catch { /* ignore */ }
      }
      return {
        ts: r.ts,
        requestId: r.request_id ?? undefined,
        action: r.action,
        target: r.target ?? undefined,
        outcome: (r.outcome as 'success' | 'failure'),
        actor: { keyId: r.actor_key_id, scopes },
        request: { method: r.req_method, path: r.req_path, ip: r.req_ip ?? undefined },
        details,
      };
    });
  } catch (err) {
    log.security.warn('audit-log list_failed', err);
    // Fallback to whatever is in the ring buffer.
    return _ringBuffer.slice().reverse();
  }
}

/** Used by tests. */
export function _clearAuditLogForTests(): void {
  _ringBuffer.length = 0;
  try {
    getDb().exec('DELETE FROM audit_events');
  } catch { /* ignore */ }
}
