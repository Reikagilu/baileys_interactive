/**
 * Chatwoot Bridge Service
 *
 * Handles bidirectional integration between WhatsApp (Baileys) and Chatwoot.
 *
 * WhatsApp → Chatwoot:
 *   1. Find or create contact in Chatwoot
 *   2. Find or create conversation (inbox + contact)
 *   3. Send message with source_id = WhatsApp message ID (deduplication)
 *
 * Chatwoot → WhatsApp:
 *   POST /v1/integrations/:instance/chatwoot/webhook receives Chatwoot events
 *   and dispatches messages to WhatsApp via sendMessage
 */

import { getInstanceIntegrations, updateChatwootConfig, type ChatwootConfig } from './integrations.js';
import {
  listChats,
  listUnsyncedSyncMessages,
  getChatTitle,
  upsertChatMeta as msUpsertMeta,
  getContactName as msGetContactName,
  upsertContact as msUpsertContact,
} from './message-store.js';
import { getInstanceGeneral } from './instance-config.js';
import { isChatwootOriginated } from './chatwoot-tracking.js';
import { config } from '../config.js';
import { log } from '../utils/logger.js';
import {
  beginMessageSync,
  finishMessageSync,
  isMessageSynced,
  markMessageSynced,
  startSyncProgress,
  updateSyncProgress,
  finishSyncProgress,
  beginMessageSyncWithPersistence,
  finishMessageSyncWithPersistence,
  markMessageSyncedWithPersistence,
  addPendingMessage,
  getPendingMessages,
  removePendingMessage,
  updatePendingMessageRetry,
  countPendingMessages,
  prunePendingMessages,
  isSyncCancelled,
  isSyncRunning,
  appendSyncError,
} from './chatwoot-sync-store.js';

/**
 * Formats a raw digit string (e.g. "5511972798737") into a human-readable
 * phone number like "+55 11 97279 8737".
 * Falls back to "+{digits}" if it doesn't match known patterns.
 */
/**
 * Normaliza escapes literais que podem chegar no texto vindo do Chatwoot.
 * O Chatwoot por vezes envia literalmente "\n" (dois caracteres: barra + n)
 * no campo `content` — quando isso é repassado direto ao Baileys o WhatsApp
 * mostra `\n` em vez de quebra de linha. Aqui convertemos as sequências mais
 * comuns para os caracteres reais.
 *
 * Não trocamos `\\\\` (barra dupla) por barra simples para não corromper
 * conteúdo intencional (ex: caminhos Windows colados na conversa).
 */
function decodeChatwootEscapes(value: string): string {
  if (!value) return value;
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');
}

function formatPhoneDisplay(digits: string): string {
  // Brazilian numbers: 55 + 2-digit DDD + 8-9 digit number
  const br = digits.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  if (br) return `+55 ${br[1]} ${br[2]} ${br[3]}`;
  // Generic: country code (1-3 digits) + rest
  if (digits.length >= 10) return `+${digits}`;
  return digits;
}

// Cache de subjects de grupos: instance:jid → { subject, expires }
const groupSubjectCache = new Map<string, { subject: string; expires: number }>();
const GROUP_SUBJECT_CACHE_MS = 10 * 60 * 1000; // 10 minutos
const contactNameCache = new Map<string, { name: string | null; expires: number }>();
const CONTACT_NAME_CACHE_MS = 2 * 60 * 1000;
const syncContactNamesInFlight = new Map<string, Promise<{ ok: boolean; scanned: number; updated: number; skipped: number; errors: number; error?: string }>>();
export const CHATWOOT_WEBHOOK_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function normalizeChatwootWebhookSlug(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  return CHATWOOT_WEBHOOK_SLUG_PATTERN.test(raw) ? raw : '';
}

export function buildChatwootWebhookUrl(slugRaw: string): string {
  const slug = normalizeChatwootWebhookSlug(slugRaw);
  const serverOrigin = config.serverUrl || `http://localhost:${config.port}`;
  const base = `${serverOrigin}/chatwoot/webhook/${encodeURIComponent(slug)}`;
  const secret = config.security.chatwootWebhookSecret.trim();
  if (!secret) return base;
  return `${base}?secret=${encodeURIComponent(secret)}`;
}

async function resolveGroupSubject(instanceName: string, groupJid: string): Promise<string | null> {
  const cacheKey = `${instanceName}:${groupJid}`;
  const cached = groupSubjectCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.subject;

  // 1) Tenta pelo socket Baileys (mais confiável). Dynamic import evita circular dependency.
  try {
    const wa = await import('./whatsapp.js');
    const ctx = wa.getInstance(instanceName) as { sock?: { groupMetadata?: (jid: string) => Promise<{ subject?: string }> } } | undefined;
    if (ctx?.sock?.groupMetadata) {
      const meta = await ctx.sock.groupMetadata(groupJid);
      const subject = (meta?.subject || '').trim();
      if (subject) {
        groupSubjectCache.set(cacheKey, { subject, expires: Date.now() + GROUP_SUBJECT_CACHE_MS });
        return subject;
      }
    }
  } catch (err) {
    // Silenciar — pode falhar se não for membro do grupo, etc.
  }

  // 2) Fallback: SQLite (chat_meta.title)
  const stored = getChatTitle(instanceName, groupJid);
  if (stored) {
    // Rejeitar se o título armazenado for apenas o JID ou parte dele
    const rawJidUser = groupJid.split('@')[0];
    if (stored !== groupJid && stored !== rawJidUser) {
      groupSubjectCache.set(cacheKey, { subject: stored, expires: Date.now() + GROUP_SUBJECT_CACHE_MS });
      return stored;
    }
  }

  // 3) Último recurso: usar o número/ID do grupo formatado como "Grupo XXXXXXXX"
  //    para que o sync nunca retorne null (grupos devem sempre ter nome legível).
  const groupIdFallback = `Grupo ${groupJid.split('@')[0]}`;
  groupSubjectCache.set(cacheKey, { subject: groupIdFallback, expires: Date.now() + 60_000 }); // TTL curto para tentar novamente depois
  return groupIdFallback;
}

/**
 * Formata um número de telefone (dígitos puros, sem +) para exibição legível.
 * Suporta Brasil (55 + DDD + número) e formatos internacionais genéricos.
 * Retorna null se o número não tiver formato reconhecível.
 */
function formatPhoneNumber(digits: string): string | null {
  if (!digits || !/^\d+$/.test(digits)) return null;

  // Brasil: 55 + DDD (2 dígitos) + número (8 ou 9 dígitos) = 12 ou 13 dígitos
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const num = digits.slice(4);
    if (num.length === 9) {
      return `+55 (${ddd}) ${num.slice(0, 5)}-${num.slice(5)}`;
    }
    if (num.length === 8) {
      return `+55 (${ddd}) ${num.slice(0, 4)}-${num.slice(4)}`;
    }
  }

  // Internacional genérico: +CC XXXXXXXXXXXXXXX
  // Tenta separar código de país (1-3 dígitos) + resto
  if (digits.length >= 7 && digits.length <= 15) {
    return `+${digits}`;
  }

  return null;
}

// Resolve the saved contact name from multiple sources in order of trust:
//   1) Baileys store (the WhatsApp address book — has the user's saved name)
//   2) SQLite chat_meta.title (persisted pushName from previous messages)
//   3) Provided fallback (sender.name / pushName from the message itself)
//   4) Formatted phone number as last resort (never returns raw JID digits)
// Names equal to the phone number / JID are considered weak and ignored
// (so we don't end up with "+55 11 9XXXX-XXXX - 5511XXXXXXXXX").
async function resolveContactName(
  instanceName: string,
  jid: string,
  fallback?: string | null,
): Promise<string | null> {
  // Cache key uses only instanceName+jid — not the fallback — so that the
  // resolved name is reused across messages even when pushName differs slightly.
  const cacheKey = `${instanceName}:${jid}`;
  const cached = contactNameCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.name;

  const isLid = jid.endsWith('@lid');
  const number = jid.split('@')[0];

  // Para JIDs @lid, tentar resolver para o PN real via lidMapping antes de tudo.
  // O PN resolvido é usado como jid canônico para buscar nome no store de contatos.
  let canonicalJid = jid;
  let canonicalNumber = number;
  if (isLid) {
    try {
      const wa = await import('./whatsapp.js');
      const ctx = wa.getInstance(instanceName) as {
        sock?: { signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } } };
      } | undefined;
      const pn = await ctx?.sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (pn) {
        const pnUser = String(pn).split('@')[0].split(':')[0];
        if (pnUser && /^\d+$/.test(pnUser)) {
          canonicalJid = `${pnUser}@s.whatsapp.net`;
          canonicalNumber = pnUser;
        }
      }
    } catch {
      // silent — lidMapping pode não estar disponível
    }
  }

  // Helper: validate that the candidate name is meaningful.
  // Rejeita apenas JID/LID brutos — números formatados (+55 11 XXXX-XXXX) são aceitos.
  const isUsableName = (name: unknown): name is string => {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    // Rejeita se for o JID bruto (ex: "5511999@s.whatsapp.net") ou parte dele
    if (trimmed === jid || trimmed === canonicalJid) return false;
    if (trimmed === number || trimmed === canonicalNumber) return false;
    return true;
  };

  // 0) Tabela `contacts` (fonte de verdade canônica para nomes).
  //    Persistida por messaging-history.set / contacts.* / @lid resolver.
  //    Tenta tanto pelo JID original quanto pelo canônico (cobre @lid↔PN).
  try {
    const nameFromTable = msGetContactName(instanceName, canonicalJid)
      ?? (canonicalJid !== jid ? msGetContactName(instanceName, jid) : null);
    if (isUsableName(nameFromTable)) {
      const resolved = (nameFromTable as string).trim();
      contactNameCache.set(cacheKey, { name: resolved, expires: Date.now() + CONTACT_NAME_CACHE_MS });
      return resolved;
    }
  } catch {
    // best-effort — tabela contacts pode estar vazia em instâncias novas
  }

  // 1) Baileys store — the actual WhatsApp address book (volátil em memória)
  // Tenta pelo JID canônico (PN) e também pelo LID original
  try {
    const wa = await import('./whatsapp.js');
    const ctx = wa.getInstance(instanceName) as {
      sock?: { store?: { contacts?: Record<string, { name?: string; notify?: string; verifiedName?: string }> } };
    } | undefined;
    const contacts = ctx?.sock?.store?.contacts;
    const contact = contacts?.[canonicalJid] ?? (canonicalJid !== jid ? contacts?.[jid] : undefined);
    if (contact) {
      // Order: saved name (verifiedName / name) > push name (notify)
      const candidate = contact.verifiedName || contact.name || contact.notify;
      if (isUsableName(candidate)) {
        const resolved = candidate.trim();
        // Persiste no SQLite para sobreviver a restarts e ser fonte de verdade.
        try {
          msUpsertContact(instanceName, {
            jid: canonicalJid,
            lid: isLid ? jid : null,
            phoneNumber: canonicalJid.endsWith('@s.whatsapp.net') ? canonicalJid : null,
            verifiedName: contact.verifiedName ?? null,
            name: contact.name ?? null,
            notify: contact.notify ?? null,
          });
        } catch { /* best-effort */ }
        contactNameCache.set(cacheKey, { name: resolved, expires: Date.now() + CONTACT_NAME_CACHE_MS });
        return resolved;
      }
    }
  } catch (_) {
    // ignore — store may not be available
  }

  // 2) SQLite chat_meta.title (persisted from previous messages' pushName)
  const stored = getChatTitle(instanceName, jid);
  if (isUsableName(stored)) {
    const resolved = (stored as string).trim();
    contactNameCache.set(cacheKey, { name: resolved, expires: Date.now() + CONTACT_NAME_CACHE_MS });
    return resolved;
  }

  // 3) Provided fallback (current message's pushName / sender.name)
  if (isUsableName(fallback)) {
    const resolved = (fallback as string).trim();
    contactNameCache.set(cacheKey, { name: resolved, expires: Date.now() + CONTACT_NAME_CACHE_MS });
    return resolved;
  }

  // 4) Último recurso: formatar o número de telefone de forma legível (+CC DD NNNN-NNNN).
  //    Para @lid sem PN resolvido, não há número para formatar — retorna null.
  //    Garante que o contato no Chatwoot sempre tenha um nome humano, nunca o JID bruto.
  const formatted = formatPhoneNumber(canonicalNumber);
  if (formatted) {
    contactNameCache.set(cacheKey, { name: formatted, expires: Date.now() + 60_000 }); // TTL curto
    return formatted;
  }

  // Para @lid sem PN: retorna o LID formatado como +digits (evita expor o JID bruto)
  if (isLid && canonicalNumber) {
    const lidFormatted = `+${canonicalNumber}`;
    contactNameCache.set(cacheKey, { name: lidFormatted, expires: Date.now() + 60_000 });
    return lidFormatted;
  }

  contactNameCache.set(cacheKey, { name: null, expires: Date.now() + CONTACT_NAME_CACHE_MS });
  return null;
}

const REQUEST_TIMEOUT_MS = config.chatwoot.requestTimeoutMs;
const MESSAGE_SEND_TIMEOUT_MS = Math.max(REQUEST_TIMEOUT_MS, 60_000);
const MESSAGE_SEND_WITH_ATTACHMENT_TIMEOUT_MS = Math.max(REQUEST_TIMEOUT_MS, 120_000);

function isRetryableChatwootError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message === 'This operation was aborted'
    || message.includes('AbortError')
    || message.includes('Chatwoot HTTP 429:')
    || message.includes('Chatwoot HTTP 500:')
    || message.includes('Chatwoot HTTP 502:')
    || message.includes('Chatwoot HTTP 503:')
    || message.includes('Chatwoot HTTP 504:')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Chatwoot HTTP helpers ──────────────────────────────────────────────────

interface CwConfig {
  baseUrl: string;
  accountId: string;
  apiAccessToken: string;
  inboxId?: string;
}

async function cwFetch<T = unknown>(
  cfg: CwConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const url = `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}${path}`;
  const maxAttempts = Math.max(1, config.chatwoot.requestRetries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'api_access_token': cfg.apiAccessToken,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Chatwoot HTTP ${res.status}: ${text}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableChatwootError(err)) {
        throw err;
      }
      await sleep(config.chatwoot.requestRetryDelayMs * attempt);
    } finally {
      clearTimeout(t);
    }
  }

  throw new Error('unreachable_chatwoot_retry_loop');
}

async function cwFetchMultipart(
  cfg: CwConfig,
  method: string,
  path: string,
  form: FormData,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<unknown> {
  const url = `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}${path}`;
  const maxAttempts = Math.max(1, config.chatwoot.requestRetries + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          // Do NOT set Content-Type — let fetch set it automatically
          // so the multipart boundary is included correctly.
          'api_access_token': cfg.apiAccessToken,
        },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Chatwoot HTTP ${res.status}: ${text}`);
      }
      return await res.json().catch(() => null);
    } catch (err) {
      if (attempt >= maxAttempts || !isRetryableChatwootError(err)) {
        throw err;
      }
      await sleep(config.chatwoot.requestRetryDelayMs * attempt);
    } finally {
      clearTimeout(t);
    }
  }

  throw new Error('unreachable_chatwoot_retry_loop_multipart');
}

// ─── Contact helpers ─────────────────────────────────────────────────────────

interface CwContact {
  id: number;
  name: string;
  phone_number?: string;
  identifier?: string;
  thumbnail?: string;
}

const contactByIdentifierCache = new Map<string, { contact: CwContact; ts: number }>();
const contactByPhoneCache = new Map<string, { contact: CwContact; ts: number }>();
const contactResolveInFlight = new Map<string, Promise<CwContact | null>>();
const CONTACT_CACHE_TTL_MS = 2 * 60 * 1000;

function contactCacheKey(cfg: CwConfig, value: string): string {
  return `${cfg.baseUrl}|${cfg.accountId}|${value}`;
}

function getCachedContact(
  cache: Map<string, { contact: CwContact; ts: number }>,
  key: string,
): CwContact | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts > CONTACT_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return cached.contact;
}

function cacheContact(cfg: CwConfig, contact: CwContact | null): void {
  if (!contact) return;
  if (contact.identifier) {
    contactByIdentifierCache.set(contactCacheKey(cfg, contact.identifier), { contact, ts: Date.now() });
  }
  if (contact.phone_number) {
    const digits = contact.phone_number.replace(/^\+/, '');
    contactByPhoneCache.set(contactCacheKey(cfg, digits), { contact, ts: Date.now() });
  }
}

/**
 * Search contact by phone number (E.164 format) or by identifier (JID).
 * Uses /contacts/filter for phone, /contacts/search for groups.
 */
async function findContactByPhone(cfg: CwConfig, phone: string): Promise<CwContact | null> {
  const digits = phone.replace(/\D/g, '');
  const cached = getCachedContact(contactByPhoneCache, contactCacheKey(cfg, digits));
  if (cached) return cached;

  // Gera variantes para cobrir formatos nacionais/internacionais e com/sem 9 extra (BR).
  const variants = new Set<string>();
  variants.add(`+${digits}`);   // formato E.164 com +
  variants.add(digits);         // só dígitos

  // Brasil: número com 13 dígitos (55 + DDD + 9 + 8) → tentar sem o 9 extra (12 dígitos)
  if (digits.startsWith('55') && digits.length === 13) {
    const without9 = digits.slice(0, 4) + digits.slice(5); // remove o 9 após DDD
    variants.add(`+${without9}`);
    variants.add(without9);
  }
  // Brasil: número com 12 dígitos → tentar com 9 extra
  if (digits.startsWith('55') && digits.length === 12) {
    const with9 = digits.slice(0, 4) + '9' + digits.slice(4);
    variants.add(`+${with9}`);
    variants.add(with9);
  }

  // Fetch all variants in parallel — take the first non-null result.
  // This avoids the serial N-round-trips penalty when the contact exists
  // under a variant that isn't first in the list (common for BR numbers).
  const variantList = [...variants];
  const results = await Promise.allSettled(
    variantList.map(async (variant) => {
      const payload = {
        payload: [
          {
            attribute_key: 'phone_number',
            filter_operator: 'equal_to',
            values: [variant],
            query_operator: null,
          },
        ],
      };
      const res = await cwFetch<{ payload: CwContact[] }>(cfg, 'POST', '/contacts/filter', payload);
      const contact = res.payload?.[0] ?? null;
      if (!contact) throw new Error('not found');
      return contact;
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      cacheContact(cfg, r.value);
      return r.value;
    }
  }

  return null;
}

async function findContactByIdentifier(cfg: CwConfig, identifier: string): Promise<CwContact | null> {
  const cached = getCachedContact(contactByIdentifierCache, contactCacheKey(cfg, identifier));
  if (cached) return cached;
  try {
    // Use filter API for exact identifier match
    const payload = {
      payload: [
        {
          attribute_key: 'identifier',
          filter_operator: 'equal_to',
          values: [identifier],
          query_operator: null,
        },
      ],
    };
    const res = await cwFetch<{ payload: CwContact[] }>(cfg, 'POST', '/contacts/filter', payload);
    const contact = res.payload?.[0] ?? null;
    cacheContact(cfg, contact);
    return contact;
  } catch {
    // Fallback: search API (less precise but better than nothing)
    try {
      const res = await cwFetch<{ payload: CwContact[] }>(
        cfg,
        'GET',
        `/contacts/search?q=${encodeURIComponent(identifier)}&page=1`,
      );
      const contact = res.payload?.find((c: CwContact) => c.identifier === identifier) ?? null;
      cacheContact(cfg, contact);
      return contact;
    } catch {
      return null;
    }
  }
}

async function createContact(
  cfg: CwConfig,
  inboxId: number,
  params: {
    phoneNumber?: string;
    name: string;
    identifier: string;
    isGroup: boolean;
    avatarUrl?: string;
  },
): Promise<CwContact | null> {
  try {
    const data: Record<string, unknown> = {
      inbox_id: inboxId,
      name: params.name,
      identifier: params.identifier,
    };
    if (!params.isGroup && params.phoneNumber) {
      data['phone_number'] = `+${params.phoneNumber}`;
    }
    if (params.avatarUrl) {
      data['avatar_url'] = params.avatarUrl;
    }
    const res = await cwFetch<{ id?: number; payload?: { contact?: CwContact } }>(
      cfg,
      'POST',
      '/contacts',
      data,
    );
    // Chatwoot returns { payload: { contact: {...} } } on create
    const contact = (res as CwContact).id
      ? (res as CwContact)
      : (res as { payload?: { contact?: CwContact } }).payload?.contact ?? null;
    cacheContact(cfg, contact as CwContact | null);
    return contact as CwContact | null;
  } catch (err) {
    // 422 = already exists — fall back to search
    if (String(err).includes('422')) {
      return findContactByIdentifier(cfg, params.identifier);
    }
    return null;
  }
}

async function updateContactName(
  cfg: CwConfig,
  contactId: number,
  newName: string,
): Promise<boolean> {
  try {
    const updated = await cwFetch<CwContact | { payload?: { contact?: CwContact } }>(cfg, 'PATCH', `/contacts/${contactId}`, { name: newName });
    const contact = (updated as CwContact).id
      ? updated as CwContact
      : (updated as { payload?: { contact?: CwContact } }).payload?.contact ?? null;
    cacheContact(cfg, contact as CwContact | null);
    return true;
  } catch {
    return false;
  }
}

/**
 * Considera o nome "fraco" se for vazio, igual ao JID bruto ou ao user do JID (LID/PN sem @domínio).
 * Número formatado (+55 11 XXXX-XXXX) NÃO é considerado fraco — é um fallback válido.
 * Útil para detectar contatos que devem ter nome atualizado quando descobrimos o nome real.
 */
function isWeakName(name: string | undefined | null, _phoneNumber: string, jid: string): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (!trimmed) return true;
  // Rejeita JID bruto ou a parte user do JID (ex: "5511999@s.whatsapp.net" ou "5511999")
  if (trimmed === jid) return true;
  if (trimmed === jid.split('@')[0]) return true;
  // Rejeita números formatados (+55 (11) XXXXX-XXXX, +digits) — são apenas fallback,
  // qualquer nome com letras tem prioridade sobre número formatado.
  if (/^[\d\s\+\(\)\-\.]+$/.test(trimmed)) return true;
  return false;
}

async function getOrCreateContact(
  cfg: CwConfig,
  inboxId: number,
  params: {
    phoneNumber: string; // digits only, no +
    name: string;
    jid: string;
    isGroup: boolean;
    avatarUrl?: string;
  },
): Promise<CwContact | null> {
  const resolveKey = `${cfg.baseUrl}|${cfg.accountId}|${params.jid}`;
  const inFlight = contactResolveInFlight.get(resolveKey);
  if (inFlight) return inFlight;

  const request = (async (): Promise<CwContact | null> => {
    // Always search by identifier (JID) first — most reliable for deduplication
    const byIdentifier = await findContactByIdentifier(cfg, params.jid);
    if (byIdentifier) {
      // Se o nome atual é fraco e o novo é forte, atualiza
      if (isWeakName(byIdentifier.name, params.phoneNumber, params.jid) && !isWeakName(params.name, params.phoneNumber, params.jid)) {
        await updateContactName(cfg, byIdentifier.id, params.name);
        byIdentifier.name = params.name;
      }
      return byIdentifier;
    }

    // For individuals with a valid phone number, also search by phone
    if (!params.isGroup && params.phoneNumber) {
      const byPhone = await findContactByPhone(cfg, `+${params.phoneNumber}`);
      if (byPhone) {
        if (isWeakName(byPhone.name, params.phoneNumber, params.jid) && !isWeakName(params.name, params.phoneNumber, params.jid)) {
          await updateContactName(cfg, byPhone.id, params.name);
          byPhone.name = params.name;
        }
        return byPhone;
      }
    }

    // Create new contact
    return createContact(cfg, inboxId, {
      phoneNumber: params.isGroup ? undefined : params.phoneNumber,
      name: params.name,
      identifier: params.jid,
      isGroup: params.isGroup,
      avatarUrl: params.avatarUrl,
    });
  })();

  contactResolveInFlight.set(resolveKey, request);
  try {
    return await request;
  } finally {
    contactResolveInFlight.delete(resolveKey);
  }
}

// ─── Inbox helpers ────────────────────────────────────────────────────────────

interface CwInbox {
  id: number;
  name: string;
}

/** Cache: baseUrl|accountId|instanceName|nameInbox → CwInbox */
const inboxCache = new Map<string, { inbox: CwInbox; ts: number }>();
const inboxInFlight = new Map<string, Promise<CwInbox | null>>();

function inboxCacheKey(instanceName: string, cfg: CwConfig, nameInbox: string): string {
  return `${cfg.baseUrl}|${cfg.accountId}|${instanceName}|${nameInbox}`;
}

async function getInbox(instanceName: string, cfg: CwConfig, nameInbox: string): Promise<CwInbox | null> {
  const key = inboxCacheKey(instanceName, cfg, nameInbox);
  const cached = inboxCache.get(key);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.inbox;

  const inFlight = inboxInFlight.get(key);
  if (inFlight) return inFlight;

  const request = (async (): Promise<CwInbox | null> => {
    try {
      const res = await cwFetch<{ payload: CwInbox[] }>(cfg, 'GET', '/inboxes');
      const expectedInboxId = Number.parseInt(String((cfg as CwConfig & { inboxId?: string }).inboxId ?? ''), 10);
      const inbox = Number.isFinite(expectedInboxId) && expectedInboxId > 0
        ? (res.payload?.find((i: CwInbox) => i.id === expectedInboxId)
          ?? res.payload?.find((i: CwInbox) => i.name === nameInbox)
          ?? null)
        : (res.payload?.find((i: CwInbox) => i.name === nameInbox) ?? null);
      if (inbox) inboxCache.set(key, { inbox, ts: Date.now() });
      return inbox;
    } catch {
      return null;
    } finally {
      inboxInFlight.delete(key);
    }
  })();

  inboxInFlight.set(key, request);
  return request;
}

// ─── Conversation helpers ─────────────────────────────────────────────────────

interface CwConversation {
  id: number;
  status: string;
  inbox_id: number;
  meta?: {
    sender?: { id: number; name: string; identifier?: string };
  };
}

interface CwConversationMessage {
  id?: number | string;
  source_id?: string | null;
}

/** Cache: instanceName:conversationJid → conversationId
 * For groups: key = instanceName:groupJid (one conversation per group)
 * For individuals: key = instanceName:contactJid
 */
const convCache = new Map<string, { id: number; ts: number }>();
const convInFlight = new Map<string, Promise<number | null>>();
const conversationMessageSourceHitCache = new Map<string, number>();
const conversationMessageSourceInFlight = new Map<string, Promise<boolean>>();
const CONVERSATION_MESSAGE_SOURCE_CACHE_MS = 10 * 60 * 1000;

// Varredura periódica de entradas expiradas em todos os caches de módulo.
// Evita crescimento ilimitado em instâncias de longa duração com muitos contatos.
function purgeExpiredCaches(): void {
  const now = Date.now();
  for (const [k, v] of groupSubjectCache) {
    if (v.expires < now) groupSubjectCache.delete(k);
  }
  for (const [k, v] of contactNameCache) {
    if (v.expires < now) contactNameCache.delete(k);
  }
  for (const [k, v] of contactByIdentifierCache) {
    if (now - v.ts > CONTACT_CACHE_TTL_MS) contactByIdentifierCache.delete(k);
  }
  for (const [k, v] of contactByPhoneCache) {
    if (now - v.ts > CONTACT_CACHE_TTL_MS) contactByPhoneCache.delete(k);
  }
  for (const [k, v] of convCache) {
    if (now - v.ts > 30 * 60 * 1000) convCache.delete(k);
  }
  for (const [k, exp] of conversationMessageSourceHitCache) {
    if (exp < now) conversationMessageSourceHitCache.delete(k);
  }
}
// Roda a cada 15 minutos; unref() para não impedir o processo de encerrar.
setInterval(purgeExpiredCaches, 15 * 60 * 1000).unref();

function conversationMessageSourceKey(cfg: CwConfig, conversationId: number, sourceId: string): string {
  return `${cfg.baseUrl}|${cfg.accountId}|${conversationId}|${sourceId}`;
}

function extractConversationMessages(payload: unknown): CwConversationMessage[] {
  if (Array.isArray(payload)) return payload as CwConversationMessage[];
  if (!payload || typeof payload !== 'object') return [];
  const rec = payload as Record<string, unknown>;
  if (Array.isArray(rec.payload)) return rec.payload as CwConversationMessage[];
  if (Array.isArray(rec.data)) return rec.data as CwConversationMessage[];
  if (Array.isArray(rec.messages)) return rec.messages as CwConversationMessage[];
  const nested = rec.payload as Record<string, unknown> | undefined;
  if (nested) {
    if (Array.isArray(nested.messages)) return nested.messages as CwConversationMessage[];
    if (Array.isArray(nested.data)) return nested.data as CwConversationMessage[];
  }
  return [];
}

async function conversationAlreadyHasSourceId(
  cfg: CwConfig,
  conversationId: number,
  sourceId: string,
): Promise<boolean> {
  if (!sourceId) return false;
  const key = conversationMessageSourceKey(cfg, conversationId, sourceId);
  const cachedUntil = conversationMessageSourceHitCache.get(key);
  if (cachedUntil && cachedUntil > Date.now()) return true;

  // Cache negativo: se já fizemos scan desta conversa recentemente e não encontramos
  // o sourceId, evitamos repetir o scan paginado nos próximos 30s.
  const scanKey = `${cfg.baseUrl}|${cfg.accountId}|${conversationId}|__scanned__`;
  const scanCachedUntil = conversationMessageSourceHitCache.get(scanKey);
  if (scanCachedUntil && scanCachedUntil > Date.now()) return false;

  const pending = conversationMessageSourceInFlight.get(key);
  if (pending) return pending;

  const request = (async () => {
    // Hard limit: check at most 10 pages (≈200 messages) to avoid blocking for long periods.
    // Trusting the isMessageSynced() SQLite check as primary deduplication; this is a
    // secondary safety check for messages that may have arrived via other bridges.
    const MAX_PAGES = 10;
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const data = await cwFetch<unknown>(cfg, 'GET', `/conversations/${conversationId}/messages?page=${page}`);
        const messages = extractConversationMessages(data);
        if (messages.some((message) => String(message?.source_id ?? '').trim() === sourceId)) {
          conversationMessageSourceHitCache.set(key, Date.now() + CONVERSATION_MESSAGE_SOURCE_CACHE_MS);
          return true;
        }
        // Break when the page is empty — avoids hardcoding the Chatwoot page
        // size (which may not always be 20) and prevents premature termination
        // that could cause duplicate message dispatch.
        if (messages.length === 0) break;
      }
      // Cache negativo: evita repetir o scan paginado nos próximos 30s para esta conversa.
      conversationMessageSourceHitCache.set(scanKey, Date.now() + 30_000);
      return false;
    } finally {
      conversationMessageSourceInFlight.delete(key);
    }
  })();

  conversationMessageSourceInFlight.set(key, request);
  return request;
}

async function getOrCreateConversation(
  instanceName: string,
  cfg: CwConfig,
  inboxId: number,
  contactId: number,
  conversationJid: string, // group JID for groups, contact JID for individuals
  opts: { conversationPending: boolean; reopenConversation: boolean },
): Promise<number | null> {
  // Cache key uses the JID of the conversation entity (group or individual)
  const cacheKey = `${instanceName}:${conversationJid}`;
  const cached = convCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.id;

  const inFlight = convInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const request = (async (): Promise<number | null> => {
    try {
      // List existing conversations for this contact
      const convList = await cwFetch<{ payload: CwConversation[] }>(
        cfg,
        'GET',
        `/contacts/${contactId}/conversations`,
      );

      const existing = convList.payload?.filter((c) => c.inbox_id === inboxId) ?? [];

      let conv: CwConversation | undefined;
      if (opts.reopenConversation) {
        // Pick the conversation with the highest id (most recent) without
        // allocating a new sorted array — O(n) reduce instead of O(n log n) sort.
        // Guard: reduce sem initial value lança em array vazio. Se não houver
        // conversa pré-existente, seguir para o caminho de criação abaixo.
        if (existing.length > 0) {
          conv = existing.reduce((max, c) => (c.id > max.id ? c : max));
        }
      } else {
        conv = existing.find((c) => c.status !== 'resolved');
      }

      if (conv) {
        // Reopen if resolved/pending and flag is set
        if (opts.reopenConversation && conv.status !== 'open') {
          await cwFetch(cfg, 'POST', `/conversations/${conv.id}/toggle_status`, {
            status: opts.conversationPending ? 'pending' : 'open',
          }).catch((err) => {
            log.chatwoot.warn(`Falha ao reabrir conversa  id=${conv!.id}`, err?.message ?? err);
          });
        }
        convCache.set(cacheKey, { id: conv.id, ts: Date.now() });
        return conv.id;
      }

      // Create new conversation — use JID as source_id for deduplication
      const data: Record<string, unknown> = {
        contact_id: contactId,
        inbox_id: inboxId,
        source_id: conversationJid,
      };
      if (opts.conversationPending) {
        data['status'] = 'pending';
      }

      const created = await cwFetch<CwConversation>(cfg, 'POST', '/conversations', data);
      convCache.set(cacheKey, { id: created.id, ts: Date.now() });
      return created.id;
    } catch (err) {
      log.chatwoot.error('getOrCreateConversation error', err);
      return null;
    } finally {
      convInFlight.delete(cacheKey);
    }
  })();

  convInFlight.set(cacheKey, request);
  return request;
}

// ─── Message helpers ──────────────────────────────────────────────────────────

async function sendMessageToChatwoot(
  cfg: CwConfig,
  conversationId: number,
  params: {
    content: string;
    messageType: 'incoming' | 'outgoing';
    sourceId?: string;
    isPrivate?: boolean;
    contentAttributes?: Record<string, unknown>;
    attachments?: Array<{ content: string; encoding: 'base64'; filename: string; mime_type?: string }>;
  },
): Promise<void> {
  const timeoutMs = params.attachments?.length
    ? MESSAGE_SEND_WITH_ATTACHMENT_TIMEOUT_MS
    : MESSAGE_SEND_TIMEOUT_MS;

  if (params.attachments?.length) {
    // Chatwoot requires multipart/form-data for file attachments.
    // Sending base64 as JSON results in HTTP 422 because Rails expects
    // an ActionDispatch::Http::UploadedFile, not a JSON object.
    const form = new FormData();
    form.append('content', params.content || '');
    form.append('message_type', params.messageType);
    form.append('private', String(params.isPrivate ?? false));
    if (params.sourceId) form.append('source_id', params.sourceId);
    if (params.contentAttributes) {
      form.append('content_attributes', JSON.stringify(params.contentAttributes));
    }
    for (const att of params.attachments) {
      const rawBase64 = att.content.replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(rawBase64, 'base64');
      const blob = new Blob([buf], { type: att.mime_type || 'application/octet-stream' });
      form.append('attachments[]', blob, att.filename);
    }
    await cwFetchMultipart(cfg, 'POST', `/conversations/${conversationId}/messages`, form, timeoutMs);
  } else {
    await cwFetch(cfg, 'POST', `/conversations/${conversationId}/messages`, {
      content: params.content || '',
      message_type: params.messageType,
      private: params.isPrivate ?? false,
      source_id: params.sourceId,
      content_attributes: params.contentAttributes,
    }, timeoutMs);
  }
}

// ─── Main dispatch: WhatsApp message → Chatwoot ───────────────────────────────

interface NormalizedMessage {
  key: {
    id: string;
    remoteJid: string;
    fromMe: boolean;
    participant?: string;
  };
  pushName?: string;
  message_type?: string;
  messageType?: string;
  text?: string;
  quotedMessageId?: string;
  message?: Record<string, unknown>;
  timestamp?: number;
  media?: {
    kind: string;
    mimeType?: string;
    fileName?: string;
    caption?: string;
    base64?: string;
    url?: string;
    omittedReason?: 'too_large' | 'download_failed' | 'decryption_failed';
  };
  sender?: { name?: string; number?: string };
}

function extractInlineMediaFromRaw(msg: NormalizedMessage): NormalizedMessage['media'] | undefined {
  const raw = msg.message as Record<string, unknown> | undefined;
  if (!raw) return undefined;
  const candidates: Array<[string, string]> = [
    ['imageMessage', 'image'],
    ['videoMessage', 'video'],
    ['audioMessage', 'audio'],
    ['documentMessage', 'document'],
    ['stickerMessage', 'sticker'],
  ];
  for (const [nodeKey, kind] of candidates) {
    const node = raw[nodeKey];
    if (!node || typeof node !== 'object') continue;
    const rec = node as Record<string, unknown>;
    const base64 = typeof rec.base64 === 'string' ? rec.base64 : undefined;
    const mimeType = typeof rec.mimetype === 'string' ? rec.mimetype : undefined;
    const caption = typeof rec.caption === 'string' ? rec.caption : undefined;
    const fileName = typeof rec.fileName === 'string' ? rec.fileName : undefined;
    if (base64 || mimeType || caption || fileName) {
      return { kind, base64, mimeType, caption, fileName };
    }
  }
  return undefined;
}

async function loadHydratedChatMessages(
  instanceName: string,
  jid: string,
  onlyIds?: ReadonlySet<string>,
): Promise<Map<string, {
  participant?: string;
  pushName?: string;
  sender?: NormalizedMessage['sender'];
  media?: NormalizedMessage['media'];
}>> {
  try {
    const whatsapp = await import('./whatsapp.js') as {
      getInstanceChatMessagesWithMedia?: (name: string, jid: string, onlyIds?: ReadonlySet<string>) => Promise<Array<{
        id: string;
        senderName?: string;
        senderNumber?: string;
        media?: {
          kind?: string;
          mimeType?: string;
          fileName?: string;
          caption?: string;
          base64?: string;
          mediaId?: string;
          url?: string;
          omittedReason?: 'too_large' | 'download_failed' | 'decryption_failed';
        };
      }>>;
      getInstanceChatMediaBinary?: (name: string, mediaId: string) => { ok: boolean; mimeType?: string; bytes?: Buffer; error?: 'not_found' };
    };

    if (typeof whatsapp.getInstanceChatMessagesWithMedia !== 'function') {
      return new Map();
    }

    const hydrated = await whatsapp.getInstanceChatMessagesWithMedia(instanceName, jid, onlyIds);
    const map = new Map<string, {
      participant?: string;
      pushName?: string;
      sender?: NormalizedMessage['sender'];
      media?: NormalizedMessage['media'];
    }>();
    for (const item of hydrated) {
      let media = item.media
        ? {
            kind: item.media.kind || 'media',
            mimeType: item.media.mimeType,
            fileName: item.media.fileName,
            caption: item.media.caption,
            base64: item.media.base64,
            url: item.media.url,
          }
        : undefined;

      if (media && !media.base64 && item.media?.mediaId && typeof whatsapp.getInstanceChatMediaBinary === 'function') {
        const bin = whatsapp.getInstanceChatMediaBinary(instanceName, item.media.mediaId);
        if (bin.ok && bin.bytes) {
          media = {
            ...media,
            mimeType: media.mimeType || bin.mimeType,
            base64: bin.bytes.toString('base64'),
          };
        }
      }

      map.set(item.id, {
        media,
        sender: item.senderNumber ? { number: item.senderNumber, name: item.senderName } : undefined,
        pushName: item.senderName,
        participant: item.senderNumber && jid.endsWith('@g.us')
          ? `${String(item.senderNumber).replace(/[^0-9]/g, '')}@s.whatsapp.net`
          : undefined,
      });
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Called for every messages.upsert event (normalized messages list).
 * Dispatches each message to Chatwoot if integration is enabled.
 */
export async function dispatchToChatwoot(
  instanceName: string,
  messages: NormalizedMessage[],
): Promise<void> {
  // getInstanceIntegrations is synchronous (SQLite read) — no await needed.
  let cfg;
  try {
    const integrations = getInstanceIntegrations(instanceName);
    cfg = integrations.chatwoot;
  } catch {
    return;
  }

  if (!cfg.enabled || !cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken) {
    log.chatwoot.child(instanceName).debug(`dispatch skipped  enabled=${cfg.enabled}  baseUrl=${!!cfg.baseUrl}  accountId=${!!cfg.accountId}  token=${!!cfg.apiAccessToken}  inboxId="${cfg.inboxId}"  msgs=${messages.length}`);
    return;
  }

  const cwCfg: CwConfig = {
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    apiAccessToken: cfg.apiAccessToken,
    inboxId: cfg.inboxId,
  };

  const inbox = await getInbox(instanceName, cwCfg, cfg.nameInbox || 'WhatsApp');
  if (!inbox) {
    log.chatwoot.child(instanceName).warn(`Inbox "${cfg.nameInbox}" não encontrada no Chatwoot — mensagens serão retentadas`);
    for (const msg of messages) {
      const jid = String(msg.key?.remoteJid ?? '');
      const msgId = String(msg.key?.id ?? '');
      if (!msgId || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
      addPendingMessage(instanceName, msgId, JSON.stringify(msg), 'inbox_not_found');
    }
    return;
  }

  // Group messages by remoteJid so that:
  //  • Different contacts are dispatched in parallel (up to CONCURRENCY groups at once)
  //  • Messages within the same chat stay serialized to preserve order + avoid
  //    duplicate conversation creation races.
  const CONCURRENCY = 5;
  const byJid = new Map<string, NormalizedMessage[]>();
  for (const msg of messages) {
    const jid = String(msg.key?.remoteJid ?? '').trim() || '__unknown__';
    // Pular newsletters (canais de transmissão) e status broadcast logo aqui
    // para não consumir slot do worker nem persistir tentativa.
    if (jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
    const group = byJid.get(jid);
    if (group) group.push(msg);
    else byJid.set(jid, [msg]);
  }

  async function dispatchJidGroup(jidMessages: NormalizedMessage[]): Promise<void> {
    for (const msg of jidMessages) {
      const msgId = msg.key?.id;
      if (!msgId || !beginMessageSyncWithPersistence(instanceName, msgId)) continue;
      try {
        const result = await dispatchSingleMessage(instanceName, cwCfg, cfg, inbox, msg, { skipPersistedDedupCheck: true });
        if (!result.skipped && result.conversationId) {
          try {
            markMessageSyncedWithPersistence(instanceName, msgId, result.conversationId);
          } catch (dbErr) {
            log.chatwoot.child(instanceName).error(`markMessageSynced falhou para msgId=${msgId}`, dbErr);
          }
        } else if (result.skipped) {
          // Terminal ignore/dedup: persist with conversation_id=0 so history sync
          // does not reinterpret unsupported stubs and retry forever.
          markMessageSyncedWithPersistence(instanceName, msgId, 0);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.chatwoot.child(instanceName).error(`dispatch error para msgId=${msg.key?.id} — adicionando à fila de retry`, err);
        addPendingMessage(instanceName, msgId, JSON.stringify(msg), errorMsg);
      } finally {
        finishMessageSyncWithPersistence(instanceName, msgId);
      }
    }
  }

  // Process groups with bounded concurrency using a queue-based semaphore.
  const groups = [...byJid.values()];
  const queue = [...groups];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    let group;
    while ((group = queue.shift())) {
      await dispatchJidGroup(group);
    }
  });
  await Promise.allSettled(workers);
}

/**
 * Extract the best text content from a normalized message.
 * Falls back through: text → media.caption → type label
 */
function extractContent(msg: NormalizedMessage): string {
  // If text is a real message (not a placeholder like '[audio]')
  const t = msg.text;
  if (t && !t.startsWith('[')) return t;

  // Try media caption
  if (msg.media?.caption) return msg.media.caption;

  // Fall back to type-based label (preserving placeholder for non-text types)
  if (msg.media?.kind && msg.media.kind !== 'text') {
    return t ?? `[${msg.media.kind}]`;
  }

  // Try raw message fields as last resort
  const raw = msg.message as Record<string, unknown> | undefined;
  if (raw) {
    if (typeof raw.conversation === 'string' && raw.conversation) return raw.conversation;
    const ext = raw.extendedTextMessage as { text?: string } | undefined;
    if (ext?.text) return ext.text;
    const img = raw.imageMessage as { caption?: string } | undefined;
    if (img?.caption) return img.caption;
    const vid = raw.videoMessage as { caption?: string } | undefined;
    if (vid?.caption) return vid.caption;
    if (raw.audioMessage) return '[audio]';
    if (raw.stickerMessage) return '[sticker]';
    if (raw.documentMessage) {
      const doc = raw.documentMessage as { fileName?: string } | undefined;
      return doc?.fileName ? `[document: ${doc.fileName}]` : '[document]';
    }
    if (raw.locationMessage) return '[location]';
    if (raw.contactMessage) return '[contact]';
  }

  return t ?? '[message]';
}

async function dispatchSingleMessage(
  instanceName: string,
  cwCfg: CwConfig,
  cfg: Awaited<ReturnType<typeof getInstanceIntegrations>>['chatwoot'],
  inbox: CwInbox,
  msg: NormalizedMessage,
  options: { isHistorical?: boolean; skipPersistedDedupCheck?: boolean } = {},
): Promise<{ skipped: boolean; conversationId?: number }> {
  const { key, pushName, sender } = msg;
  const media = msg.media?.base64 ? msg.media : (extractInlineMediaFromRaw(msg) ?? msg.media);
  if (!key?.remoteJid || !key?.id) return { skipped: true };

  if (!options.skipPersistedDedupCheck && isMessageSynced(instanceName, key.id)) return { skipped: true };

  const remoteJid = key.remoteJid;

  // Skip broadcast/status messages
  if (remoteJid === 'status@broadcast') return { skipped: true };

  // Skip newsletter channels (canais de transmissão do WhatsApp). Não são
  // conversas bidirecionais — o Chatwoot não consegue criar contato para
  // JIDs `@newsletter` e o dispatcher fica em loop tentando.
  if (remoteJid.endsWith('@newsletter')) return { skipped: true };

  // Skip JIDs in ignoreJids list
  if (cfg.ignoreJids?.includes(remoteJid)) return { skipped: true };

  // Skip messages sent by the system itself (Chatwoot → WhatsApp replies).
  // These are tracked via markChatwootOriginated (chatwoot-tracking.ts) to prevent infinite loops.
  if (key.fromMe && isChatwootOriginated(key.id)) {
    return { skipped: true };
  }

  // Skip protocol/system messages (historySyncNotification, ephemeral settings, etc.).
  // Note: whatsapp.ts already pre-filters these before calling dispatchToChatwoot,
  // but keep this as a defensive check for syncHistoryToChatwoot path.
  const rawMsg = msg.message as Record<string, unknown> | undefined;
  if (rawMsg?.protocolMessage || rawMsg?.senderKeyDistributionMessage || rawMsg?.reactionMessage) {
    return { skipped: true };
  }

  // Skip messages with no meaningful content consistently in realtime and history.
  const msgType = msg.messageType ?? msg.message_type ?? '';
  const hasContent = (msg.text && !msg.text.startsWith('[')) || msg.media?.caption || msg.media?.base64 || msg.media?.url;
  const hasContact = Boolean(rawMsg?.contactMessage || rawMsg?.contactsArrayMessage);
  if (msg.text === '[message]' && !msg.media && !hasContact) return { skipped: true };
  const isGroup = remoteJid.endsWith('@g.us');
  const isFromMe = key.fromMe;
  // Skip unknown-type messages that carry no displayable content — these include
  // pollCreationMessage, orderMessage, productMessage, buttonsResponseMessage, etc.
  // Previously required !rawMsg, but such messages always have msg.message present,
  // so the check was never true and they would reach Chatwoot causing HTTP 422 loops.
  if (msgType === 'unknown' && !hasContent) return { skipped: true };
  // Em sync-history, mídias antigas com falha de decriptação só geram ruído.
  // Para mensagens novas, deixamos seguir para que o Chatwoot receba ao menos
  // o placeholder legível em vez de a mensagem sumir completamente.
  if (options.isHistorical && msg.media?.omittedReason === 'decryption_failed' && !msg.media?.base64) {
    return { skipped: true };
  }

  // ── Contact resolution ──
  // For groups: contact is the SENDER (participant), conversation is the GROUP
  // For individuals: contact is the remote JID (or own number for outgoing)
  //
  // For outgoing messages (fromMe=true) in individual chats:
  //   - contact = the OTHER person (remoteJid)
  //   - message_type = outgoing
  //
  // For outgoing messages in groups:
  //   - contact = the GROUP (remoteJid) as a group contact
  //   - sender label shown in message content prefix

  let contactJid: string;
  let phoneNumber: string;
  let contactName: string;
  let conversationJid: string; // key for conversation cache and source_id
  // For groups: name/number of whoever actually sent the message (for content prefix)
  let senderLabel: string | undefined;

  // Flag importContacts: quando true, prioriza nomes reais (pushName/subject); quando false, usa o número/JID puro.
  // Fonte primária é `GeneralConfig.importContacts` (mais novo). `cfg.importContacts`
  // (legacy ChatwootConfig) é mantido como fallback para instâncias ainda não migradas
  // — embora `migrateLegacyImportContactsFlag` no startup já copie para o General.
  const useRealNames =
    getInstanceGeneral(instanceName).importContacts === true
    || cfg.importContacts === true;

  if (isGroup) {
    // Group: one conversation per group, contact = the group itself
    conversationJid = remoteJid;
    contactJid = remoteJid;
    phoneNumber = ''; // groups have no phone number

    // Identify participant (sender) upfront so we can decide whether to parallelize.
    const participant = isFromMe
      ? '' // own messages in groups: no sender prefix needed (shown as outgoing)
      : (key.participant ?? '');

    // Resolver nome do grupo e do remetente em paralelo quando ambos são necessários.
    let groupSubject: string | null = null;
    if (useRealNames) {
      if (participant) {
        // Ambas as resoluções são independentes — paralelize para reduzir latência.
        const [resolvedSubject, resolvedParticipantName] = await Promise.all([
          resolveGroupSubject(instanceName, remoteJid),
          resolveContactName(instanceName, participant, sender?.name || pushName),
        ]);
        groupSubject = resolvedSubject;
        // pushName em mensagens de grupo é o nome do REMETENTE, NÃO do grupo — ignorar para o título.
        contactName = groupSubject || remoteJid.split('@')[0];

        // Identify the actual sender for message prefix
        {
          const participantNumber = participant.split('@')[0];
          const formattedPhone = formatPhoneDisplay(participantNumber);
          // Nomes "fracos" (igual ao número/JID) são filtrados por resolveContactName.
          senderLabel = resolvedParticipantName
            ? `${formattedPhone} - ${resolvedParticipantName}`
            : formattedPhone;
        }
      } else {
        // Própria mensagem ou sem participante: só precisa do subject do grupo.
        groupSubject = await resolveGroupSubject(instanceName, remoteJid);
        // pushName em mensagens de grupo é o nome do REMETENTE, NÃO do grupo — ignorar para o título.
        contactName = groupSubject || remoteJid.split('@')[0];
      }
    } else {
      // importContacts=false: usar somente o ID do grupo.
      contactName = remoteJid.split('@')[0];
      // Identify the actual sender for message prefix (sempre — é só prefixo)
      if (participant) {
        const participantNumber = participant.split('@')[0];
        senderLabel = formatPhoneDisplay(participantNumber);
      }
    }
  } else {
    // Individual: conversation is with the remote JID
    conversationJid = remoteJid;
    contactJid = remoteJid;
    phoneNumber = remoteJid.split('@')[0];

    if (useRealNames) {
      // Nome forte (com letras) vindo da mensagem: pushName ou sender.name — prioridade máxima
      const incomingName = (!isFromMe && (sender?.name || pushName)) || undefined;
      const storedTitle = getChatTitle(instanceName, remoteJid);

      if (incomingName && /[a-zA-ZÀ-ÿ]/.test(incomingName)) {
        // pushName ou sender.name tem letras: persistir tanto na tabela `contacts`
        // (fonte de verdade) quanto em chat_meta.title (cache para listagens existentes).
        try {
          msUpsertContact(instanceName, {
            jid: remoteJid,
            phoneNumber: remoteJid.endsWith('@s.whatsapp.net') ? remoteJid : null,
            notify: incomingName,
          });
        } catch { /* best-effort */ }
        msUpsertMeta(instanceName, remoteJid, { title: incomingName });
        contactName = incomingName;
      } else {
        // Sem nome forte vindo da mensagem: usar o que já está salvo (pode ser nome real ou número)
        contactName = storedTitle || incomingName || phoneNumber;
      }
    } else {
      // importContacts=false: usar somente número
      contactName = phoneNumber;
    }
  }

  // Get or create contact (for groups: the group or sender; for individuals: the other party)
  const contact = await getOrCreateContact(cwCfg, inbox.id, {
    phoneNumber,
    name: contactName,
    jid: contactJid,
    isGroup,
  });

  if (!contact) {
    log.chatwoot.child(instanceName).warn(`Não foi possível obter/criar contato para jid=${contactJid}`);
    return { skipped: true };
  }

  // Get or create conversation — keyed by conversationJid (group or individual)
  const convId = await getOrCreateConversation(
    instanceName,
    cwCfg,
    inbox.id,
    contact.id,
    conversationJid,
    {
      conversationPending: cfg.conversationPending ?? false,
      reopenConversation: cfg.reopenConversation !== false,
    },
  );

  if (!convId) {
    log.chatwoot.child(instanceName).warn(`Não foi possível obter/criar conversa para jid=${remoteJid}`);
    return { skipped: true };
  }

  // Build message content
  let content = extractContent(msg);

  // Build attachments from media base64
  let attachments: Array<{ content: string; encoding: 'base64'; filename: string; mime_type?: string }> | undefined;
  if (media?.base64 && media.kind !== 'text') {
    const ext = (media.mimeType ?? '').split('/')[1] ?? 'bin';
    const filename = media.fileName || `${media.kind}_${key.id}.${ext}`;
    attachments = [
      {
        content: media.base64.replace(/^data:[^;]+;base64,/, ''),
        encoding: 'base64',
        filename,
        mime_type: media.mimeType,
      },
    ];
    // Strip placeholder label — o anexo fala por si só
    if (content && /^\[[a-z]+(?:[:\s].*)?\]$/i.test(content.trim())) {
      content = '';
    }
  } else if (media?.kind && media.kind !== 'text') {
    // Mídia existe mas não tem base64 (expirou no WhatsApp ou não foi possível baixar).
    // Substitui o placeholder genérico por aviso legível com a legenda original, se houver.
    const label = MEDIA_KIND_LABELS[media.kind] ?? `📎 ${media.kind}`;
    const caption = media.caption ? `\n${media.caption}` : '';
    const filename = media.fileName ? ` (${media.fileName})` : '';
    content = `_${label}${filename} não disponível — mídia expirada ou não foi possível baixar._${caption}`;
  } else if (content && /^\[[a-z]+(?:[:\s].*)?\]$/i.test(content.trim())) {
    // Placeholder sem objeto media — limpa para não poluir o Chatwoot
    content = '';
  }

  // For group messages from others, prefix with sender label on its own line(s)
  // so agents know who said what. Format inspired by the screenshots:
  //   **+55 11 97279 8737 - Dra Letícia Floriano Palacios:**
  //
  //   <message body>
  // The prefix is also added when there is only an attachment (no text).
  if (isGroup && !isFromMe && senderLabel) {
    const header = `**${senderLabel}:**`;
    content = content ? `${header}\n\n${content}` : header;
  }

  // Sign outgoing messages with agent name if enabled
  if (cfg.signMessages && isFromMe) {
    // Normaliza escape sequences do delimiter (ex.: '\\n' → '\n')
    const rawDelimiter = cfg.signDelimiter ?? '\n';
    const delimiter = rawDelimiter.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t');
    const agentName = cfg.nameInbox || instanceName;
    const label = `*${agentName}:*`;
    if (content) {
      content = `${label}${delimiter}${content}`;
    } else if (attachments && attachments.length > 0) {
      // sign even when only attachment is present
      content = label;
    }
  }

  const messageType = isFromMe ? 'outgoing' : 'incoming';

  // Fallback dedup against the tenant itself: if local tracking does not know
  // about this msgId yet, ask Chatwoot whether this conversation already has a
  // message with the same WhatsApp source_id. If yes, mark locally and skip.
  // EvolutionAPI usa o formato "WAID:<id>" como source_id.
  // Manter este prefixo garante compatibilidade com instâncias Chatwoot que migraram
  // do EvolutionAPI: deduplicação, detecção de loop e filtros de bot continuam funcionando.
  const sourceId = key.id.startsWith('WAID:') ? key.id : `WAID:${key.id}`;

  if (await conversationAlreadyHasSourceId(cwCfg, convId, sourceId)) {
    markMessageSynced(instanceName, key.id, convId);
    return { skipped: true, conversationId: convId };
  }

  try {
    await sendMessageToChatwoot(cwCfg, convId, {
      content,
      messageType,
      sourceId,
      contentAttributes: {
        ...(msg.quotedMessageId ? { in_reply_to_external_id: `WAID:${msg.quotedMessageId}`, quoted_external_id: `WAID:${msg.quotedMessageId}` } : {}),
        bridged_from_whatsapp: true,
        whatsapp_message_id: key.id,
        whatsapp_instance: instanceName,
        whatsapp_remote_jid: key.remoteJid,
        whatsapp_from_me: Boolean(key.fromMe),
      },
      // Historical messages are sent as private notes so Chatwoot does NOT
      // fire outbound webhooks back to WhatsApp (prevents infinite loop)
      isPrivate: options.isHistorical ?? false,
      attachments,
    });
  } catch (err) {
    // If Chatwoot returns 404 the conversation was deleted — evict the cache so
    // the next message triggers a fresh conversation lookup/creation.
    if (String(err).includes('Chatwoot HTTP 404')) {
      const cacheKey = `${instanceName}:${conversationJid}`;
      convCache.delete(cacheKey);
      log.chatwoot.child(instanceName).warn(`Conversa ${convId} não encontrada (404) — cache evicted, próxima mensagem tentará recriar`);
    }
    throw err;
  }
  return { skipped: false, conversationId: convId };
}

// ─── Chatwoot → WhatsApp (webhook handler) ────────────────────────────────────

export interface ChatwootWebhookPayload {
  event: string;
  id?: string | number;
  message_type?: string;
  private?: boolean;
  content?: string;
  source_id?: string | null;
  content_attributes?: Record<string, unknown>;
  conversation?: {
    id: number;
    meta?: {
      sender?: {
        identifier?: string; // JID stored during contact creation
        phone_number?: string;
      };
    };
    inbox_id?: number;
    messages?: Array<{ id?: string | number; source_id?: string | null }>;
  };
  sender?: {
    type?: string; // 'agent_bot', 'agent', 'contact', 'user'
    name?: string;
    available_name?: string;
    display_name?: string;
    full_name?: string;
  };
  attachments?: Array<{
    file_type?: string;
    data_url?: string;
    download_url?: string;
    external_url?: string;
    file_url?: string;
    url?: string;
    file_name?: string;
  }>;
}

interface ParsedChatwootAttachment {
  mediaUrl: string;
  mimeType?: string;
  fileName?: string;
  /**
   * Quando true, força envio como nota de voz (PTT) no WhatsApp,
   * sobrescrevendo a auto-detecção por mimetype. Útil para áudios
   * gravados pela UI do Chatwoot, que chegam como `file_type: "audio"`
   * ou extensões `.webm`/`.m4a` produzidas pelo MediaRecorder do navegador.
   */
  voiceNote?: boolean;
}

function pickChatwootAttachmentUrl(attachment: Record<string, unknown>): string | undefined {
  const candidates = [
    attachment.data_url,
    attachment.download_url,
    attachment.external_url,
    attachment.file_url,
    attachment.url,
  ];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function normalizeAgentDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function collectNestedValuesByKeys(
  input: unknown,
  preferredKeys: Set<string>,
  fallbackKeys: Set<string>,
  seen = new WeakSet<object>(),
): { preferred: string[]; fallback: string[] } {
  const preferred: string[] = [];
  const fallback: string[] = [];

  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (seen.has(value as object)) return;
    seen.add(value as object);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeAgentDisplayName(raw);
      if (normalized) {
        if (preferredKeys.has(key)) preferred.push(normalized);
        else if (fallbackKeys.has(key)) fallback.push(normalized);
      }
      if (raw && typeof raw === 'object') visit(raw);
    }
  };

  visit(input);
  return { preferred, fallback };
}

function buildAgentNameFromPayload(payload: ChatwootWebhookPayload): string | undefined {
  const attrs = payload.content_attributes ?? {};
  const senderInfo = payload.sender as Record<string, unknown> | undefined;
  const meta = payload.conversation?.meta as Record<string, unknown> | undefined;
  const metaSender = meta?.sender as Record<string, unknown> | undefined;
  const metaAssignee = meta?.assignee as Record<string, unknown> | undefined;
  const preferredKeys = new Set([
    'available_name',
    'display_name',
    'displayName',
    'sender_available_name',
    'sender_display_name',
    'agent_display_name',
    'assignee_display_name',
    'user_display_name',
    'agentAvailableName',
    'agentDisplayName',
    'assigneeDisplayName',
    'userDisplayName',
  ]);
  const fallbackKeys = new Set([
    'sender_name',
    'agent_name',
    'assignee_name',
    'user_name',
    'name',
    'full_name',
  ]);

  const explicitDisplay = [
    attrs['sender_available_name'],
    attrs['sender_display_name'],
    attrs['agent_display_name'],
    attrs['assignee_display_name'],
    attrs['user_display_name'],
    attrs['display_name'],
    senderInfo?.available_name,
    senderInfo?.display_name,
    senderInfo?.displayName,
    metaSender?.available_name,
    metaSender?.display_name,
    metaSender?.displayName,
    metaAssignee?.available_name,
    metaAssignee?.display_name,
    metaAssignee?.displayName,
  ].map(normalizeAgentDisplayName).find(Boolean);

  if (explicitDisplay) return explicitDisplay;

  const nested = collectNestedValuesByKeys(payload, preferredKeys, fallbackKeys);
  const nestedDisplay = nested.preferred.find(Boolean);
  if (nestedDisplay) return nestedDisplay;

  const fallback = [
    attrs['sender_name'],
    attrs['agent_name'],
    attrs['assignee_name'],
    attrs['user_name'],
    senderInfo?.name,
    metaSender?.name,
    metaAssignee?.name,
    senderInfo?.full_name,
    metaSender?.full_name,
    metaAssignee?.full_name,
    ...nested.fallback,
  ].map(normalizeAgentDisplayName).find(Boolean);

  return fallback;
}

// Module-level constants — allocated once, not per call.
const MEDIA_KIND_LABELS: Readonly<Record<string, string>> = {
  image:    '🖼️ Imagem',
  video:    '🎥 Vídeo',
  audio:    '🎤 Áudio',
  document: '📄 Documento',
  sticker:  '🪄 Sticker',
};

const FILE_EXT_TO_MIME: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg', ogg: 'audio/ogg; codecs=opus', oga: 'audio/ogg; codecs=opus', opus: 'audio/ogg; codecs=opus',
  m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', webm: 'video/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', rar: 'application/x-rar-compressed',
  txt: 'text/plain', csv: 'text/csv',
};

const CHATWOOT_CATEGORY_TO_MIME: Readonly<Record<string, string>> = {
  // Quando o Chatwoot envia `file_type: "audio"` (categoria), o conteúdo é
  // tipicamente uma gravação produzida pelo MediaRecorder do navegador no
  // próprio Chatwoot. Mapeamos para `audio/ogg; codecs=opus` para que o
  // Baileys reconheça como PTT (nota de voz) ao invés de anexo de áudio.
  audio:    'audio/ogg; codecs=opus',
  video:    'video/mp4',
  image:    'image/jpeg',
  sticker:  'image/webp',
  document: 'application/octet-stream',
  file:     'application/octet-stream',
};

/**
 * Extensões de arquivo cujo conteúdo, quando vem do webhook do Chatwoot,
 * é tipicamente uma gravação ao vivo feita pela UI do agente (MediaRecorder
 * do navegador). Tratadas como nota de voz (PTT) por padrão.
 */
const CHATWOOT_VOICE_NOTE_EXTS = new Set(['ogg', 'oga', 'opus', 'webm', 'm4a', 'mp4', 'mp3']);

/**
 * Retorna true se o attachment do Chatwoot deve ser enviado como nota de voz
 * (PTT) ao WhatsApp. Heurística:
 *   - `file_type` é a categoria genérica `"audio"` (caminho mais comum), OU
 *   - extensão do filename/URL está em `CHATWOOT_VOICE_NOTE_EXTS`.
 */
function shouldChatwootAttachmentBePtt(fileType: string, fileName?: string, mediaUrl?: string): boolean {
  const ft = fileType.trim().toLowerCase();
  if (ft === 'audio') return true;

  // Quando o fileType já vem como mimetype explícito de áudio, considera PTT
  // apenas se for um codec compatível com nota de voz no WhatsApp.
  if (ft.startsWith('audio/')) {
    if (ft.includes('codecs=opus') || ft === 'audio/ogg') return true;
    // outros mimetypes de áudio (ex: audio/wav puro) NÃO são tratados como PTT
    // automaticamente; respeita a heurística do downstream.
  }

  const ext = (() => {
    const fromFileName = fileName?.split('.').pop()?.toLowerCase() ?? '';
    if (fromFileName) return fromFileName;
    if (!mediaUrl) return '';
    try {
      return new URL(mediaUrl).pathname.split('.').pop()?.toLowerCase() ?? '';
    } catch {
      return mediaUrl.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
    }
  })();

  return ext ? CHATWOOT_VOICE_NOTE_EXTS.has(ext) && (ft === 'audio' || ft === '' || ft.startsWith('audio')) : false;
}

/**
 * Chatwoot's attachment `file_type` field can be a bare category name
 * ("audio", "video", "image", "document", "sticker") rather than a full
 * MIME type. This function maps it to a sensible default MIME so downstream
 * code (sendInstanceMediaMessage) can select the right Baileys message type.
 * If the value already looks like a MIME type (contains '/') it is returned
 * as-is.
 */
function normalizeChatwootFileType(fileType: string, fileName?: string, mediaUrl?: string): string | undefined {
  const ft = fileType.trim().toLowerCase();
  if (!ft) return undefined;

  // Already a full MIME type.
  if (ft.includes('/')) return ft;

  // Try to infer from fileName or URL extension first.
  const inferExt = (): string => {
    const fromFileName = fileName?.split('.').pop()?.toLowerCase() ?? '';
    if (fromFileName) return fromFileName;
    if (!mediaUrl) return '';
    try {
      const pathname = new URL(mediaUrl).pathname;
      return pathname.split('.').pop()?.toLowerCase() ?? '';
    } catch {
      return mediaUrl.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() ?? '';
    }
  };

  const ext = inferExt();
  if (ext && FILE_EXT_TO_MIME[ext]) return FILE_EXT_TO_MIME[ext];

  return CHATWOOT_CATEGORY_TO_MIME[ft] ?? 'application/octet-stream';
}

/**
 * Process a Chatwoot webhook event.
 * Returns the JID to send to and the text, or null if not actionable.
 */
export function parseChatwootWebhook(payload: ChatwootWebhookPayload): {
  jid: string;
  text: string;
  attachments?: ParsedChatwootAttachment[];
  replyToId?: string;
  agentName?: string;
} | null {
  // Only handle new outgoing agent messages (not private notes, not bot messages)
  if (payload.event !== 'message_created') return null;
  if (payload.message_type !== 'outgoing') return null;
  if (payload.private) return null;
  const attrs = payload.content_attributes ?? {};
  if (attrs['bridged_from_whatsapp'] === true || attrs['bridge_source'] === 'whatsapp') return null;
  // Skip messages from contact themselves (would cause a loop)
  if (payload.sender?.type === 'contact' || payload.sender?.type === 'agent_bot') return null;

  const identifier = payload.conversation?.meta?.sender?.identifier;
  const phone = payload.conversation?.meta?.sender?.phone_number;

  // Resolve JID: identifier is the WhatsApp JID we stored
  let jid = identifier?.includes('@') ? identifier : null;
  if (!jid && phone) {
    // phone_number is +5511... — strip + and add @s.whatsapp.net
    jid = `${phone.replace(/^\+/, '')}@s.whatsapp.net`;
  }

  if (!jid) return null;

  // Chatwoot pode entregar texto com escapes literais (\n, \r\n) — convertemos
  // para caracteres reais para que o WhatsApp renderize quebras de linha
  // corretamente.
  const text = decodeChatwootEscapes(payload.content ?? '');
  const agentName = buildAgentNameFromPayload(payload);
  const directReplySource = [
    attrs['in_reply_to_external_id'],
    attrs['reply_to_external_id'],
    attrs['quoted_external_id'],
    attrs['source_id'],
  ].find((value) => typeof value === 'string' && value.trim()) as string | undefined;

  const internalReplyId = [
    attrs['in_reply_to'],
    attrs['in_reply_to_id'],
    attrs['reply_to'],
    attrs['reply_to_id'],
    attrs['quoted_message_id'],
  ].find((value) => typeof value === 'string' || typeof value === 'number');

  let replyToId = directReplySource?.trim();
  if (!replyToId && internalReplyId != null && Array.isArray(payload.conversation?.messages)) {
    const target = payload.conversation.messages.find((message) => String(message.id ?? '') === String(internalReplyId));
    if (target?.source_id && String(target.source_id).trim()) {
      replyToId = String(target.source_id).trim();
    }
  }

  const attachments = (payload.attachments ?? [])
    .map((attachment) => ({
      attachment,
      mediaUrl: pickChatwootAttachmentUrl(attachment as Record<string, unknown>),
    }))
    .filter((item) => typeof item.mediaUrl === 'string' && item.mediaUrl.trim())
    .map(({ attachment, mediaUrl }) => {
      const fileName = typeof attachment.file_name === 'string' ? attachment.file_name : undefined;
      const rawType  = typeof attachment.file_type === 'string' ? attachment.file_type : '';
      const voiceNote = shouldChatwootAttachmentBePtt(rawType, fileName, mediaUrl);
      // Se for nota de voz, força o mimetype para o codec aceito pelo WhatsApp,
      // mesmo se a extensão (ex: .webm/.m4a do MediaRecorder) sugerisse outra coisa.
      // Caso contrário, segue a normalização padrão.
      const mimeType = voiceNote
        ? 'audio/ogg; codecs=opus'
        : normalizeChatwootFileType(rawType, fileName, mediaUrl);
      return { mediaUrl: mediaUrl!, mimeType, fileName, voiceNote };
    });

  if (attachments.length > 0) {
    return {
      jid,
      text,
      attachments,
      replyToId,
      agentName,
    };
  }

  return { jid, text, replyToId, agentName };
}

export async function syncContactNamesToChatwoot(
  instanceName: string,
): Promise<{ ok: boolean; scanned: number; updated: number; skipped: number; errors: number; error?: string }> {
  const running = syncContactNamesInFlight.get(instanceName);
  if (running) return running;

  const request = (async (): Promise<{ ok: boolean; scanned: number; updated: number; skipped: number; errors: number; error?: string }> => {
    let cfg;
    try {
      cfg = getInstanceIntegrations(instanceName).chatwoot;
    } catch {
      return { ok: false, scanned: 0, updated: 0, skipped: 0, errors: 0, error: 'failed_to_load_config' };
    }

    if (!cfg.enabled || !cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken) {
      return { ok: false, scanned: 0, updated: 0, skipped: 0, errors: 0, error: 'chatwoot_not_configured' };
    }

    const chats = listChats(instanceName);
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    const seenJids = new Set<string>();

    for (const chat of chats) {
      const jid = String(chat.jid || '').trim();
      if (!jid || jid === 'status@broadcast') {
        skipped += 1;
        continue;
      }
      if (seenJids.has(jid)) {
        skipped += 1;
        continue;
      }
      seenJids.add(jid);

      const isGroup = jid.endsWith('@g.us');
      const isLidJid = jid.endsWith('@lid');
      const rawNumber = jid.split('@')[0];

      // Para @lid, tentar resolver PN canônico via lidMapping
      let canonicalJid = jid;
      let phoneNumber = rawNumber;
      if (isLidJid) {
        try {
          const wa = await import('./whatsapp.js');
          const ctx = wa.getInstance(instanceName) as {
            sock?: { signalRepository?: { lidMapping?: { getPNForLID?: (lid: string) => Promise<string | null> } } };
          } | undefined;
          const pn = await ctx?.sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
          if (pn) {
            const pnUser = String(pn).split('@')[0].split(':')[0];
            if (pnUser && /^\d+$/.test(pnUser)) {
              canonicalJid = `${pnUser}@s.whatsapp.net`;
              phoneNumber = pnUser;
              // Dedupe: se já processamos o PN canônico, pular o LID
              if (seenJids.has(canonicalJid)) {
                skipped += 1;
                continue;
              }
              seenJids.add(canonicalJid);
            }
          }
        } catch { /* silent */ }
      }

      const desiredName = isGroup
        ? await resolveGroupSubject(instanceName, jid)
        : await resolveContactName(instanceName, jid, chat.title || null);

      // Pular apenas se não houver nome nenhum — número formatado já é válido.
      // Nunca expor JID ou LID bruto.
      if (!desiredName) {
        skipped += 1;
        continue;
      }

      try {
        // Buscar por JID canônico (PN) e LID — o Chatwoot pode ter criado com qualquer um
        const contact = await findContactByIdentifier(cfg, canonicalJid)
          ?? (canonicalJid !== jid ? await findContactByIdentifier(cfg, jid) : null)
          ?? (!isGroup ? await findContactByPhone(cfg, `+${phoneNumber}`) : null);
        if (!contact) {
          skipped += 1;
          continue;
        }
        if (await updateContactName(cfg, contact.id, desiredName.trim())) updated += 1;
        else errors += 1;
      } catch {
        errors += 1;
      }
    }

    return { ok: true, scanned: chats.length, updated, skipped, errors };
  })();

  syncContactNamesInFlight.set(instanceName, request);
  try {
    return await request;
  } finally {
    syncContactNamesInFlight.delete(instanceName);
  }
}

// ─── Auto Create: create inbox in Chatwoot when instance connects ─────────────

/**
 * Called when a WhatsApp instance connects (connection = 'open') and autoCreate = true.
 * Creates an API inbox in Chatwoot with the configured nameInbox, then saves the inboxId back.
 * Also updates webhookSlug to the instanceName if not already set.
 */
export async function autoCreateChatwootInbox(
  instanceName: string,
  linkedNumber: string | null = null,
  force = false,
): Promise<{ ok: boolean; inboxId?: number; inboxName?: string; webhookUrl?: string; note?: string; error?: string }> {
  let cfg;
  try {
    const integrations = getInstanceIntegrations(instanceName);
    cfg = integrations.chatwoot;
  } catch {
    return { ok: false, error: 'failed_to_load_config' };
  }

  if (!cfg.enabled) return { ok: false, error: 'integration_disabled' };
  if (!force && !cfg.autoCreate) return { ok: false, error: 'autocreate_not_enabled' };
  if (!cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken) {
    log.chatwoot.child(instanceName).warn('autoCreate: configuração incompleta — baseUrl, accountId ou apiAccessToken ausentes');
    return { ok: false, error: 'missing_chatwoot_config' };
  }

  const cwCfg: CwConfig = {
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    apiAccessToken: cfg.apiAccessToken,
    inboxId: cfg.inboxId,
  };

  const inboxName = cfg.nameInbox || instanceName;

  try {
    // Check if inbox already exists
    const inboxesRes = await cwFetch<{ payload: CwInbox[] }>(cwCfg, 'GET', '/inboxes');
    const existing = inboxesRes.payload?.find((i: CwInbox) => i.name === inboxName);

    let inbox: CwInbox;
    if (existing) {
      inbox = existing;
      log.chatwoot.child(instanceName).info(`autoCreate: inbox "${inboxName}" já existe  id=${inbox.id}`);
    } else {
      // Create API inbox
      const created = await cwFetch<{ id: number; name: string }>(cwCfg, 'POST', '/inboxes', {
        name: inboxName,
        channel: {
          type: 'api',
          webhook_url: '',  // will be updated below
        },
      });
      inbox = { id: created.id, name: created.name };
      log.chatwoot.child(instanceName).success(`autoCreate: inbox "${inboxName}" criada  id=${inbox.id}`);
    }

    // Determine webhook slug: use existing or default to instanceName
    const slug = cfg.webhookSlug?.trim() || instanceName;

    // Patch inbox webhook_url with our endpoint
    // We need the origin from config — use baseUrl of the local server
    // The webhook URL is built from process.env or a default
    const webhookUrl = buildChatwootWebhookUrl(slug);

    try {
      await cwFetch(cwCfg, 'PATCH', `/inboxes/${inbox.id}`, {
        channel: { webhook_url: webhookUrl },
      });
      log.chatwoot.child(instanceName).info(`autoCreate: webhook_url configurado  url=${webhookUrl}`);
    } catch (err) {
      // Non-fatal: log but continue
      log.chatwoot.child(instanceName).warn('autoCreate: não foi possível atualizar webhook_url', err);
    }

    // Save inboxId and webhookSlug back to config (use static import — already imported at top).
    updateChatwootConfig(instanceName, {
      inboxId: String(inbox.id),
      webhookSlug: slug,
    });

    // Update inbox cache
    inboxCache.set(inboxCacheKey(instanceName, cfg, inbox.name), { inbox, ts: Date.now() });

    return { ok: true, inboxId: inbox.id, inboxName: inbox.name, webhookUrl };

  } catch (err) {
    log.chatwoot.child(instanceName).error('autoCreate error — falha ao criar/configurar inbox no Chatwoot', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Conversation cache invalidation ─────────────────────────────────────────

export function invalidateConversationCache(instanceName: string): void {
  let sourceCachePrefix: string | null = null;
  try {
    const integrations = getInstanceIntegrations(instanceName);
    const cfg = integrations.chatwoot;
    if (cfg.baseUrl && cfg.accountId) {
      sourceCachePrefix = `${cfg.baseUrl}|${cfg.accountId}|`;
    }
  } catch {
    sourceCachePrefix = null;
  }
  for (const key of convCache.keys()) {
    if (key.startsWith(`${instanceName}:`)) {
      convCache.delete(key);
    }
  }
  for (const key of convInFlight.keys()) {
    if (key.startsWith(`${instanceName}:`)) {
      convInFlight.delete(key);
    }
  }
  for (const key of inboxCache.keys()) {
    if (key.includes(`|${instanceName}|`)) {
      inboxCache.delete(key);
    }
  }
  for (const key of inboxInFlight.keys()) {
    if (key.includes(`|${instanceName}|`)) {
      inboxInFlight.delete(key);
    }
  }
  for (const key of conversationMessageSourceHitCache.keys()) {
    if (sourceCachePrefix && key.startsWith(sourceCachePrefix)) {
      conversationMessageSourceHitCache.delete(key);
    }
  }
  for (const key of conversationMessageSourceInFlight.keys()) {
    if (sourceCachePrefix && key.startsWith(sourceCachePrefix)) {
      conversationMessageSourceInFlight.delete(key);
    }
  }
}

// ─── History sync ─────────────────────────────────────────────────────────────

/**
 * Syncs stored messages from SQLite to Chatwoot.
 * @param instanceName - WhatsApp instance name
 * @param jid - Optional: sync only this JID. If omitted, syncs all chats.
 * @param limitPerChat - Max messages per chat (default 200)
 */
export async function syncHistoryToChatwoot(
  instanceName: string,
  jid?: string,
  limitPerChat = 200,
  trigger: 'manual' | 'connect' = 'manual',
): Promise<{ ok: boolean; synced: number; errors: number; skipped?: number; cancelled?: boolean; error?: string }> {
  const { getInstance } = await import('./whatsapp.js');
  const isInstanceConnected = () => getInstance(instanceName)?.status === 'connected';

  // Reject concurrent runs
  if (isSyncRunning(instanceName)) {
    return { ok: false, synced: 0, errors: 0, error: 'A sync is already running for this instance' };
  }

  // getInstanceIntegrations is synchronous — no await needed.
  let cfg;
  try {
    const integrations = getInstanceIntegrations(instanceName);
    cfg = integrations.chatwoot;
  } catch (e) {
    return { ok: false, synced: 0, errors: 0, error: 'Failed to load integrations' };
  }

  if (!cfg.enabled || !cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken) {
    return { ok: false, synced: 0, errors: 0, error: 'Chatwoot not configured or disabled' };
  }

  // Respeita a flag Import Messages — se desativada, sync de histórico é bloqueado
  if (cfg.importMessages === false) {
    return { ok: false, synced: 0, errors: 0, error: 'Import Messages disabled — enable it in the Chatwoot settings to sync history' };
  }

  const cwCfg: CwConfig = {
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    apiAccessToken: cfg.apiAccessToken,
    inboxId: cfg.inboxId,
  };

  // Calculate afterTs from daysLimitImportMessages (0 = no limit)
  const days = cfg.daysLimitImportMessages ?? 7;
  const afterTs = days > 0
    ? Date.now() - days * 24 * 60 * 60 * 1000
    : undefined;

  // Use a modified cfg with signMessages=false for historical messages
  // (they are real past messages, not agent replies — signing would corrupt content)
  const historyCfg = { ...cfg, signMessages: false };

  // Determine which chats to sync
  let chats: Array<{ jid: string; title?: string | null; lastTimestamp?: number | null }>;
  if (jid) {
    chats = [{ jid }];
  } else {
    chats = listChats(instanceName);
    if (afterTs !== undefined) {
      chats = chats.filter((chat) => (chat.lastTimestamp ?? 0) >= afterTs);
    }
  }

  // Initialize progress
  startSyncProgress(instanceName, trigger, days);
  updateSyncProgress(instanceName, { totalChats: chats.length });

  if (!isInstanceConnected()) {
    finishSyncProgress(instanceName, 'cancelled', 'instance_not_connected');
    return { ok: false, synced: 0, errors: 0, skipped: 0, cancelled: true, error: 'instance_not_connected' };
  }

  if (chats.length === 0) {
    finishSyncProgress(instanceName, 'completed');
    log.chatwoot.child(instanceName).info('sync-history concluído  synced=0  errors=0  skipped=0  chats=0');
    return { ok: true, synced: 0, errors: 0, skipped: 0 };
  }

  let synced = 0;
  let errors = 0;
  let skipped = 0;
  let cancelled = false;
  let progressDirty = false;

  const flushProgress = (force = false) => {
    if (!force && !progressDirty) return;
    updateSyncProgress(instanceName, {
      syncedMessages: synced,
      skippedMessages: skipped,
      errorCount: errors,
    });
    progressDirty = false;
  };

  try {
    const inbox = await getInbox(instanceName, cwCfg, cfg.nameInbox || 'WhatsApp');
    if (!inbox) {
      finishSyncProgress(instanceName, 'failed', `Inbox "${cfg.nameInbox}" not found`);
      return { ok: false, synced: 0, errors: 0, error: `Inbox "${cfg.nameInbox}" not found` };
    }

    for (let i = 0; i < chats.length; i++) {
      // Check cancellation between chats
      if (isSyncCancelled(instanceName) || !isInstanceConnected()) {
        cancelled = true;
        break;
      }

      const chat = chats[i];
      let chatSynced = 0;
      let chatSkipped = 0;
      let chatErrors = 0;
      const attemptedIds = new Set<string>();

      const chatTitle = chat.title || getChatTitle(instanceName, chat.jid);
      updateSyncProgress(instanceName, {
        currentChatJid: chat.jid,
        currentChatTitle: chatTitle,
        processedChats: i,
        totalMessages: 0,
      });

      while (true) {
        const fetchLimit = limitPerChat + attemptedIds.size;
        const candidates = listUnsyncedSyncMessages(instanceName, chat.jid, fetchLimit, afterTs);
        const batch = candidates
          .filter((stored) => !attemptedIds.has(stored.id))
          .slice(0, limitPerChat);
        if (batch.length === 0) {
          if (chatSynced === 0 && chatSkipped === 0 && chatErrors === 0) {
            updateSyncProgress(instanceName, { processedChats: i + 1 });
          }
          break;
        }

        updateSyncProgress(instanceName, {
          currentChatJid: chat.jid,
          currentChatTitle: chatTitle,
          processedChats: i,
          totalMessages: chatSynced + chatSkipped + chatErrors + batch.length,
        });

        const hydrateIds = new Set(
          batch
            .filter((stored) => {
              if (stored.media) return true;
              if (chat.jid.endsWith('@g.us')) return true;
              if (!stored.senderName && !stored.senderNumber) return true;
              return false;
            })
            .map((stored) => stored.id),
        );
        const hydratedById = hydrateIds.size > 0
          ? await loadHydratedChatMessages(instanceName, chat.jid, hydrateIds)
          : new Map();

        batch.sort((a, b) => a.timestamp - b.timestamp);

        for (const stored of batch) {
          attemptedIds.add(stored.id);
        // Check cancellation inside inner loop too
          if (isSyncCancelled(instanceName) || !isInstanceConnected()) {
            cancelled = true;
            break;
          }

          if (!beginMessageSync(instanceName, stored.id, true)) {
            skipped++;
            chatSkipped++;
            progressDirty = true;
            if ((synced + skipped + errors) % 10 === 0) flushProgress();
            continue;
          }

          const participantJid = chat.jid.endsWith('@g.us') && !stored.fromMe && stored.senderNumber
            ? `${stored.senderNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`
            : undefined;
          const hydrated = hydratedById.get(stored.id);
          const hydratedParticipant = hydrated?.participant;
          const hydratedMedia = hydrated?.media as NormalizedMessage['media'] | undefined;
          const hydratedSender = hydrated?.sender as NormalizedMessage['sender'] | undefined;
          const hydratedPushName = typeof hydrated?.pushName === 'string' ? hydrated.pushName : undefined;

          const normalized: NormalizedMessage = {
            key: {
              remoteJid: chat.jid,
              fromMe: stored.fromMe,
              id: stored.id,
              participant: hydratedParticipant || participantJid,
            },
            pushName: hydratedPushName || stored.senderName || undefined,
            text: stored.text || undefined,
            messageType: typeof hydratedMedia?.kind === 'string'
              ? hydratedMedia.kind
              : typeof stored.media?.kind === 'string'
                ? stored.media.kind
                : (stored.media ? 'media' : 'text'),
            sender: hydratedSender || (stored.senderNumber
              ? { number: stored.senderNumber, name: stored.senderName ?? undefined }
              : undefined),
            timestamp: stored.timestamp,
            quotedMessageId: stored.quotedMessageId,
            media: hydratedMedia || (stored.media as NormalizedMessage['media']),
            message: undefined,
          };

          try {
            const result = await dispatchSingleMessage(instanceName, cwCfg, historyCfg, inbox, normalized, {
              isHistorical: true,
              skipPersistedDedupCheck: true,
            });
            if (!result.skipped && result.conversationId) {
              try {
                markMessageSynced(instanceName, stored.id, result.conversationId);
              } catch (dbErr) {
                log.chatwoot.child(instanceName).error(`markMessageSynced falhou para id=${stored.id} — mensagem enviada mas dedup não salvo`, dbErr);
              }
              synced++;
              chatSynced++;
              progressDirty = true;
            } else {
              skipped++;
              chatSkipped++;
              progressDirty = true;
            }
            if ((synced + skipped + errors) % 10 === 0) flushProgress();
          } catch (err) {
            errors++;
            chatErrors++;
            progressDirty = true;
            const errMsg = (err as Error)?.message || String(err);
            // Registra na lista detalhada (popup da UI lê isso) e atualiza
            // contadores. `appendSyncError` já incrementa errorCount, então
            // recompomos a partir de `errors` (fonte da verdade local) para
            // manter consistência mesmo após restarts/concorrência.
            appendSyncError(instanceName, {
              jid: chat.jid,
              chatTitle,
              msgId: stored.id,
              error: errMsg,
              scope: 'history-dispatch',
            });
            updateSyncProgress(instanceName, {
              syncedMessages: synced,
              skippedMessages: skipped,
              errorCount: errors,
              lastError: errMsg,
            });
            progressDirty = false;
            log.chatwoot.child(instanceName).error(`sync-history error para id=${stored.id}`, errMsg);
          } finally {
            finishMessageSync(instanceName, stored.id);
          }

          // Throttle adaptativo:
          //   - delay base entre mensagens (default 250ms) para não saturar
          //     a API do Chatwoot e o I/O local;
          //   - pausa maior a cada `syncBatchSize` mensagens processadas
          //     (default 1s a cada 50) — alivia o event loop e dá espaço para
          //     o resto da aplicação responder rápido durante o sync.
          await new Promise((r) => setTimeout(r, config.chatwoot.syncMessageDelayMs));
          const processed = synced + skipped + errors;
          if (processed > 0 && processed % config.chatwoot.syncBatchSize === 0) {
            await new Promise((r) => setTimeout(r, config.chatwoot.syncBatchPauseMs));
          }
        }

        if (cancelled) break;
        if (candidates.length < fetchLimit && batch.length < limitPerChat) break;
      }

      flushProgress(true);
      updateSyncProgress(instanceName, { processedChats: i + 1 });

      if (cancelled) break;
    }
  } catch (err) {
    finishSyncProgress(instanceName, 'failed', (err as Error).message);
    log.chatwoot.child(instanceName).error('sync-history FATAL — sincronização interrompida por erro crítico', err);
    return { ok: false, synced, errors, skipped, error: (err as Error).message };
  }

  if (cancelled) {
    finishSyncProgress(instanceName, 'cancelled');
    log.chatwoot.child(instanceName).warn(`sync-history cancelado  synced=${synced}  errors=${errors}  skipped=${skipped}  days=${days}`);
    return { ok: true, synced, errors, skipped, cancelled: true };
  }

  finishSyncProgress(instanceName, 'completed');
  log.chatwoot.child(instanceName).success(`sync-history concluído  synced=${synced}  errors=${errors}  skipped=${skipped}  days=${days}  trigger=${trigger}`);
  return { ok: true, synced, errors, skipped };
}

// ─── Worker de Retry (Zero Perda de Mensagens) ──────────────────────────────
// Processa a fila de mensagens pendentes que falharam ao enviar.
// Garante que nenhuma mensagem seja perdida mesmo em falhas temporárias.

const RETRY_INTERVAL_MS = 10_000; // 10 segundos
const RETRY_BATCH_SIZE = 20;
let _retryWorkerRunning = false;

async function processRetryBatch(): Promise<void> {
  const pending = getPendingMessages(RETRY_BATCH_SIZE);
  if (pending.length === 0) return;

  log.chatwoot.info(`Retry batch: ${pending.length} mensagens pendentes`);

  for (const item of pending) {
    const { id, instance, msgId, payload, attempt, lastError } = item;

    // Payload corrompido (truncado por crash, etc.) bloqueia todo o batch indefinidamente
    // sem este try/catch, pois o loop for seria abortado e o item jamais removido.
    let msg: NormalizedMessage;
    try {
      msg = JSON.parse(payload) as NormalizedMessage;
    } catch {
      log.chatwoot.error(`Retry: payload corrompido para msgId=${msgId} instance=${instance} — removendo da fila`);
      removePendingMessage(id);
      continue;
    }

    // Get instance config (synchronous — no await needed).
    let cfg: ChatwootConfig | undefined;
    try {
      const integrations = getInstanceIntegrations(instance);
      cfg = integrations.chatwoot;
    } catch {
      removePendingMessage(id);
      continue;
    }

    if (!cfg.enabled || !cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken) {
      removePendingMessage(id);
      continue;
    }

    const cwCfg: CwConfig = {
      baseUrl: cfg.baseUrl,
      accountId: cfg.accountId,
      apiAccessToken: cfg.apiAccessToken,
      inboxId: cfg.inboxId,
    };

    const inbox = await getInbox(instance, cwCfg, cfg.nameInbox || 'WhatsApp');
    if (!inbox) {
      updatePendingMessageRetry(id, attempt, 'inbox não encontrado');
      continue;
    }

    try {
      const result = await dispatchSingleMessage(instance, cwCfg, cfg, inbox, msg, { skipPersistedDedupCheck: true });
      if (!result.skipped && result.conversationId) {
        markMessageSyncedWithPersistence(instance, msgId, result.conversationId);
        removePendingMessage(id);
        log.chatwoot.child(instance).success(`Retry sukses  msgId=${msgId}  attempt=${attempt + 1}`);
      } else if (result.skipped) {
        markMessageSyncedWithPersistence(instance, msgId, 0);
        removePendingMessage(id);
      } else {
        updatePendingMessageRetry(id, attempt, 'no_conversation');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      updatePendingMessageRetry(id, attempt, errorMsg);
      log.chatwoot.child(instance).warn(`Retry falhou  msgId=${msgId}  attempt=${attempt + 1}  error=${errorMsg}`);
    }
  }
}

function startRetryWorker(): void {
  if (_retryWorkerRunning) return;
  _retryWorkerRunning = true;

  log.chatwoot.info(`Worker de retry iniciado (interval=${RETRY_INTERVAL_MS}ms)`);

  // Força inicialização do DB para que countPendingMessages funcione corretamente
  // mesmo que nenhuma mensagem tenha chegado desde o restart (quando _db ainda é null).
  try { countPendingMessages(); } catch { /* ignore */ }

  let _retryTick = 0;
  setInterval(async () => {
    try {
      _retryTick++;
      // A cada 100 ticks (~1000s) prune mensagens expiradas da fila para evitar
      // retry infinito de mensagens mortas (sem this, entradas com attempt>10
      // são filtradas por getPendingMessages mas ficam consumindo espaço no DB).
      if (_retryTick % 100 === 0) {
        try { prunePendingMessages(); } catch { /* ignore */ }
      }
      const pendingCount = countPendingMessages();
      if (pendingCount > 0) {
        log.chatwoot.debug(`Verificando ${pendingCount} mensagens pendentes`);
        await processRetryBatch();
      }
    } catch (err) {
      log.chatwoot.error('Erro no worker de retry', err);
    }
  }, RETRY_INTERVAL_MS).unref();
}

// Inicia o worker de retry imediatamente
startRetryWorker();
