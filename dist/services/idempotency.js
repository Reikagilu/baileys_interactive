import { createHash } from 'node:crypto';
import { config } from '../config.js';
// LRU-cache simples: Map preserva ordem de inserção; basta deletar+reinserir para "tocar".
// Evita o O(overBy * n) do trimToLimit original.
const store = new Map();
// In-flight: armazena { expiresAt } para TTL de segurança (evita lock órfão se caller
// nunca chamar release em crash/shutdown).
const _inFlight = new Map(); // storeKey → expiresAt
// Intervalo de prune periódico (não por request): substitui pruneExpired() no hot-path.
let _pruneTimer = null;
function makeStoreKey(key, scope) {
    return createHash('sha256').update(`${scope}:${key}`).digest('hex');
}
function pruneAll() {
    const now = Date.now();
    for (const [k, entry] of store) {
        if (entry.expiresAt <= now)
            store.delete(k);
    }
    // Prune in-flight expirados (safety net para locks órfãos)
    for (const [k, expiresAt] of _inFlight) {
        if (expiresAt <= now)
            _inFlight.delete(k);
    }
}
// LRU eviction: remove a entrada mais antiga (primeira no Map = inserida há mais tempo).
function evictLRU() {
    const cap = config.idempotency.maxEntries;
    if (store.size <= cap)
        return;
    const remove = store.size - cap;
    let i = 0;
    for (const k of store.keys()) {
        if (i++ >= remove)
            break;
        store.delete(k);
    }
}
function ensurePruneTimer() {
    if (_pruneTimer)
        return;
    // Prune a cada 30s — desacoplado do hot-path
    _pruneTimer = setInterval(pruneAll, 30_000);
    _pruneTimer.unref?.();
}
export function getIdempotentResult(key, scope) {
    if (!config.idempotency.enabled)
        return null;
    if (!key)
        return null;
    ensurePruneTimer();
    const storeKey = makeStoreKey(key, scope);
    const entry = store.get(storeKey);
    if (!entry)
        return null;
    if (entry.expiresAt <= Date.now()) {
        store.delete(storeKey);
        return null;
    }
    // Verificação dupla após lock: releitura depois do acquire para fechar a race window.
    // (Este getter é chamado tanto antes do lock quanto dentro do lock para double-check.)
    return entry;
}
/**
 * Marca um request como "em processamento".
 * Retorna true se o lock foi adquirido (este request deve processar),
 * false se já há outro request em voo (deve aguardar ou retornar 409).
 *
 * O in-flight tem TTL de segurança (config.idempotency.ttlMs) para evitar
 * locks órfãos em caso de crash sem release.
 */
export function acquireIdempotencyLock(key, scope) {
    if (!config.idempotency.enabled || !key)
        return true;
    const storeKey = makeStoreKey(key, scope);
    // Checar se in-flight ainda é válido (TTL de segurança)
    const inFlightExpiry = _inFlight.get(storeKey);
    if (inFlightExpiry !== undefined) {
        if (inFlightExpiry > Date.now())
            return false; // lock ativo
        _inFlight.delete(storeKey); // expirou — limpar lock órfão
    }
    // Double-check: outro request pode ter completado entre getIdempotentResult e aqui
    const existing = store.get(storeKey);
    if (existing && existing.expiresAt > Date.now())
        return false;
    _inFlight.set(storeKey, Date.now() + (config.idempotency.ttlMs ?? 90_000));
    return true;
}
/**
 * Libera o lock de idempotência após processar o request.
 */
export function releaseIdempotencyLock(key, scope) {
    if (!config.idempotency.enabled || !key)
        return;
    _inFlight.delete(makeStoreKey(key, scope));
}
export function storeIdempotentResult(key, scope, result, statusCode = 200) {
    if (!config.idempotency.enabled || !key)
        return;
    ensurePruneTimer();
    const now = Date.now();
    const storeKey = makeStoreKey(key, scope);
    // Remover e re-inserir para manter ordem LRU
    store.delete(storeKey);
    store.set(storeKey, {
        key,
        scope,
        result,
        statusCode,
        createdAt: now,
        expiresAt: now + config.idempotency.ttlMs,
    });
    evictLRU();
}
/** Limpa estado interno — uso exclusivo em testes. */
export function _clearIdempotencyForTests() {
    store.clear();
    _inFlight.clear();
    if (_pruneTimer) {
        clearInterval(_pruneTimer);
        _pruneTimer = null;
    }
}
