import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../utils/logger.js';
function sanitizeRequestPath(pathValue) {
    if (!pathValue)
        return '/';
    if (pathValue.length > 120)
        return `${pathValue.slice(0, 120)}...`;
    return pathValue;
}
export function requestContext(req, res, next) {
    const incomingRequestId = req.header('x-request-id');
    const requestId = incomingRequestId && incomingRequestId.trim() ? incomingRequestId.trim() : randomUUID();
    const startedAt = Date.now();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => {
        if (!config.logging.requestLogsEnabled)
            return;
        const pathValue = req.originalUrl || req.url;
        if (pathValue.startsWith('/health') ||
            pathValue.startsWith('/ready') ||
            pathValue.startsWith('/metrics'))
            return;
        const durationMs = Date.now() - startedAt;
        const status = res.statusCode;
        const method = req.method;
        const path = sanitizeRequestPath(req.originalUrl || req.url);
        // Use warn for 4xx, error for 5xx, info otherwise
        const msg = `${method} ${path}  ${status}  ${durationMs}ms  reqId=${requestId}`;
        if (status >= 500) {
            log.http.error(msg);
        }
        else if (status >= 400) {
            log.http.warn(msg);
        }
        else {
            log.http.info(msg);
        }
    });
    next();
}
