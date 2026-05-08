function getRequestId(res) {
    const value = res.locals?.requestId;
    return typeof value === 'string' && value ? value : undefined;
}
export function sendOk(res, data = {}, status = 200) {
    return res.status(status).json({ ok: true, requestId: getRequestId(res), ...data });
}
export function sendError(res, status, error, message, details) {
    const payload = { ok: false, error, requestId: getRequestId(res) };
    if (message)
        payload.message = message;
    if (details !== undefined)
        payload.details = details;
    return res.status(status).json(payload);
}
//# sourceMappingURL=api-response.js.map