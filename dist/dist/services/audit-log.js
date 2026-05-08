import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getApiPrincipal } from '../middleware/api-auth.js';
const recent = [];
let initialized = false;
let logPath = '';
function initAudit() {
    if (initialized)
        return;
    logPath = ensureLogPath();
    initialized = true;
}
function ensureLogPath() {
    const filePath = path.resolve(process.cwd(), config.audit.logPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return filePath;
}
function pushRecent(event) {
    recent.push(event);
    const max = config.audit.maxInMemoryEvents;
    if (recent.length > max) {
        recent.splice(0, recent.length - max);
    }
}
export function writeAuditEvent(req, res, input) {
    const principal = getApiPrincipal(res);
    const event = {
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
        fs.appendFile(logPath, `${JSON.stringify(event)}\n`, 'utf8', () => { });
    }
    catch {
        // keep request flow resilient even if audit file cannot be written
    }
}
export function listRecentAuditEvents(limit = 100) {
    const normalized = Math.min(Math.max(limit, 1), 1000);
    return recent.slice(-normalized).reverse();
}
//# sourceMappingURL=audit-log.js.map