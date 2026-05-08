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

import { getInstanceIntegrations, updateChatwootConfig } from './integrations.js';
import { listChats, listSyncMessages, getChatTitle } from './message-store.js';
import { isChatwootOriginated } from './chatwoot-tracking.js';
import {
  beginMessageSync,
  finishMessageSync,
  getUnsyncedMessageIds,
  isMessageSynced,
  markMessageSynced,
  startSyncProgress,
  updateSyncProgress,
  finishSyncProgress,
  isSyncCancelled,
  isSyncRunning,
} from './chatwoot-sync-store.js';

/**
 * Formats a raw digit string (e.g. "5511972798737") into a human-readable
 * phone number like "+55 11 97279 8737".
 * Falls back to "+{digits}" if it doesn't match known patterns.
 */
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
    groupSubjectCache.set(cacheKey, { subject: stored, expires: Date.now() + GROUP_SUBJECT_CACHE_MS });
    return stored;
  }

  return null;
}

// Resolve the saved contact name from multiple sources in order of trust:
//   1) Baileys store (the WhatsApp address book — has the user's saved name)
//   2) SQLite chat_meta.title (persisted pushName from previous messages)
//   3) Provided fallback (sender.name / pushName from the message itself)
// Names equal to the phone number / JID are considered weak and ignored
// (so we don't end up with "+55 11 9XXXX-XXXX - 5511XXXXXXXXX").
async function resolveContactName(
  instanceName: string,
  jid: string,
  fallback?: string | null,
): Promise<string | null> {
  const cacheKey = `${instanceName}:${jid}:${fallback ?? ''}`;
  const cached = contactNameCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.name;

  const number = jid.split('@')[0];

  // Helper: validate that the candidate name is meaningful
  const isUsableName = (name: unknown): name is string => {
    if (typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed) return false;
    if (trimmed === number) return false;
    if (trimmed === jid) return false;
    // pure phone-like strings: digits, +, -, spaces, parens
    if (/^[\d+\-\s()]+$/.test(trimmed)) return false;
    return true;
  };

  // 1) Baileys store — the actual WhatsApp address book
  try {
    const wa = await import('./whatsapp.js');
    const ctx = wa.getInstance(instanceName) as {
      sock?: { store?: { contacts?: Record<string, { name?: string; notify?: string; verifiedName?: string }> } };
    } | undefined;
    const contact = ctx?.sock?.store?.contacts?.[jid];
    if (contact) {
      // Order: saved name (verifiedName / name) > push name (notify)
      const candidate = contact.verifiedName || contact.name || contact.notify;
      if (isUsableName(candidate)) {
        const resolved = candidate.trim();
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

  contactNameCache.set(cacheKey, { name: null, expires: Date.now() + CONTACT_NAME_CACHE_MS });
  return null;
}

const REQUEST_TIMEOUT_MS = 10_000;

// ─── Chatwoot HTTP helpers ──────────────────────────────────────────────────

interface CwConfig {
  baseUrl: string;
  accountId: string;
  apiAccessToken: string;
}

async function cwFetch<T = unknown>(
  cfg: CwConfig,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const url = `${cfg.baseUrl}/api/v1/accounts/${cfg.accountId}${path}`;
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
  } finally {
    clearTimeout(t);
  }
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
  const digits = phone.replace('+', '');
  const cached = getCachedContact(contactByPhoneCache, contactCacheKey(cfg, digits));
  if (cached) return cached;
  try {
    const payload = {
      payload: [
        {
          attribute_key: 'phone_number',
          filter_operator: 'equal_to',
          values: [digits],
          query_operator: null,
        },
      ],
    };
    const res = await cwFetch<{ payload: CwContact[] }>(cfg, 'POST', '/contacts/filter', payload);
    const contact = res.payload?.[0] ?? null;
    cacheContact(cfg, contact);
    return contact;
  } catch {
    return null;
  }
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
 * Considera o nome "fraco" se for vazio, igual ao número, JID ou tiver formato de telefone puro.
 * Útil para detectar contatos que precisam ter nome atualizado quando descobrimos o pushName real.
 */
function isWeakName(name: string | undefined | null, phoneNumber: string, jid: string): boolean {
  if (!name) return true;
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed === phoneNumber) return true;
  if (trimmed === `+${phoneNumber}`) return true;
  if (trimmed === jid) return true;
  if (trimmed === jid.split('@')[0]) return true;
  // Apenas dígitos, +, traços e espaços = nome fraco (telefone)
  if (/^[\d+\-\s()]+$/.test(trimmed)) return true;
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
      const inbox = res.payload?.find((i: CwInbox) => i.name === nameInbox) ?? null;
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

/** Cache: instanceName:conversationJid → conversationId
 * For groups: key = instanceName:groupJid (one conversation per group)
 * For individuals: key = instanceName:contactJid
 */
const convCache = new Map<string, { id: number; ts: number }>();
const convInFlight = new Map<string, Promise<number | null>>();

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
        conv = existing[0]; // pick most recent regardless of status
      } else {
        conv = existing.find((c) => c.status !== 'resolved');
      }

      if (conv) {
        // Reopen if resolved/pending and flag is set
        if (opts.reopenConversation && conv.status !== 'open') {
          await cwFetch(cfg, 'POST', `/conversations/${conv.id}/toggle_status`, {
            status: opts.conversationPending ? 'pending' : 'open',
          }).catch(() => {});
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
      console.error('[chatwoot-bridge] getOrCreateConversation error', err);
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
    attachments?: Array<{ content: string; encoding: 'base64'; filename: string; mime_type?: string }>;
  },
): Promise<void> {
  await cwFetch(cfg, 'POST', `/conversations/${conversationId}/messages`, {
    content: params.content || '',
    message_type: params.messageType,
    private: params.isPrivate ?? false,
    source_id: params.sourceId,
    attachments: params.attachments,
  });
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
  message?: Record<string, unknown>;
  timestamp?: number;
  media?: {
    kind: string;
    mimeType?: string;
    fileName?: string;
    caption?: string;
    base64?: string;
    url?: string;
  };
  sender?: { name?: string; number?: string };
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
          omittedReason?: 'too_large' | 'download_failed';
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
  let cfg;
  try {
    const integrations = await getInstanceIntegrations(instanceName);
    cfg = integrations.chatwoot;
  } catch {
    return;
  }

  if (!cfg.enabled || !cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken || !cfg.inboxId) {
    console.log(`[chatwoot-bridge][${instanceName}] dispatch skipped: enabled=${cfg.enabled} baseUrl=${!!cfg.baseUrl} accountId=${!!cfg.accountId} token=${!!cfg.apiAccessToken} inboxId="${cfg.inboxId}" msgs=${messages.length}`);
    return;
  }

  const cwCfg: CwConfig = {
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    apiAccessToken: cfg.apiAccessToken,
  };

  const inbox = await getInbox(instanceName, cwCfg, cfg.nameInbox || 'WhatsApp');
  if (!inbox) {
    console.warn(`[chatwoot-bridge][${instanceName}] inbox "${cfg.nameInbox}" not found`);
    return;
  }

  for (const msg of messages) {
    const msgId = msg.key?.id;
    if (!msgId || !beginMessageSync(instanceName, msgId)) {
      continue;
    }
    try {
      const result = await dispatchSingleMessage(instanceName, cwCfg, cfg, inbox, msg);
      if (msgId && !result.skipped && result.conversationId) {
        markMessageSynced(instanceName, msgId, result.conversationId);
      }
    } catch (err) {
      console.error(`[chatwoot-bridge][${instanceName}] dispatch error for ${msg.key?.id}`, err);
    } finally {
      finishMessageSync(instanceName, msgId);
    }
  }
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
  options: { isHistorical?: boolean } = {},
): Promise<{ skipped: boolean; conversationId?: number }> {
  const { key, pushName, media, sender } = msg;
  if (!key?.remoteJid || !key?.id) return { skipped: true };

  if (isMessageSynced(instanceName, key.id)) return { skipped: true };

  const remoteJid = key.remoteJid;

  // Skip broadcast/status messages
  if (remoteJid === 'status@broadcast') return { skipped: true };

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

  // Skip messages with no meaningful content (unknown type with no text or media)
  const msgType = msg.messageType ?? msg.message_type ?? '';
  const hasContent = (msg.text && !msg.text.startsWith('[')) || msg.media?.caption || msg.media?.base64;
  const isGroup = remoteJid.endsWith('@g.us');
  const isFromMe = key.fromMe;
  if (msgType === 'unknown' && !hasContent && !rawMsg) return { skipped: true };

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
  const useRealNames = cfg.importContacts !== false;

  if (isGroup) {
    // Group: one conversation per group, contact = the group itself
    conversationJid = remoteJid;
    contactJid = remoteJid;
    phoneNumber = ''; // groups have no phone number

    // Resolver o nome REAL do grupo (subject) via socket Baileys ou chat_meta
    let groupSubject: string | null = null;
    if (useRealNames) {
      groupSubject = await resolveGroupSubject(instanceName, remoteJid);
    }
    // pushName em mensagens de grupo é o nome do REMETENTE, NÃO do grupo — ignorar para o título.
    contactName = groupSubject || (useRealNames ? remoteJid.split('@')[0] : remoteJid.split('@')[0]);

    // Identify the actual sender for message prefix (sempre, mesmo se importContacts=false — é só prefixo)
    {
      const participant = isFromMe
        ? '' // own messages in groups: no sender prefix needed (shown as outgoing)
        : (key.participant ?? '');
      if (participant) {
        const participantNumber = participant.split('@')[0];
        const formattedPhone = formatPhoneDisplay(participantNumber);
        // Resolve nome real do contato pelo Baileys store > SQLite > pushName atual.
        // Nomes "fracos" (igual ao número/JID) são filtrados por resolveContactName.
        const participantName = useRealNames
          ? await resolveContactName(instanceName, participant, sender?.name || pushName)
          : null;
        // Format: "+55 11 97279 8737 - Nome" or just the formatted number
        senderLabel = participantName
          ? `${formattedPhone} - ${participantName}`
          : formattedPhone;
      }
    }
  } else {
    // Individual: conversation is with the remote JID
    conversationJid = remoteJid;
    contactJid = remoteJid;
    phoneNumber = remoteJid.split('@')[0];

    if (useRealNames) {
      // Prioridade: chat_meta.title (pushName persistido em mensagens anteriores) > sender.name > pushName atual > número
      const storedTitle = getChatTitle(instanceName, remoteJid);
      contactName = storedTitle || sender?.name || pushName || phoneNumber;
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
    console.warn(`[chatwoot-bridge][${instanceName}] could not get/create contact for ${contactJid}`);
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
    console.warn(`[chatwoot-bridge][${instanceName}] could not get/create conversation for ${remoteJid}`);
    return { skipped: true };
  }

  // Build message content
  let content = extractContent(msg);

  // Strip placeholder content like "[image]", "[audio]" etc — they should not appear
  // alongside the actual attachment in Chatwoot (the attachment itself is enough).
  if (content && /^\[[a-z]+(?:[:\s].*)?\]$/i.test(content.trim())) {
    content = '';
  }

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
    const delimiter = cfg.signDelimiter ?? '\n';
    const agentName = cfg.nameInbox || instanceName;
    if (content) {
      content = `*${agentName}*${delimiter}${content}`;
    } else if (attachments && attachments.length > 0) {
      // sign even when only attachment is present
      content = `*${agentName}*`;
    }
  }

  const messageType = isFromMe ? 'outgoing' : 'incoming';

  await sendMessageToChatwoot(cwCfg, convId, {
    content,
    messageType,
    sourceId: key.id,
    // Historical messages are sent as private notes so Chatwoot does NOT
    // fire outbound webhooks back to WhatsApp (prevents infinite loop)
    isPrivate: options.isHistorical ?? false,
    attachments,
  });
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
    file_type: string;
    data_url: string;
    file_name?: string;
  }>;
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

/**
 * Process a Chatwoot webhook event.
 * Returns the JID to send to and the text, or null if not actionable.
 */
export function parseChatwootWebhook(payload: ChatwootWebhookPayload): {
  jid: string;
  text: string;
  mediaUrl?: string;
  mimeType?: string;
  fileName?: string;
  replyToId?: string;
  agentName?: string;
} | null {
  // Only handle new outgoing agent messages (not private notes, not bot messages)
  if (payload.event !== 'message_created') return null;
  if (payload.message_type !== 'outgoing') return null;
  if (payload.private) return null;
  // Skip messages from contact themselves (would cause a loop)
  if (payload.sender?.type === 'contact') return null;

  const identifier = payload.conversation?.meta?.sender?.identifier;
  const phone = payload.conversation?.meta?.sender?.phone_number;

  // Resolve JID: identifier is the WhatsApp JID we stored
  let jid = identifier?.includes('@') ? identifier : null;
  if (!jid && phone) {
    // phone_number is +5511... — strip + and add @s.whatsapp.net
    jid = `${phone.replace(/^\+/, '')}@s.whatsapp.net`;
  }

  if (!jid) return null;

  const attrs = payload.content_attributes ?? {};
  const text = payload.content ?? '';
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

  // Check for attachment
  const firstAttachment = payload.attachments?.[0];
  if (firstAttachment?.data_url) {
    return {
      jid,
      text,
      mediaUrl: firstAttachment.data_url,
      fileName: firstAttachment.file_name,
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
      const phoneNumber = jid.split('@')[0];
      const desiredName = isGroup
        ? await resolveGroupSubject(instanceName, jid)
        : await resolveContactName(instanceName, jid, chat.title || null);

      if (!desiredName || isWeakName(desiredName, phoneNumber, jid)) {
        skipped += 1;
        continue;
      }

      try {
        const contact = await findContactByIdentifier(cfg, jid)
          || (!isGroup ? await findContactByPhone(cfg, `+${phoneNumber}`) : null);
        if (!contact) {
          skipped += 1;
          continue;
        }
        if ((contact.name || '').trim() === desiredName.trim()) {
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
    console.warn(`[chatwoot-bridge][${instanceName}] autoCreate: missing config`);
    return { ok: false, error: 'missing_chatwoot_config' };
  }

  const cwCfg: CwConfig = {
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    apiAccessToken: cfg.apiAccessToken,
  };

  const inboxName = cfg.nameInbox || instanceName;

  try {
    // Check if inbox already exists
    const inboxesRes = await cwFetch<{ payload: CwInbox[] }>(cwCfg, 'GET', '/inboxes');
    const existing = inboxesRes.payload?.find((i: CwInbox) => i.name === inboxName);

    let inbox: CwInbox;
    if (existing) {
      inbox = existing;
      console.log(`[chatwoot-bridge][${instanceName}] autoCreate: inbox "${inboxName}" already exists (id=${inbox.id})`);
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
      console.log(`[chatwoot-bridge][${instanceName}] autoCreate: created inbox "${inboxName}" id=${inbox.id}`);
    }

    // Determine webhook slug: use existing or default to instanceName
    const slug = cfg.webhookSlug?.trim() || instanceName;

    // Patch inbox webhook_url with our endpoint
    // We need the origin from config — use baseUrl of the local server
    // The webhook URL is built from process.env or a default
    const serverOrigin = process.env.SERVER_URL?.replace(/\/$/, '') ?? `http://localhost:${process.env.PORT ?? '8787'}`;
    const webhookUrl = `${serverOrigin}/chatwoot/webhook/${encodeURIComponent(slug)}`;

    try {
      await cwFetch(cwCfg, 'PATCH', `/inboxes/${inbox.id}`, {
        channel: { webhook_url: webhookUrl },
      });
      console.log(`[chatwoot-bridge][${instanceName}] autoCreate: set inbox webhook_url = ${webhookUrl}`);
    } catch (err) {
      // Non-fatal: log but continue
      console.warn(`[chatwoot-bridge][${instanceName}] autoCreate: could not patch webhook_url`, err);
    }

    // Save inboxId and webhookSlug back to config
    const { updateChatwootConfig } = await import('./integrations.js');
    updateChatwootConfig(instanceName, {
      inboxId: String(inbox.id),
      webhookSlug: slug,
    });

    // Update inbox cache
    inboxCache.set(inboxCacheKey(instanceName, cfg, inbox.name), { inbox, ts: Date.now() });

    return { ok: true, inboxId: inbox.id, inboxName: inbox.name, webhookUrl };

  } catch (err) {
    console.error(`[chatwoot-bridge][${instanceName}] autoCreate error`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Conversation cache invalidation ─────────────────────────────────────────

export function invalidateConversationCache(instanceName: string): void {
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
  // Reject concurrent runs
  if (isSyncRunning(instanceName)) {
    return { ok: false, synced: 0, errors: 0, error: 'A sync is already running for this instance' };
  }

  let cfg;
  try {
    const integrations = await getInstanceIntegrations(instanceName);
    cfg = integrations.chatwoot;
  } catch (e) {
    return { ok: false, synced: 0, errors: 0, error: 'Failed to load integrations' };
  }

  if (!cfg.enabled || !cfg.baseUrl || !cfg.accountId || !cfg.apiAccessToken || !cfg.inboxId) {
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

  if (chats.length === 0) {
    finishSyncProgress(instanceName, 'completed');
    console.log(`[chatwoot-bridge][${instanceName}] sync-history done: synced=0 errors=0 skipped=0 chats=0`);
    return { ok: true, synced: 0, errors: 0, skipped: 0 };
  }

  const inbox = await getInbox(instanceName, cwCfg, cfg.nameInbox || 'WhatsApp');
  if (!inbox) {
    finishSyncProgress(instanceName, 'failed', `Inbox "${cfg.nameInbox}" not found`);
    return { ok: false, synced: 0, errors: 0, error: `Inbox "${cfg.nameInbox}" not found` };
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
    for (let i = 0; i < chats.length; i++) {
      // Check cancellation between chats
      if (isSyncCancelled(instanceName)) {
        cancelled = true;
        break;
      }

      const chat = chats[i];
      // Pass afterTs to filter messages by date
      const candidateMessages = listSyncMessages(instanceName, chat.jid, limitPerChat, afterTs);

      // Update progress with current chat info
      const chatTitle = chat.title || getChatTitle(instanceName, chat.jid);
      updateSyncProgress(instanceName, {
        currentChatJid: chat.jid,
        currentChatTitle: chatTitle,
        processedChats: i,
        totalMessages: candidateMessages.length,
      });

      if (candidateMessages.length === 0) {
        updateSyncProgress(instanceName, { processedChats: i + 1 });
        continue;
      }

      const unsyncedIds = getUnsyncedMessageIds(instanceName, candidateMessages.map((item) => item.id));
      if (unsyncedIds.size === 0) {
        skipped += candidateMessages.length;
        progressDirty = true;
        updateSyncProgress(instanceName, {
          skippedMessages: skipped,
          processedChats: i + 1,
        });
        continue;
      }

      const candidateIds = new Set(Array.from(unsyncedIds));
      const pendingMessages = candidateMessages.filter((stored) => candidateIds.has(stored.id));
      const hydrateIds = new Set(
        pendingMessages
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

      // Already sorted ASC by ts from SQLite, but ensure it
      pendingMessages.sort((a, b) => a.timestamp - b.timestamp);

      for (const stored of pendingMessages) {
        // Check cancellation inside inner loop too
        if (isSyncCancelled(instanceName)) {
          cancelled = true;
          break;
        }

        // Skip messages already synced (deduplication via SQLite tracking)
        if (!beginMessageSync(instanceName, stored.id, true)) {
          skipped++;
          progressDirty = true;
          if ((synced + skipped + errors) % 10 === 0) flushProgress();
          continue;
        }

        // Build a minimal NormalizedMessage from stored data
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
          media: hydratedMedia || (stored.media as NormalizedMessage['media']),
          message: undefined,
        };

        try {
          const result = await dispatchSingleMessage(instanceName, cwCfg, historyCfg, inbox, normalized, { isHistorical: true });
          if (!result.skipped && result.conversationId) {
            // Mark as synced ONLY when actually delivered to Chatwoot
            markMessageSynced(instanceName, stored.id, result.conversationId);
            synced++;
            progressDirty = true;
          } else {
            // Dispatch returned skipped (filtered by content/system check)
            skipped++;
            progressDirty = true;
          }
          if ((synced + skipped + errors) % 10 === 0) flushProgress();
        } catch (err) {
          errors++;
          progressDirty = true;
          updateSyncProgress(instanceName, {
            syncedMessages: synced,
            skippedMessages: skipped,
            errorCount: errors,
            lastError: (err as Error).message,
          });
          progressDirty = false;
          console.error(`[chatwoot-bridge][${instanceName}] sync-history error for ${stored.id}`, (err as Error).message);
        } finally {
          finishMessageSync(instanceName, stored.id);
        }

        // Delay to avoid rate-limiting Chatwoot (100ms between messages)
        await new Promise(r => setTimeout(r, 100));
      }

      flushProgress(true);
      updateSyncProgress(instanceName, { processedChats: i + 1 });

      if (cancelled) break;
    }
  } catch (err) {
    finishSyncProgress(instanceName, 'failed', (err as Error).message);
    console.error(`[chatwoot-bridge][${instanceName}] sync-history fatal:`, (err as Error).message);
    return { ok: false, synced, errors, skipped, error: (err as Error).message };
  }

  if (cancelled) {
    finishSyncProgress(instanceName, 'cancelled');
    console.log(`[chatwoot-bridge][${instanceName}] sync-history cancelled: synced=${synced} errors=${errors} skipped=${skipped} days=${days}`);
    return { ok: true, synced, errors, skipped, cancelled: true };
  }

  finishSyncProgress(instanceName, 'completed');
  console.log(`[chatwoot-bridge][${instanceName}] sync-history done: synced=${synced} errors=${errors} skipped=${skipped} days=${days} trigger=${trigger}`);
  return { ok: true, synced, errors, skipped };
}
