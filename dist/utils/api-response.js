/**
 * Envia uma resposta de sucesso padronizada.
 * Status padrão: 200.
 */
export function sendOk(res, data, status = 200) {
    return res.status(status).json({
        ok: true,
        ...data,
    });
}
/**
 * Envia uma resposta de erro padronizada.
 */
export function sendError(res, status, error, message, details) {
    const body = { ok: false, error };
    if (message)
        body.message = message;
    if (details !== undefined)
        body.details = details;
    return res.status(status).json(body);
}
