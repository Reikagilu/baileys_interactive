/**
 * Envia uma resposta de sucesso padronizada.
 * Status padrão: 200.
 */
export function sendOk(res, data, status = 200) {
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
export function sendError(res, status, error, message, details) {
    const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : undefined;
    const body = { ok: false, error };
    if (requestId)
        body.requestId = requestId;
    if (message)
        body.message = message;
    if (details !== undefined)
        body.details = details;
    return res.status(status).json(body);
}
