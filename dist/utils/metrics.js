// Métricas em-memória + persistência leve em /app/data/metrics.json.
//
// Contadores:
//   - opencode_peer_self_fix: incrementa cada vez que uma sessão Signal
//     própria é limpa por ter CIPHERTEXT. Loop degenerativo = >10/hora.
//   - messages_upsert: incrementa por mensagem recebida no messages.upsert
//   - crash: incrementa por uncaughtException/unhandledRejection
//
// Estado em memória (process-wide) é suficiente porque:
//   - contadores resetam no restart (acceptable: é baseline)
//   - timestamps (last_message_at, last_crash_at) persistem em JSON
//
// O snapshot a cada N segundos (ou a cada update) é escrito em disco pra
// sobreviver ao próximo restart como ponto de partida.
import fs from 'node:fs';
import path from 'node:path';
const METRICS_PATH = path.resolve(process.cwd(), 'data', 'metrics.json');
const FLUSH_INTERVAL_MS = 30_000; // 30s
function emptyInstance() {
    return {
        opencode_peer_self_fix: 0,
        messages_upsert: 0,
        last_message_at: null,
        last_opencode_peer_self_fix_at: null,
        last_connected_at: null,
        connection_close_codes: {},
        reconnect_attempts: 0,
    };
}
const state = {
    started_at: new Date().toISOString(),
    last_updated_at: new Date().toISOString(),
    total_crashes: 0,
    last_crash_at: null,
    instances: {},
};
function ensureInstance(name) {
    let m = state.instances[name];
    if (!m) {
        m = emptyInstance();
        state.instances[name] = m;
    }
    return m;
}
export function recordOpencodePeerSelfFix(name) {
    const m = ensureInstance(name);
    m.opencode_peer_self_fix += 1;
    m.last_opencode_peer_self_fix_at = new Date().toISOString();
}
export function recordMessagesUpsert(name, count = 1) {
    if (count <= 0)
        return;
    const m = ensureInstance(name);
    m.messages_upsert += count;
    m.last_message_at = new Date().toISOString();
}
export function recordConnected(name) {
    ensureInstance(name).last_connected_at = new Date().toISOString();
}
export function recordConnectionClose(name, code) {
    if (code == null)
        return;
    const m = ensureInstance(name);
    m.connection_close_codes[code] = (m.connection_close_codes[code] ?? 0) + 1;
}
export function recordReconnectAttempt(name) {
    ensureInstance(name).reconnect_attempts += 1;
}
export function recordCrash() {
    state.total_crashes += 1;
    state.last_crash_at = new Date().toISOString();
}
function loadFromDisk() {
    try {
        if (!fs.existsSync(METRICS_PATH))
            return;
        const raw = fs.readFileSync(METRICS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        // Conserva timestamps e contadores do disco como baseline;
        // não restauramos counters (volta ao 0 — aceitável).
        if (parsed.last_crash_at)
            state.last_crash_at = parsed.last_crash_at;
        if (parsed.started_at)
            state.started_at = parsed.started_at;
    }
    catch {
        // ignore malformed
    }
}
function writeToDisk() {
    try {
        const dir = path.dirname(METRICS_PATH);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        state.last_updated_at = new Date().toISOString();
        fs.writeFileSync(METRICS_PATH, JSON.stringify(state, null, 2), 'utf8');
    }
    catch {
        // best-effort
    }
}
let flushTimer = null;
let installed = false;
export function installMetrics() {
    if (installed)
        return;
    installed = true;
    loadFromDisk();
    flushTimer = setInterval(writeToDisk, FLUSH_INTERVAL_MS);
    // Não bloqueia o exit
    if (flushTimer.unref)
        flushTimer.unref();
    // Flush final em exit gracioso
    process.once('SIGTERM', () => { writeToDisk(); });
    process.once('SIGINT', () => { writeToDisk(); });
}
export function getMetricsSnapshot() {
    return JSON.parse(JSON.stringify(state));
}
export const METRICS_FILE = METRICS_PATH;
