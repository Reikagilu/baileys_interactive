#!/usr/bin/env node
/**
 * Aplica patches idempotentes em node_modules/baileys.
 *
 * Patches aplicados:
 *  1. [opencode-stanza-dedupe] em lib/Socket/messages-recv.js
 *     - Adiciona um cache TTL de IDs de stanzas já processadas para ignorar
 *       reentregas pós-reconexão (causa raiz do "🔢 Counter Error / Key
 *       already used" no libsignal, especialmente em note-to-self).
 *
 *  2. [opencode-self-session-cleanup] em lib/Socket/messages-recv.js
 *     - Quando uma mensagem note-to-self (remoteJid = JID próprio) falha a
 *       decriptação (CIPHERTEXT stub / Bad MAC), faz cleanup imediato da sessão
 *       Signal corrompida antes de entrar no loop de retry. Isso evita o loop
 *       infinito de Bad MAC que ocorre quando o WA tem várias stanzas
 *       enfileiradas para o LID próprio e o retry+pkmsg não funciona para
 *       auto-mensagens.
 *
 * Comportamento:
 *  6. [opencode-skip-self-decrypt] em lib/Utils/decode-wa-message.js
 *     - Quando o remoteJid é o próprio JID (note-to-self), pula completamente a
 *       tentativa de decriptação e marca como CIPHERTEXT stub. Elimina Bad MAC
 *       na raiz — libsignal nunca é chamada, zero ruído de logs.
 *
 * Comportamento:
 *  - Idempotente: se o marcador já estiver presente, o script sai com código 0.
 *  - Falha hard se o arquivo de destino não for encontrado ou o ponto de
 *    inserção não bater (assim a build do Docker quebra cedo em caso de
 *    upgrade do Baileys com mudança de layout).
 *
 * Uso:
 *   node scripts/patch-baileys.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'node_modules', 'baileys', 'lib', 'Socket', 'messages-recv.js');
const TARGET_DECODE = path.join(ROOT, 'node_modules', 'baileys', 'lib', 'Utils', 'decode-wa-message.js');
const TARGET_MEDIA = path.join(ROOT, 'node_modules', 'baileys', 'lib', 'Utils', 'messages-media.js');
const MARKER_UNDICI_STREAM = '[beyound-undici-stream-error-forward]';

const MARKER_DEDUPE = '[opencode-stanza-dedupe]';
const MARKER_SELF_CLEANUP = '[opencode-self-session-cleanup]';
const MARKER = MARKER_DEDUPE; // usado para idempotência do patch 1

const ANCHOR_DECLARE = `        finally {
            await sendMessageAck(node);
        }
    };
    const handleMessage = async (node) => {`;

const REPLACE_DECLARE = `        finally {
            await sendMessageAck(node);
        }
    };
    // [opencode-stanza-dedupe] Cache de IDs de stanzas já processadas para
    // evitar reprocessamento em reentregas após reconexão (causa raiz do
    // "🔢 Counter Error / Key already used" em sessões Signal, especialmente
    // note-to-self).
    const STANZA_DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 minutos
    const STANZA_DEDUPE_MAX = 5000;
    const stanzaDedupeCache = new Map();
    const handleMessage = async (node) => {`;

const ANCHOR_USE = `    const handleMessage = async (node) => {
        if (shouldIgnoreJid(node.attrs.from) && node.attrs.from !== S_WHATSAPP_NET) {
            logger.trace({ from: node.attrs.from }, 'ignored message');
            // Send a clean ACK (no error code) so the server considers the
            // message delivered. Using error 500 (UnhandledError) previously
            // caused the server to retry delivery, generating duplicate traffic.
            await sendMessageAck(node);
            return;
        }
        const encNode = getBinaryNodeChild(node, 'enc');`;

const REPLACE_USE = `    const handleMessage = async (node) => {
        if (shouldIgnoreJid(node.attrs.from) && node.attrs.from !== S_WHATSAPP_NET) {
            logger.trace({ from: node.attrs.from }, 'ignored message');
            // Send a clean ACK (no error code) so the server considers the
            // message delivered. Using error 500 (UnhandledError) previously
            // caused the server to retry delivery, generating duplicate traffic.
            await sendMessageAck(node);
            return;
        }
        const encNode = getBinaryNodeChild(node, 'enc');
        // [opencode-stanza-dedupe] Dedupe de stanzas reentregues pelo WhatsApp.
        // Quando o socket cai antes de o ACK chegar ao servidor, o WA reenvia a
        // mesma stanza após reconexão. Re-decryptar uma mensagem Signal já
        // processada avança o counter de novo (ou falha com MessageCounterError
        // = "🔢 Counter Error / Key already used"), corrompendo a sessão. Aqui
        // detectamos a reentrega pelo \`node.attrs.id\`, ack-amos limpo e
        // ignoramos o reprocessamento. TTL curto (5min) cobre a janela típica
        // de reentrega; tamanho máximo limita uso de memória.
        const stanzaId = node.attrs?.id;
        if (stanzaId && encNode) {
            if (stanzaDedupeCache.has(stanzaId)) {
                logger.debug({ id: stanzaId, from: node.attrs.from }, '[opencode-dedupe] stanza already processed; acking and skipping');
                await sendMessageAck(node);
                return;
            }
            stanzaDedupeCache.set(stanzaId, Date.now());
            if (stanzaDedupeCache.size > STANZA_DEDUPE_MAX) {
                const cutoff = Date.now() - STANZA_DEDUPE_TTL_MS;
                for (const [id, ts] of stanzaDedupeCache) {
                    if (ts < cutoff) stanzaDedupeCache.delete(id);
                    if (stanzaDedupeCache.size <= STANZA_DEDUPE_MAX * 0.8) break;
                }
            }
        }`;

// ─── Patch 2: self-session cleanup imediato em note-to-self ──────────────────

const ANCHOR_SELF_CLEANUP = `            await messageMutex.mutex(mutexKey, async () => {
                await decrypt();
                // message failed to decrypt
                if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
                    // Handle "Missing keys" - standard decryption failure
                    // Return NACK with parsing error to signal the issue
                    if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
                        return sendMessageAck(node, NACK_REASONS.ParsingError);
                    }`;

const REPLACE_SELF_CLEANUP = `            await messageMutex.mutex(mutexKey, async () => {
                await decrypt();
                // message failed to decrypt
                if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
                    // [opencode-self-session-cleanup] Cleanup imediato da sessão Signal
                    // corrompida quando a mensagem note-to-self falha a decriptação (Bad MAC
                    // / MessageCounterError). Para auto-mensagens o fluxo normal de
                    // retry+pkmsg não funciona (o WA não responde com pkmsg para o próprio
                    // número), então o Baileys fica em loop de Bad MAC indefinidamente.
                    // Ao detectar CIPHERTEXT stub + remoteJid = JID próprio, limpamos a
                    // sessão imediatamente para que a próxima entrega possa criar uma sessão
                    // nova via pre-key. Throttle de 5s por JID evita cascata de deletes.
                    {
                        const _ownId = authState?.creds?.me?.id || '';
                        const _ownLid = authState?.creds?.me?.lid || '';
                        const _ownUser = _ownId.split('@')[0].split(':')[0];
                        const _ownLidUser = _ownLid.split('@')[0].split(':')[0];
                        const _remoteJid = msg.key?.remoteJid || '';
                        const _remoteUser = _remoteJid.split('@')[0].split(':')[0];
                        const _isSelfMsg = _remoteUser && (
                            (_ownUser && _remoteUser === _ownUser) ||
                            (_ownLidUser && _remoteUser === _ownLidUser)
                        );
                        if (_isSelfMsg) {
                            // Throttle: não deletar a mesma sessão mais de 1x por 5s
                            if (!makeMessagesRecvSocket._selfCleanupRecent) {
                                makeMessagesRecvSocket._selfCleanupRecent = new Map();
                            }
                            const _now = Date.now();
                            const _last = makeMessagesRecvSocket._selfCleanupRecent.get(_remoteJid) || 0;
                            if (_now - _last > 5000) {
                                makeMessagesRecvSocket._selfCleanupRecent.set(_remoteJid, _now);
                                logger.info({ remoteJid: _remoteJid }, '[opencode-self-session-cleanup] Self note-to-self decrypt failed; cleaning session immediately');
                                getDecryptionJid(_remoteJid, signalRepository).then(decJid => {
                                    return cleanupCorruptedSession(decJid, signalRepository, logger);
                                }).catch(err => {
                                    logger.warn({ err, remoteJid: _remoteJid }, '[opencode-self-session-cleanup] cleanup failed');
                                });
                            } else {
                                logger.debug({ remoteJid: _remoteJid }, '[opencode-self-session-cleanup] throttled; skipping cleanup');
                            }
                        }
                    }
                    // Handle "Missing keys" - standard decryption failure
                    // Return NACK with parsing error to signal the issue
                    if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
                        return sendMessageAck(node, NACK_REASONS.ParsingError);
                    }`;

// ─── Patch 3: bloquear sendRetryRequest para note-to-self ────────────────────
// Para mensagens do próprio número (note-to-self), o WA não tem como reencriptar
// e responder o retry com uma nova chave pré-definida — ele apenas reenvia a
// mesma stanza corrompida, gerando loop de Bad MAC. A solução é detectar que o
// remoteJid é o próprio usuário ANTES do bloco retryMutex e enviar ACK limpo,
// abandonando a stanza corrompida. A sessão Signal já foi deletada pelo Patch 2;
// a próxima mensagem real do WA criará uma sessão nova via pre-key normal.

const MARKER_NO_RETRY_SELF = '[opencode-no-retry-self]';

// Âncora: trecho que verifica status broadcast antes do sendRetryRequest.
// Inserimos nosso early-return antes disso.
const ANCHOR_NO_RETRY_SELF = `                    // Skip retry for expired status messages (>24h old)
                    if (isJidStatusBroadcast(msg.key.remoteJid)) {`;

const REPLACE_NO_RETRY_SELF = `                    // [opencode-no-retry-self] Para note-to-self (remoteJid = próprio JID),
                    // NÃO pedir retry ao WA. O WA não consegue reencriptar mensagens enviadas
                    // para o próprio número — ele simplesmente reenvia a mesma stanza corrompida,
                    // gerando loop infinito de Bad MAC. Mandamos ACK limpo para que o WA marque
                    // a stanza como entregue e pare de reenviar. A sessão Signal já foi deletada
                    // pelo patch [opencode-self-session-cleanup]; a próxima mensagem criará nova sessão.
                    {
                        const _ownIdNR = authState?.creds?.me?.id || '';
                        const _ownLidNR = authState?.creds?.me?.lid || '';
                        const _ownUserNR = _ownIdNR.split('@')[0].split(':')[0];
                        const _ownLidUserNR = _ownLidNR.split('@')[0].split(':')[0];
                        const _remoteJidNR = msg.key?.remoteJid || '';
                        const _remoteUserNR = _remoteJidNR.split('@')[0].split(':')[0];
                        const _isSelfMsgNR = _remoteUserNR && (
                            (_ownUserNR && _remoteUserNR === _ownUserNR) ||
                            (_ownLidUserNR && _remoteUserNR === _ownLidUserNR)
                        );
                        if (_isSelfMsgNR) {
                            logger.info({ remoteJid: _remoteJidNR }, '[opencode-no-retry-self] note-to-self decrypt failed; sending clean ACK instead of retry to break loop');
                            return sendMessageAck(node);
                        }
                    }
                    // Skip retry for expired status messages (>24h old)
                    if (isJidStatusBroadcast(msg.key.remoteJid)) {`;

// ─── Patch 4: expor invalidatePeerSessionCache em messages-send.js ────────────
// O peerSessionsCache é local ao closure do makeMessagesSendSocket. Quando o
// handleCorruptedSelfSessions deleta uma sessão Signal via signalRepository,
// o cache ainda diz "true" para aquele JID — então no próximo sendMessage o
// assertSessions (interno, force=false) pula o fetch de pre-keys e a
// encriptação falha silenciosamente. Expondo invalidatePeerSessionCache podemos
// limpar a entrada do cache imediatamente após o delete da sessão.

const TARGET_SEND = path.join(ROOT, 'node_modules', 'baileys', 'lib', 'Socket', 'messages-send.js');
const MARKER_PEER_CACHE = '[opencode-invalidate-peer-cache]';

// Âncora 1: declaração de peerSessionsCache — adiciona helper logo depois
const ANCHOR_PEER_CACHE_DECL = `    const peerSessionsCache = new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    });`;

const REPLACE_PEER_CACHE_DECL = `    const peerSessionsCache = new NodeCache({
        stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    });
    // [opencode-invalidate-peer-cache] Helper para invalidar entradas do cache
    // de sessões de peers. Necessário quando deletamos uma sessão Signal
    // externamente (ex.: cleanup de note-to-self corrompido) para que o
    // próximo assertSessions (interno) detecte a ausência e busque novas
    // pre-keys, em vez de assumir que a sessão ainda existe.
    const invalidatePeerSessionCache = (jids) => {
        if (!jids || !jids.length) return;
        for (const jid of jids) {
            try {
                const signalId = signalRepository.jidToSignalProtocolAddress(jid);
                peerSessionsCache.del(signalId);
            } catch (_) {
                // jid inválido ou sem mapeamento — ignorar
            }
        }
    };`;

// Âncora 2: export — insere invalidatePeerSessionCache ao lado de assertSessions
const ANCHOR_PEER_CACHE_EXPORT = `        getUSyncDevices,
        messageRetryManager,`;

const REPLACE_PEER_CACHE_EXPORT = `        getUSyncDevices,
        invalidatePeerSessionCache,
        messageRetryManager,`;

// ─── Patch 5: tratar category='peer' + CIPHERTEXT + note-to-self ─────────────
// Os patches 2 e 3 estão dentro de `if (msg.category !== 'peer')`.
// Quando category='peer' e a decriptação falha (Bad MAC em note-to-self),
// o bloco inteiro é pulado: sem cleanup de sessão, sem ACK limpo.
// O WA reenvia a stanza indefinidamente → loop de Bad MAC.
// Solução: inserir logo após `await decrypt()` um bloco que trata
// category='peer' + CIPHERTEXT + remoteJid próprio → ACK limpo + cleanup.

const MARKER_PEER_SELF_FIX = '[opencode-peer-self-fix]';

// Âncora: logo após await decrypt() e antes do `if (... category !== 'peer')`.
// Buscamos a linha exata do bloco de comentário do Baileys que precede esse if.
// Âncora do patch 5 usa o texto APÓS o patch 2 já ter sido inserido
// (o patch 2 adiciona `// [opencode-self-session-cleanup]` logo após o `if`).
const ANCHOR_PEER_SELF_FIX = `                await decrypt();
                // message failed to decrypt
                if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
                    // [opencode-self-session-cleanup]`;

const REPLACE_PEER_SELF_FIX = `                await decrypt();
                // [opencode-peer-self-fix] Tratar category='peer' + CIPHERTEXT + note-to-self.
                // Os patches 2 e 3 ficam dentro do bloco category !== 'peer'. Quando category
                // é 'peer' e a decriptação falha (Bad MAC no LID próprio), esse bloco é pulado
                // completamente, o WA não recebe ACK e reenvia a stanza → loop infinito.
                // Detectamos aqui ANTES do if principal e emitimos ACK limpo + cleanup.
                if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category === 'peer') {
                    // [opencode-peer-self-fix]
                    const _psfOwnId = authState?.creds?.me?.id || '';
                    const _psfOwnLid = authState?.creds?.me?.lid || '';
                    const _psfOwnUser = _psfOwnId.split('@')[0].split(':')[0];
                    const _psfOwnLidUser = _psfOwnLid.split('@')[0].split(':')[0];
                    const _psfRemoteJid = msg.key?.remoteJid || '';
                    const _psfRemoteUser = _psfRemoteJid.split('@')[0].split(':')[0];
                    const _psfIsSelf = _psfRemoteUser && (
                        (_psfOwnUser && _psfRemoteUser === _psfOwnUser) ||
                        (_psfOwnLidUser && _psfRemoteUser === _psfOwnLidUser)
                    );
                    if (_psfIsSelf) {
                        // Cleanup de sessão (throttle 5s)
                        if (!makeMessagesRecvSocket._psfCleanupRecent) {
                            makeMessagesRecvSocket._psfCleanupRecent = new Map();
                        }
                        const _psfNow = Date.now();
                        const _psfLast = makeMessagesRecvSocket._psfCleanupRecent.get(_psfRemoteJid) || 0;
                        if (_psfNow - _psfLast > 5000) {
                            makeMessagesRecvSocket._psfCleanupRecent.set(_psfRemoteJid, _psfNow);
                            console.error('[opencode-peer-self-fix] peer+CIPHERTEXT note-to-self: cleaning session & acking clean for', _psfRemoteJid);
                            getDecryptionJid(_psfRemoteJid, signalRepository).then(decJid => {
                                return cleanupCorruptedSession(decJid, signalRepository, logger);
                            }).catch(() => {});
                        }
                        return sendMessageAck(node);
                    }
                }
                // message failed to decrypt
                if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
                    // [opencode-self-session-cleanup]`;

// ─── Patch 7: escrita atômica em use-multi-file-auth-state.js ────────────────
// O writeFile do Node.js trunca o arquivo antes de escrever. Se o processo for
// interrompido (SIGKILL, OOM, falha de disco) durante o write, o arquivo fica
// com 0 bytes. Para creds.json isso causa perda permanente da sessão WhatsApp.
// Solução: escrever em arquivo tmp (.tmp.<random>) e depois renomear atomicamente
// para o destino. O rename é atômico no mesmo filesystem (POSIX), garantindo que
// o destino nunca fique em estado parcialmente escrito.

const TARGET_AUTH_STATE = path.join(ROOT, 'node_modules', 'baileys', 'lib', 'Utils', 'use-multi-file-auth-state.js');
const MARKER_ATOMIC_WRITE = '[opencode-atomic-write]';

// Âncoras para o estado original do Baileys (sem modificação):
const ANCHOR_ATOMIC_WRITE_IMPORTS = `import { Mutex } from 'async-mutex';
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { join } from 'path';`;

const REPLACE_ATOMIC_WRITE_IMPORTS = `import { Mutex } from 'async-mutex';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { randomBytes } from 'crypto';
import { join } from 'path';`;

const ANCHOR_ATOMIC_WRITE_FN = `    const writeData = async (data, file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                await writeFile(filePath, JSON.stringify(data, BufferJSON.replacer));
            }
            finally {
                release();
            }
        });
    };`;

const REPLACE_ATOMIC_WRITE_FN = `    const writeData = async (data, file) => {
        const filePath = join(folder, fixFileName(file));
        const mutex = getFileLock(filePath);
        return mutex.acquire().then(async (release) => {
            try {
                // [opencode-atomic-write] Atomic write: write to a temp file then rename to the target.
                // This prevents a crash during writeFile from leaving a 0-byte (corrupted) file.
                const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');
                await writeFile(tmpPath, JSON.stringify(data, BufferJSON.replacer));
                await rename(tmpPath, filePath);
            }
            finally {
                release();
            }
        });
    };`;

// Backward-compat: âncoras alternativas para o caso em que os imports já foram modificados
// mas a função writeData ainda usa writeFile direto (estado intermediário).
const ANCHOR_ATOMIC_WRITE = ANCHOR_ATOMIC_WRITE_IMPORTS;

// ─── Execução ─────────────────────────────────────────────────────────────────

function fail(msg) {
  console.error(`[patch-baileys] ERRO: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(TARGET)) {
  fail(`arquivo alvo não encontrado: ${TARGET}. Rode 'npm ci' antes do patch.`);
}
if (!fs.existsSync(TARGET_SEND)) {
  fail(`arquivo alvo não encontrado: ${TARGET_SEND}. Rode 'npm ci' antes do patch.`);
}

let src = fs.readFileSync(TARGET, 'utf8');
let srcSend = fs.readFileSync(TARGET_SEND, 'utf8');

let srcAuthState = fs.existsSync(TARGET_AUTH_STATE) ? fs.readFileSync(TARGET_AUTH_STATE, 'utf8') : null;

if (
  src.includes(MARKER_DEDUPE) &&
  src.includes(MARKER_SELF_CLEANUP) &&
  src.includes(MARKER_NO_RETRY_SELF) &&
  src.includes(MARKER_PEER_SELF_FIX) &&
  srcSend.includes(MARKER_PEER_CACHE) &&
  (srcAuthState === null || srcAuthState.includes(MARKER_ATOMIC_WRITE)) &&
  fs.existsSync(TARGET_MEDIA) &&
  fs.readFileSync(TARGET_MEDIA, 'utf8').includes(MARKER_UNDICI_STREAM)
) {
  console.log('[patch-baileys] todos os patches já aplicados (markers presentes). Nada a fazer.');
  process.exit(0);
}

// Patch 1: stanza dedupe
if (!src.includes(MARKER_DEDUPE)) {
  if (!src.includes(ANCHOR_DECLARE)) {
    fail('âncora de declaração (handleMessage) não encontrada. Layout do Baileys mudou — atualize scripts/patch-baileys.mjs.');
  }
  if (!src.includes(ANCHOR_USE)) {
    fail('âncora de uso (encNode) não encontrada. Layout do Baileys mudou — atualize scripts/patch-baileys.mjs.');
  }
  src = src.replace(ANCHOR_DECLARE, REPLACE_DECLARE);
  src = src.replace(ANCHOR_USE, REPLACE_USE);
  if (!src.includes(MARKER_DEDUPE)) {
    fail('patch 1 (stanza-dedupe): substituição não inseriu o marker — abortando.');
  }
  console.log('[patch-baileys] patch 1 (stanza-dedupe) aplicado.');
} else {
  console.log('[patch-baileys] patch 1 (stanza-dedupe) já presente, pulando.');
}

// Patch 2: self-session cleanup
if (!src.includes(MARKER_SELF_CLEANUP)) {
  if (!src.includes(ANCHOR_SELF_CLEANUP)) {
    fail('âncora do patch 2 (self-session-cleanup) não encontrada. Layout do Baileys mudou — atualize scripts/patch-baileys.mjs.');
  }
  src = src.replace(ANCHOR_SELF_CLEANUP, REPLACE_SELF_CLEANUP);
  if (!src.includes(MARKER_SELF_CLEANUP)) {
    fail('patch 2 (self-session-cleanup): substituição não inseriu o marker — abortando.');
  }
  console.log('[patch-baileys] patch 2 (self-session-cleanup) aplicado.');
} else {
  console.log('[patch-baileys] patch 2 (self-session-cleanup) já presente, pulando.');
}

// Patch 3: no-retry-self
if (!src.includes(MARKER_NO_RETRY_SELF)) {
  if (!src.includes(ANCHOR_NO_RETRY_SELF)) {
    fail('âncora do patch 3 (no-retry-self) não encontrada. Layout do Baileys mudou — atualize scripts/patch-baileys.mjs.');
  }
  src = src.replace(ANCHOR_NO_RETRY_SELF, REPLACE_NO_RETRY_SELF);
  if (!src.includes(MARKER_NO_RETRY_SELF)) {
    fail('patch 3 (no-retry-self): substituição não inseriu o marker — abortando.');
  }
  console.log('[patch-baileys] patch 3 (no-retry-self) aplicado.');
} else {
  console.log('[patch-baileys] patch 3 (no-retry-self) já presente, pulando.');
}

// Patch 5: peer+CIPHERTEXT+note-to-self fix
if (!src.includes(MARKER_PEER_SELF_FIX)) {
  if (!src.includes(ANCHOR_PEER_SELF_FIX)) {
    fail('âncora do patch 5 (peer-self-fix) não encontrada. Layout do Baileys mudou — atualize scripts/patch-baileys.mjs.');
  }
  src = src.replace(ANCHOR_PEER_SELF_FIX, REPLACE_PEER_SELF_FIX);
  if (!src.includes(MARKER_PEER_SELF_FIX)) {
    fail('patch 5 (peer-self-fix): substituição não inseriu o marker — abortando.');
  }
  console.log('[patch-baileys] patch 5 (peer-self-fix) aplicado.');
} else {
  console.log('[patch-baileys] patch 5 (peer-self-fix) já presente, pulando.');
}

fs.writeFileSync(TARGET, src, 'utf8');
console.log('[patch-baileys] patches em messages-recv.js aplicados com sucesso em', TARGET);

// Patch 4: invalidatePeerSessionCache em messages-send.js
if (!srcSend.includes(MARKER_PEER_CACHE)) {
  if (!srcSend.includes(ANCHOR_PEER_CACHE_DECL)) {
    fail('âncora do patch 4 (peer-cache decl) não encontrada em messages-send.js. Layout do Baileys mudou — atualize scripts/patch-baileys.mjs.');
  }
  if (!srcSend.includes(ANCHOR_PEER_CACHE_EXPORT)) {
    fail('âncora do patch 4 (peer-cache export) não encontrada em messages-send.js. Layout do Baileys mudou — atualize scripts/patch-baileys.mjs.');
  }
  srcSend = srcSend.replace(ANCHOR_PEER_CACHE_DECL, REPLACE_PEER_CACHE_DECL);
  srcSend = srcSend.replace(ANCHOR_PEER_CACHE_EXPORT, REPLACE_PEER_CACHE_EXPORT);
  if (!srcSend.includes(MARKER_PEER_CACHE)) {
    fail('patch 4 (invalidate-peer-cache): substituição não inseriu o marker — abortando.');
  }
  console.log('[patch-baileys] patch 4 (invalidate-peer-cache) aplicado.');
} else {
  console.log('[patch-baileys] patch 4 (invalidate-peer-cache) já presente, pulando.');
}

fs.writeFileSync(TARGET_SEND, srcSend, 'utf8');
console.log('[patch-baileys] patch 4 aplicado com sucesso em', TARGET_SEND);

// ─── Patch 6: skip decrypt for note-to-self (decode-wa-message.js) ────────────
// Note-to-self messages are encrypted with a Signal session that doesn't exist
// on linked devices. Attempting to decrypt always fails with Bad MAC, generating
// noise in logs. We skip decryption entirely and mark as CIPHERTEXT stub.
// The ACK is handled by patch 5 (peer-self-fix) in messages-recv.js.

const MARKER_SKIP_SELF_DECRYPT = '[opencode-skip-self-decrypt]';

const ANCHOR_SKIP_SELF_DECRYPT = `        async decrypt() {
            let decryptables = 0;`;

const REPLACE_SKIP_SELF_DECRYPT = `        async decrypt() {
            // [opencode-skip-self-decrypt] Note-to-self messages arrive encrypted with a
            // Signal session that doesn't exist / is corrupted in linked devices. Attempting
            // to decrypt causes Bad MAC from libsignal → logged by interceptor → retry loop.
            // WA cannot re-encrypt for linked devices (no pre-key handshake), so decryption
            // always fails. Skip straight to CIPHERTEXT stub to avoid the error entirely.
            // The ACK is sent by [opencode-peer-self-fix] in messages-recv.js.
            {
                const _selfRemoteJid = fullMessage.key?.remoteJid || '';
                const _selfIsSelf = _selfRemoteJid &&
                    (areJidsSameUser(_selfRemoteJid, meId) || (meLid && areJidsSameUser(_selfRemoteJid, meLid)));
                if (_selfIsSelf) {
                    fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                    fullMessage.messageStubParameters = ['[opencode-skip-self-decrypt]'];
                    return;
                }
            }
            let decryptables = 0;`;

if (!fs.existsSync(TARGET_DECODE)) {
  fail('decode-wa-message.js não encontrado em ' + TARGET_DECODE);
}
let srcDecode = fs.readFileSync(TARGET_DECODE, 'utf8');

if (!srcDecode.includes(MARKER_SKIP_SELF_DECRYPT)) {
  if (!srcDecode.includes(ANCHOR_SKIP_SELF_DECRYPT)) {
    fail('âncora do patch 6 (skip-self-decrypt) não encontrada em decode-wa-message.js. Layout do Baileys mudou — atualize scripts/patch-baileys.mjs.');
  }
  srcDecode = srcDecode.replace(ANCHOR_SKIP_SELF_DECRYPT, REPLACE_SKIP_SELF_DECRYPT);
  if (!srcDecode.includes(MARKER_SKIP_SELF_DECRYPT)) {
    fail('patch 6 (skip-self-decrypt): substituição não inseriu o marker — abortando.');
  }
  fs.writeFileSync(TARGET_DECODE, srcDecode, 'utf8');
  console.log('[patch-baileys] patch 6 (skip-self-decrypt) aplicado em', TARGET_DECODE);
} else {
  console.log('[patch-baileys] patch 6 (skip-self-decrypt) já presente, pulando.');
}

// Patch 7: escrita atômica em use-multi-file-auth-state.js
if (srcAuthState === null) {
  console.log('[patch-baileys] patch 7 (atomic-write): arquivo não encontrado, pulando.');
} else if (!srcAuthState.includes(MARKER_ATOMIC_WRITE)) {
  const hasOriginalImports = srcAuthState.includes(ANCHOR_ATOMIC_WRITE_IMPORTS);
  const hasFnAnchor = srcAuthState.includes(ANCHOR_ATOMIC_WRITE_FN);
  if (!hasOriginalImports && !hasFnAnchor) {
    fail('patch 7 (atomic-write): nenhuma âncora conhecida encontrada em use-multi-file-auth-state.js. Layout do Baileys mudou — atualize scripts/patch-baileys.mjs.');
  }
  if (hasOriginalImports) {
    srcAuthState = srcAuthState.replace(ANCHOR_ATOMIC_WRITE_IMPORTS, REPLACE_ATOMIC_WRITE_IMPORTS);
  }
  if (srcAuthState.includes(ANCHOR_ATOMIC_WRITE_FN)) {
    srcAuthState = srcAuthState.replace(ANCHOR_ATOMIC_WRITE_FN, REPLACE_ATOMIC_WRITE_FN);
  }
  if (!srcAuthState.includes(MARKER_ATOMIC_WRITE)) {
    fail('patch 7 (atomic-write): substituição não inseriu o marker — abortando.');
  }
  fs.writeFileSync(TARGET_AUTH_STATE, srcAuthState, 'utf8');
  console.log('[patch-baileys] patch 7 (atomic-write) aplicado em', TARGET_AUTH_STATE);
} else {
  console.log('[patch-baileys] patch 7 (atomic-write) já presente, pulando.');
}


// Patch 8: forward undici source-stream failures into the decrypt transform.
if (!fs.existsSync(TARGET_MEDIA)) fail('messages-media.js não encontrado em ' + TARGET_MEDIA);
let srcMedia = fs.readFileSync(TARGET_MEDIA, 'utf8');
if (!srcMedia.includes(MARKER_UNDICI_STREAM)) {
  const anchor = `    return fetched.pipe(output, { end: true });`;
  const replacement = `    // [beyound-undici-stream-error-forward]
    // Readable.pipe() does not forward source errors to the destination.
    // Forward explicitly so a truncated CDN body rejects the consumer instead
    // of becoming an uncaughtException in the process.
    fetched.on('error', error => output.destroy(error));
    return fetched.pipe(output, { end: true });`;
  if (!srcMedia.includes(anchor)) fail('patch 8: âncora fetched.pipe não encontrada; layout do Baileys mudou.');
  srcMedia = srcMedia.replace(anchor, replacement);
  fs.writeFileSync(TARGET_MEDIA, srcMedia, 'utf8');
  console.log('[patch-baileys] patch 8 (undici-stream-error-forward) aplicado em', TARGET_MEDIA);
} else {
  console.log('[patch-baileys] patch 8 (undici-stream-error-forward) já presente, pulando.');
}
