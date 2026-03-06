import path from 'node:path';
import fs from 'node:fs';
import type { InstanceContext } from '../types/whatsapp.js';
import { isValidInstanceName } from '../utils/helpers.js';
import { emitWebhookEvent } from './webhooks.js';
import { emitInstanceEvent, getInstanceGeneral, getInstancePanelConfig } from './instance-config.js';

const instances = new Map<string, InstanceContext>();
const reconnectAttempts = new Map<string, number>();
const pairingIssuedAt = new Map<string, number>();
const alwaysOnlineIntervals = new Map<string, NodeJS.Timeout>();
const syncHistoryIntervals = new Map<string, NodeJS.Timeout>();
const syncHistoryCursor = new Map<string, number>();
const runtimePath = path.resolve(process.cwd(), '.runtime');
const startupStatePath = path.join(runtimePath, 'autostart-instances.json');
const autostartInstances = new Set<string>();
const CONTINUOUS_HISTORY_SYNC_MS = 7000;
const CONTINUOUS_HISTORY_BATCH_CHATS = 6;
const CONTINUOUS_HISTORY_FETCH_COUNT = 120;

interface CachedMessage {
  id: string;
  fromMe: boolean;
  text: string;
  timestamp: number;
}

interface CachedChat {
  jid: string;
  title: string;
  unreadCount: number;
  lastMessage: string;
  lastTimestamp: number;
  messages: CachedMessage[];
}

const chatCache = new Map<string, Map<string, CachedChat>>();

function normalizeTimestamp(raw: unknown): number {
  const toMs = (value: number): number => {
    if (!Number.isFinite(value) || value <= 0) return Date.now();
    return value < 1000000000000 ? value * 1000 : value;
  };

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return toMs(raw);
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return toMs(parsed);
  }
  if (typeof raw === 'object' && raw !== null) {
    const maybe = raw as { low?: number; high?: number; toNumber?: () => number };
    if (typeof maybe.toNumber === 'function') {
      const val = maybe.toNumber();
      if (Number.isFinite(val)) return toMs(val);
    }
    if (typeof maybe.low === 'number') {
      return toMs(maybe.low);
    }
  }
  return Date.now();
}

function extractChatTitleFromPayload(payload: unknown): string {
  const chat = (payload ?? {}) as {
    name?: string;
    subject?: string;
    pushName?: string;
    notify?: string;
    conversationTimestamp?: unknown;
    id?: string;
    jid?: string;
  };

  const title =
    String(chat.name ?? '').trim()
    || String(chat.subject ?? '').trim()
    || String(chat.pushName ?? '').trim()
    || String(chat.notify ?? '').trim();

  if (title) return title;
  const jid = String(chat.id ?? chat.jid ?? '').trim();
  if (!jid) return '-';
  return jid.split('@')[0] || jid;
}

function loadAutostartState(): void {
  autostartInstances.clear();
  try {
    if (!fs.existsSync(startupStatePath)) return;
    const raw = fs.readFileSync(startupStatePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    parsed
      .map((item) => String(item ?? '').trim())
      .filter((name) => name.length > 0)
      .forEach((name) => autostartInstances.add(name));
  } catch {
    // ignore malformed file
  }
}

function persistAutostartState(): void {
  try {
    fs.mkdirSync(runtimePath, { recursive: true });
    const payload = JSON.stringify([...autostartInstances].sort(), null, 2);
    fs.writeFileSync(startupStatePath, payload, 'utf8');
  } catch {
    // ignore persistence failures
  }
}

function markAutostart(name: string, enabled: boolean): void {
  if (enabled) {
    autostartInstances.add(name);
  } else {
    autostartInstances.delete(name);
  }
  persistAutostartState();
}

loadAutostartState();

function stopAlwaysOnline(name: string): void {
  const timer = alwaysOnlineIntervals.get(name);
  if (timer) {
    clearInterval(timer);
    alwaysOnlineIntervals.delete(name);
  }
}

function startAlwaysOnline(name: string, ctx: InstanceContext): void {
  stopAlwaysOnline(name);
  const settings = getInstanceGeneral(name);
  if (!settings.alwaysOnline) return;
  if (typeof ctx.sock.sendPresenceUpdate !== 'function') return;

  ctx.sock.sendPresenceUpdate?.('available').catch(() => {});

  const timer = setInterval(() => {
    ctx.sock.sendPresenceUpdate?.('available').catch(() => {});
  }, 30000);
  alwaysOnlineIntervals.set(name, timer);
}

function pruneGroupChatsFromCache(name: string): void {
  const settings = getInstanceGeneral(name);
  if (!settings.ignoreGroups) return;
  const chats = chatCache.get(name);
  if (!chats) return;
  for (const jid of chats.keys()) {
    if (jid.endsWith('@g.us')) {
      chats.delete(jid);
    }
  }
}

function stopContinuousHistorySync(name: string): void {
  const timer = syncHistoryIntervals.get(name);
  if (timer) {
    clearInterval(timer);
    syncHistoryIntervals.delete(name);
  }
  syncHistoryCursor.delete(name);
}

function extractMessagesFromHistoryResponse(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) {
    return raw.filter((item) => typeof item === 'object' && item !== null) as Array<Record<string, unknown>>;
  }

  const obj = (raw ?? {}) as {
    messages?: unknown;
    msgs?: unknown;
    historyMessages?: unknown;
  };

  if (Array.isArray(obj.messages)) {
    return obj.messages.filter((item) => typeof item === 'object' && item !== null) as Array<Record<string, unknown>>;
  }
  if (Array.isArray(obj.msgs)) {
    return obj.msgs.filter((item) => typeof item === 'object' && item !== null) as Array<Record<string, unknown>>;
  }
  if (Array.isArray(obj.historyMessages)) {
    return obj.historyMessages.filter((item) => typeof item === 'object' && item !== null) as Array<Record<string, unknown>>;
  }
  return [];
}

async function runContinuousHistorySync(name: string, ctx: InstanceContext): Promise<void> {
  const settings = getInstanceGeneral(name);
  if (!settings.syncFullHistory) return;

  const anySock = ctx.sock as any;
  const hasFetchHistory = typeof anySock.fetchMessageHistory === 'function';
  const hasResyncState = typeof anySock.resyncAppState === 'function';
  if (!hasFetchHistory && !hasResyncState) return;

  const list = getInstanceChatList(name).filter((chat) => !(settings.ignoreGroups && chat.jid.endsWith('@g.us')));
  if (list.length === 0) {
    if (hasResyncState) {
      try {
        await anySock.resyncAppState(['critical_block', 'regular']);
      } catch {
        // best effort
      }
    }
    return;
  }

  const start = syncHistoryCursor.get(name) ?? 0;
  const limit = Math.min(CONTINUOUS_HISTORY_BATCH_CHATS, list.length);
  const selected: Array<(typeof list)[number]> = [];
  for (let i = 0; i < limit; i++) {
    const idx = (start + i) % list.length;
    selected.push(list[idx]);
  }
  syncHistoryCursor.set(name, (start + limit) % list.length);

  for (const chat of selected) {
    if (!hasFetchHistory) break;
    const existing = getInstanceChatMessages(name, chat.jid);
    const oldest = existing.length > 0 ? existing[0] : undefined;
    const oldestTimestamp = oldest ? normalizeTimestamp(oldest.timestamp) : undefined;
    const oldestKey = oldest
      ? {
          remoteJid: chat.jid,
          id: oldest.id,
          fromMe: oldest.fromMe,
        }
      : undefined;

    try {
      const response = await anySock.fetchMessageHistory(
        CONTINUOUS_HISTORY_FETCH_COUNT,
        oldestKey,
        oldestTimestamp
      );
      const messages = extractMessagesFromHistoryResponse(response);
      if (messages.length > 0) {
        ingestMessagesToCache(name, messages, { fromHistory: true });
      }
    } catch {
      // best effort continuous sync
    }
  }
}

function startContinuousHistorySync(name: string, ctx: InstanceContext): void {
  stopContinuousHistorySync(name);
  const settings = getInstanceGeneral(name);
  if (!settings.syncFullHistory) return;

  void runContinuousHistorySync(name, ctx);
  const timer = setInterval(() => {
    void runContinuousHistorySync(name, ctx);
  }, CONTINUOUS_HISTORY_SYNC_MS);
  syncHistoryIntervals.set(name, timer);
}

async function resolveProxyAgent(instance: string): Promise<{ agent: unknown | null; error?: string }> {
  const proxy = getInstancePanelConfig(instance).proxy;
  if (!proxy.enabled) {
    return { agent: null };
  }

  const host = String(proxy.host || '').trim();
  const port = Number(proxy.port || 0);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return { agent: null, error: 'proxy_invalid_host_or_port' };
  }

  const protocol = proxy.protocol === 'https' ? 'https' : 'http';
  const username = String(proxy.username || '').trim();
  const password = String(proxy.password || '').trim();
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  const proxyUrl = `${protocol}://${auth}${host}:${port}`;

  try {
    const { HttpsProxyAgent } = await import('https-proxy-agent');
    return { agent: new HttpsProxyAgent(proxyUrl) };
  } catch {
    return { agent: null, error: 'proxy_agent_unavailable' };
  }
}

export function applyInstanceRuntimeSettings(name: string): { ok: boolean; applied: string[]; requiresReconnect: string[] } {
  const ctx = instances.get(name);
  if (!ctx) {
    return {
      ok: false,
      applied: [],
      requiresReconnect: [],
    };
  }

  stopAlwaysOnline(name);
  startAlwaysOnline(name, ctx);
  stopContinuousHistorySync(name);
  startContinuousHistorySync(name, ctx);
  pruneGroupChatsFromCache(name);

  return {
    ok: true,
    applied: ['alwaysOnline', 'rejectCalls', 'ignoreGroups', 'autoReadMessages', 'readStatus', 'syncFullHistory'],
    requiresReconnect: ['proxy'],
  };
}

function extractMessageText(message: unknown): string {
  const msg = (message ?? {}) as Record<string, unknown>;
  if (typeof msg.conversation === 'string') return msg.conversation;
  const extended = msg.extendedTextMessage as { text?: string } | undefined;
  if (extended?.text) return extended.text;
  const image = msg.imageMessage as { caption?: string } | undefined;
  if (image?.caption) return image.caption;
  const video = msg.videoMessage as { caption?: string } | undefined;
  if (video?.caption) return video.caption;
  if (msg.stickerMessage) return '[sticker]';
  if (msg.audioMessage) return '[audio]';
  if (msg.documentMessage) return '[document]';
  if (msg.contactMessage) return '[contact]';
  if (msg.locationMessage) return '[location]';
  return '[message]';
}

function ensureInstanceChatMap(instance: string): Map<string, CachedChat> {
  let map = chatCache.get(instance);
  if (!map) {
    map = new Map();
    chatCache.set(instance, map);
  }
  return map;
}

function updateCachedMessage(
  instance: string,
  payload: { jid: string; id: string; fromMe: boolean; text: string; timestamp: number; incrementUnread?: boolean }
): boolean {
  const chats = ensureInstanceChatMap(instance);
  const existing = chats.get(payload.jid);
  const title = existing?.title || payload.jid.split('@')[0];
  const chat: CachedChat =
    existing ?? {
      jid: payload.jid,
      title,
      unreadCount: 0,
      lastMessage: '',
      lastTimestamp: 0,
      messages: [],
  };

  if (chat.messages.some((message) => message.id === payload.id)) {
    return false;
  }

  chat.lastMessage = payload.text;
  chat.lastTimestamp = payload.timestamp;
  const incrementUnread = payload.incrementUnread ?? !payload.fromMe;
  if (incrementUnread) {
    chat.unreadCount += 1;
  }

  chat.messages.push({
    id: payload.id,
    fromMe: payload.fromMe,
    text: payload.text,
    timestamp: payload.timestamp,
  });

  chats.set(payload.jid, chat);
  return true;
}

function upsertCachedChatMeta(
  instance: string,
  payload: { jid: string; title?: string; timestamp?: number }
): void {
  const chats = ensureInstanceChatMap(instance);
  const existing = chats.get(payload.jid);
  const fallbackTitle = payload.jid.split('@')[0] || payload.jid;
  const title = String(payload.title ?? '').trim() || existing?.title || fallbackTitle;
  const chat: CachedChat =
    existing ?? {
      jid: payload.jid,
      title,
      unreadCount: 0,
      lastMessage: '',
      lastTimestamp: Number(payload.timestamp ?? 0),
      messages: [],
    };

  chat.title = title;
  if (payload.timestamp && payload.timestamp > chat.lastTimestamp) {
    chat.lastTimestamp = payload.timestamp;
  }
  chats.set(payload.jid, chat);
}

function formatDisconnectInfo(lastDisconnect: unknown): { code?: number; message?: string } {
  const info = (lastDisconnect ?? {}) as {
    error?: { output?: { statusCode?: number }; message?: string; data?: string; stack?: string };
  };
  const code = info.error?.output?.statusCode;
  const message = info.error?.message ?? info.error?.data;
  return { code, message };
}

function isPairingWindowActive(name: string): boolean {
  const issuedAt = pairingIssuedAt.get(name);
  if (!issuedAt) return false;
  return Date.now() - issuedAt <= 120000;
}

function ingestMessagesToCache(
  instance: string,
  rawMessages: Array<Record<string, unknown>>,
  options?: { fromHistory?: boolean }
): { list: Array<Record<string, unknown>>; inserted: number } {
  const settings = getInstanceGeneral(instance);
  const fromHistory = Boolean(options?.fromHistory);
  const list = settings.ignoreGroups
    ? rawMessages.filter((msg) => {
      const key = (msg.key ?? {}) as { remoteJid?: string };
      const remoteJid = String(key.remoteJid ?? '').trim();
      return !remoteJid.endsWith('@g.us');
    })
    : rawMessages;

  let inserted = 0;
  for (const msg of list) {
    const key = (msg.key ?? {}) as {
      id?: string;
      remoteJid?: string;
      fromMe?: boolean;
    };
    const remoteJid = String(key.remoteJid ?? '').trim();
    const id = String(key.id ?? '').trim();
    if (!remoteJid || !id) continue;

    const message = msg.message;
    const timestamp = normalizeTimestamp((msg as { messageTimestamp?: unknown }).messageTimestamp);
    const text = extractMessageText(message);

    const wasInserted = updateCachedMessage(instance, {
      jid: remoteJid,
      id,
      fromMe: Boolean(key.fromMe),
      text,
      timestamp,
      incrementUnread: fromHistory ? false : !Boolean(key.fromMe),
    });
    if (wasInserted) inserted += 1;
  }

  return { list, inserted };
}

function closeSocket(sock: InstanceContext['sock']): void {
  try {
    (sock as InstanceContext['sock']).ws?.close?.();
  } catch {
    // ignore
  }
}

/**
 * Retorna o contexto da instância pelo nome, ou undefined se não existir.
 */
export function getInstance(name: string): InstanceContext | undefined {
  return instances.get(name);
}

/**
 * Retorna todas as instâncias.
 */
export function getAllInstances(): InstanceContext[] {
  return Array.from(instances.values());
}

export async function reconnectPreviouslyActiveInstances(authFolder: string): Promise<{
  attempted: number;
  started: number;
  failed: string[];
}> {
  const authPath = path.resolve(process.cwd(), authFolder);
  const failed: string[] = [];

  if (!fs.existsSync(authPath)) {
    return { attempted: 0, started: 0, failed };
  }

  const savedSessions = new Set(
    fs
      .readdirSync(authPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidInstanceName(entry.name))
      .map((entry) => entry.name.trim())
  );

  const queue = [...autostartInstances].filter((name) => isValidInstanceName(name) && savedSessions.has(name));
  let started = 0;

  for (const name of queue) {
    const result = await createInstance(name, authFolder);
    if (result.ok) {
      started += 1;
    } else {
      failed.push(`${name}:${result.error ?? 'unknown_error'}`);
    }
    await sleep(250);
  }

  return {
    attempted: queue.length,
    started,
    failed,
  };
}

/**
 * Cria e inicia uma nova instância WhatsApp (InfiniteAPI/Baileys).
 * Gera QR code até o usuário escanear e conectar.
 * Em 515 (restartRequired) recria o socket automaticamente após 2s.
 */
export async function createInstance(
  name: string,
  authFolder: string
): Promise<{ ok: boolean; instance: string; qr?: string; error?: string }> {
  const normalizedName = String(name ?? '').trim();
  if (!isValidInstanceName(normalizedName)) {
    return { ok: false, instance: normalizedName || String(name ?? ''), error: 'invalid_instance_name' };
  }
  name = normalizedName;

  if (instances.has(name)) {
    const ctx = instances.get(name)!;
    if (ctx.status === 'connected') {
      markAutostart(name, true);
      return { ok: true, instance: name };
    }
    if (ctx.status === 'qr' && ctx.qr) {
      return { ok: true, instance: name, qr: ctx.qr };
    }
    // disconnected ou connecting: remove e recria para nova tentativa
    closeSocket(ctx.sock);
    instances.delete(name);
  }

  try {
    const {
      default: makeWASocket,
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestWaWebVersion,
      Browsers,
    } = await import('baileys');
    const authPath = path.resolve(process.cwd(), authFolder, name);

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    let version: [number, number, number];
    try {
      const wa = await fetchLatestWaWebVersion({});
      const v = wa.version;
      version = Array.isArray(v) && v.length >= 3 ? [v[0], v[1], v[2]] : [2, 3000, 1032884366];
    } catch {
      version = [2, 3000, 1032884366];
    }

    const generalSettings = getInstanceGeneral(name);
    const proxyAgentResult = await resolveProxyAgent(name);
    if (proxyAgentResult.error) {
      return { ok: false, instance: name, error: proxyAgentResult.error };
    }

    const socketOptions: any = {
      auth: state,
      printQRInTerminal: false,
      version,
      browser: Browsers.windows('Chrome'),
      syncFullHistory: generalSettings.syncFullHistory,
    };

    if (proxyAgentResult.agent) {
      socketOptions.agent = proxyAgentResult.agent;
      socketOptions.fetchAgent = proxyAgentResult.agent;
    }

    const sock = makeWASocket(socketOptions) as InstanceContext['sock'];

    const ctx: InstanceContext = {
      name,
      sock,
      status: 'connecting',
      qr: null,
      createdAt: new Date(),
      authFolder,
    };
    instances.set(name, ctx);
    reconnectAttempts.set(name, 0);

    sock.ev.on('creds.update', (creds: unknown) => {
      void saveCreds();
      const registered = Boolean((creds as { registered?: boolean } | undefined)?.registered);
      if (registered) {
        pairingIssuedAt.delete(name);
      }
    });

    sock.ev.on('connection.update', ((update: unknown) => {
      emitWebhookEvent('connection.update', { instance: name, update }, name);
      void emitInstanceEvent(name, 'CONNECTION_UPDATE', { update });

      const { connection, qr, lastDisconnect } = (update ?? {}) as {
        connection?: string;
        qr?: string;
        lastDisconnect?: { error?: { output?: { statusCode?: number } } };
      };

      if (qr) {
        ctx.status = 'qr';
        ctx.qr = qr;
        void emitInstanceEvent(name, 'QRCODE_UPDATED', { hasQr: true });
      }

      if (connection === 'open') {
        ctx.status = 'connected';
        ctx.qr = null;
        reconnectAttempts.set(name, 0);
        markAutostart(name, true);
        const currentUser = (ctx.sock.user as { id?: string; name?: string } | undefined) ?? {};
        const linkedJid = String(currentUser.id ?? '').trim();
        const linkedNumber = linkedJid ? linkedJid.split(':')[0].split('@')[0] : '';
        ctx.linkedNumber = linkedNumber || null;
        ctx.profileName = String(currentUser.name ?? '').trim() || null;

        if (typeof ctx.sock.profilePictureUrl === 'function' && linkedJid) {
          ctx.sock
            .profilePictureUrl(linkedJid)
            .then((url) => {
              if (instances.get(name) === ctx) {
                ctx.profilePictureUrl = url || null;
              }
            })
            .catch(() => {
              if (instances.get(name) === ctx) {
                ctx.profilePictureUrl = null;
              }
            });
        }

        startAlwaysOnline(name, ctx);
        startContinuousHistorySync(name, ctx);
      }

      if (connection === 'close') {
        // Ignore close events from stale sockets that are no longer current.
        if (instances.get(name) !== ctx) {
          return;
        }

        const previousStatus = ctx.status;
        const { code, message } = formatDisconnectInfo(lastDisconnect);
        ctx.status = 'disconnected';
        ctx.qr = null;

        console.log(
          `[whatsapp][${name}] connection_close code=${String(code ?? 'n/a')} message=${String(message ?? 'n/a')}`
        );

        if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced) {
          if (isPairingWindowActive(name)) {
            console.log(`[whatsapp][${name}] pairing_window_close code=${String(code)} (holding disconnected; no auto-recreate)`);
            closeSocket(ctx.sock);
            ctx.status = 'disconnected';
            ctx.qr = null;
            reconnectAttempts.set(name, 0);
            stopAlwaysOnline(name);
            stopContinuousHistorySync(name);
            return;
          }

          const attempts = (reconnectAttempts.get(name) ?? 0) + 1;
          const allowRecovery = previousStatus === 'connected' && attempts <= 6;

          if (allowRecovery) {
            reconnectAttempts.set(name, attempts);
            const folder = ctx.authFolder;
            const delayMs = Math.min(1000 * attempts, 6000);
            console.log(
              `[whatsapp][${name}] auth_close_recover code=${String(code)} attempt=${attempts} delay_ms=${delayMs}`
            );
            closeSocket(ctx.sock);
            ctx.status = 'connecting';
            setTimeout(() => {
              createInstance(name, folder).catch(() => {});
            }, delayMs);
            return;
          }

          closeSocket(ctx.sock);
          instances.delete(name);
          reconnectAttempts.delete(name);
          markAutostart(name, false);
          chatCache.delete(name);
          stopAlwaysOnline(name);
          stopContinuousHistorySync(name);
          return;
        }

        // 515 = restartRequired: pairing concluído, WA pede reinício. Recriar socket com o mesmo auth.
        if (code === DisconnectReason.restartRequired) {
          const folder = ctx.authFolder;
          closeSocket(ctx.sock);
          ctx.status = 'connecting';
          stopAlwaysOnline(name);
          stopContinuousHistorySync(name);
          setTimeout(() => {
            createInstance(name, folder).catch(() => {});
          }, 2000);
          return;
        }

        // For transient closes (timeout/network/stream), only auto-recreate if it was already connected.
        if (previousStatus !== 'connected') {
          return;
        }

        const attempts = (reconnectAttempts.get(name) ?? 0) + 1;
        reconnectAttempts.set(name, attempts);
        if (attempts <= 6) {
          const folder = ctx.authFolder;
          const delayMs = Math.min(1000 * attempts, 6000);
          console.log(`[whatsapp][${name}] reconnect_attempt=${attempts} delay_ms=${delayMs}`);
          closeSocket(ctx.sock);
          ctx.status = 'connecting';
          stopAlwaysOnline(name);
          stopContinuousHistorySync(name);
          setTimeout(() => {
            createInstance(name, folder).catch(() => {});
          }, delayMs);
        } else {
          console.log(`[whatsapp][${name}] reconnect_exhausted attempts=${attempts}`);
        }
      }
    }));

    sock.ev.on('messages.upsert', (payload: unknown) => {
      const data = (payload ?? {}) as { messages?: Array<Record<string, unknown>> };
      const originalList = Array.isArray(data.messages) ? data.messages : [];
      const ingested = ingestMessagesToCache(name, originalList, { fromHistory: false });
      const list = ingested.list;

      const payloadForEvents = {
        ...(typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}),
        messages: list,
      };

      if (list.length > 0) {
        emitWebhookEvent('messages.upsert', { instance: name, payload: payloadForEvents }, name);
        void emitInstanceEvent(name, 'MESSAGES_UPSERT', { payload: payloadForEvents });
      }

      const settings = getInstanceGeneral(name);
      const keysToRead = new Map<string, { remoteJid: string; id: string; participant?: string; fromMe?: boolean }>();

      const addKeyToRead = (entry: { remoteJid: string; id: string; participant?: string; fromMe?: boolean }) => {
        keysToRead.set(`${entry.remoteJid}:${entry.id}`, entry);
      };

      for (const msg of list) {
        const key = (msg.key ?? {}) as {
          id?: string;
          remoteJid?: string;
          fromMe?: boolean;
          participant?: string;
        };
        const remoteJid = String(key.remoteJid ?? '').trim();
        const id = String(key.id ?? '').trim();
        if (!remoteJid || !id) continue;

        if (!key.fromMe && settings.autoReadMessages && remoteJid !== 'status@broadcast' && typeof ctx.sock.readMessages === 'function') {
          addKeyToRead({
            remoteJid,
            id,
            participant: key.participant,
            fromMe: false,
          });
        }

        if (remoteJid === 'status@broadcast' && settings.readStatus && typeof ctx.sock.readMessages === 'function') {
          addKeyToRead({
            remoteJid,
            id,
            participant: key.participant,
            fromMe: false,
          });
        }
      }

      if (keysToRead.size && typeof ctx.sock.readMessages === 'function') {
        ctx.sock.readMessages([...keysToRead.values()]).catch(() => {});
      }
    });

    sock.ev.on('messages.set', (payload: unknown) => {
      const data = (payload ?? {}) as { messages?: Array<Record<string, unknown>> };
      const originalList = Array.isArray(data.messages) ? data.messages : [];
      const ingested = ingestMessagesToCache(name, originalList, { fromHistory: true });
      if (ingested.list.length > 0) {
        void emitInstanceEvent(name, 'MESSAGES_SET', {
          ...(typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}),
          messages: ingested.list,
        });
      }
    });

    sock.ev.on('messaging-history.set', (payload: unknown) => {
      const data = (payload ?? {}) as {
        chats?: Array<Record<string, unknown>>;
        messages?: Array<Record<string, unknown>>;
      };

      const settings = getInstanceGeneral(name);
      const chats = Array.isArray(data.chats) ? data.chats : [];
      for (const item of chats) {
        const jid = String((item as { id?: string; jid?: string }).id ?? (item as { jid?: string }).jid ?? '').trim();
        if (!jid) continue;
        if (settings.ignoreGroups && jid.endsWith('@g.us')) continue;

        upsertCachedChatMeta(name, {
          jid,
          title: extractChatTitleFromPayload(item),
          timestamp: normalizeTimestamp((item as { conversationTimestamp?: unknown }).conversationTimestamp),
        });
      }

      const originalList = Array.isArray(data.messages) ? data.messages : [];
      const ingested = ingestMessagesToCache(name, originalList, { fromHistory: true });
      if (ingested.list.length > 0) {
        void emitInstanceEvent(name, 'MESSAGES_SET', { payload: { messages: ingested.list } });
      }
      if (chats.length > 0) {
        void emitInstanceEvent(name, 'CHATS_SET', { payload: { chats } });
      }
    });

    sock.ev.on('messages.update', (payload: unknown) => {
      emitWebhookEvent('messages.update', { instance: name, payload }, name);
      void emitInstanceEvent(name, 'MESSAGES_UPDATE', { payload });
    });

    sock.ev.on('message-receipt.update', (payload: unknown) => {
      emitWebhookEvent('message-receipt.update', { instance: name, payload }, name);
    });

    sock.ev.on('chats.update', (payload: unknown) => {
      emitWebhookEvent('chats.update', { instance: name, payload }, name);
      void emitInstanceEvent(name, 'CHATS_UPDATE', { payload });

      const settings = getInstanceGeneral(name);
      const updates = Array.isArray(payload) ? payload : [];
      for (const item of updates) {
        const jid = String((item as { id?: string; jid?: string }).id ?? (item as { jid?: string }).jid ?? '').trim();
        if (!jid) continue;
        if (settings.ignoreGroups && jid.endsWith('@g.us')) continue;
        upsertCachedChatMeta(name, {
          jid,
          title: extractChatTitleFromPayload(item),
          timestamp: normalizeTimestamp((item as { conversationTimestamp?: unknown }).conversationTimestamp),
        });
      }
    });

    sock.ev.on('groups.update', (payload: unknown) => {
      emitWebhookEvent('groups.update', { instance: name, payload }, name);
      void emitInstanceEvent(name, 'GROUP_UPDATE', { payload });
    });

    sock.ev.on('chats.set', (payload: unknown) => {
      void emitInstanceEvent(name, 'CHATS_SET', { payload });

      const settings = getInstanceGeneral(name);
      const data = (payload ?? {}) as { chats?: Array<Record<string, unknown>> };
      const chats = Array.isArray(data.chats) ? data.chats : [];
      for (const item of chats) {
        const jid = String((item as { id?: string; jid?: string }).id ?? (item as { jid?: string }).jid ?? '').trim();
        if (!jid) continue;
        if (settings.ignoreGroups && jid.endsWith('@g.us')) continue;
        upsertCachedChatMeta(name, {
          jid,
          title: extractChatTitleFromPayload(item),
          timestamp: normalizeTimestamp((item as { conversationTimestamp?: unknown }).conversationTimestamp),
        });
      }
    });

    sock.ev.on('chats.upsert', (payload: unknown) => {
      void emitInstanceEvent(name, 'CHATS_UPSERT', { payload });

      const settings = getInstanceGeneral(name);
      const list = Array.isArray(payload) ? payload : [];
      for (const item of list) {
        const jid = String((item as { id?: string; jid?: string }).id ?? (item as { jid?: string }).jid ?? '').trim();
        if (!jid) continue;
        if (settings.ignoreGroups && jid.endsWith('@g.us')) continue;
        upsertCachedChatMeta(name, {
          jid,
          title: extractChatTitleFromPayload(item),
          timestamp: normalizeTimestamp((item as { conversationTimestamp?: unknown }).conversationTimestamp),
        });
      }
    });

    sock.ev.on('contacts.set', (payload: unknown) => {
      void emitInstanceEvent(name, 'CONTACTS_SET', { payload });
    });

    sock.ev.on('contacts.update', (payload: unknown) => {
      void emitInstanceEvent(name, 'CONTACTS_UPDATE', { payload });
    });

    sock.ev.on('contacts.upsert', (payload: unknown) => {
      void emitInstanceEvent(name, 'CONTACTS_UPSERT', { payload });
    });

    sock.ev.on('groups.upsert', (payload: unknown) => {
      void emitInstanceEvent(name, 'GROUPS_UPSERT', { payload });
    });

    sock.ev.on('group-participants.update', (payload: unknown) => {
      void emitInstanceEvent(name, 'GROUP_PARTICIPANTS_UPDATE', { payload });
    });

    sock.ev.on('call', (payload: unknown) => {
      void emitInstanceEvent(name, 'CALL', { payload });
      const settings = getInstanceGeneral(name);
      if (!settings.rejectCalls) return;
      const entries = Array.isArray(payload) ? payload : [payload];
      for (const item of entries) {
        const call = item as { id?: string; from?: string; status?: string; chatId?: string };
        const callId = String(call?.id ?? '').trim();
        const callFrom = String(call?.from ?? call?.chatId ?? '').trim();
        const callStatus = String(call?.status ?? '').trim().toLowerCase();
        if (!callId || !callFrom) continue;
        if (callStatus && callStatus !== 'offer' && callStatus !== 'ringing') continue;
        if (typeof ctx.sock.rejectCall === 'function') {
          ctx.sock.rejectCall(callId, callFrom).catch(() => {});
        }
      }
    });

    return { ok: true, instance: name, qr: ctx.qr ?? undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, instance: name, error: message };
  }
}

export function normalizePairingPhoneNumber(rawPhone: string, defaultCountryCode: string): string {
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) return '';

  const countryCode = defaultCountryCode.replace(/\D/g, '');
  if (!countryCode) return digits;

  if (digits.startsWith(countryCode)) return digits;
  if (digits.length <= 11) return `${countryCode}${digits}`;
  return digits;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestInstancePairingCode(
  name: string,
  phoneNumber: string
): Promise<{ ok: boolean; pairingCode?: string; error?: string; status?: string }> {
  const ctx = instances.get(name);
  if (!ctx) {
    return { ok: false, error: 'instance_not_found' };
  }

  if (ctx.status === 'connected') {
    return { ok: false, error: 'instance_already_connected', status: ctx.status };
  }

  if (typeof ctx.sock.requestPairingCode !== 'function') {
    return { ok: false, error: 'pairing_code_not_supported' };
  }

  let lastError = 'pairing_code_unavailable';

  for (let attempt = 1; attempt <= 8; attempt++) {
    const current = instances.get(name);
    if (!current) {
      return { ok: false, error: 'instance_not_found' };
    }

    if (current.status === 'connected') {
      return { ok: false, error: 'instance_already_connected', status: current.status };
    }

    const requestPairingCode = current.sock.requestPairingCode;
    if (typeof requestPairingCode !== 'function') {
      return { ok: false, error: 'pairing_code_not_supported' };
    }

    try {
      const pairingCode = await requestPairingCode(phoneNumber);
      const code = String(pairingCode ?? '').trim();
      if (code) {
        pairingIssuedAt.set(name, Date.now());
        await sleep(1200);
        const afterIssue = instances.get(name);
        if (!afterIssue || afterIssue.status === 'disconnected') {
          return { ok: false, error: 'pairing_code_unstable', status: afterIssue?.status };
        }
        return { ok: true, pairingCode: code, status: afterIssue.status };
      }
      lastError = 'empty_pairing_code';
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).trim();
      const normalized = message.toLowerCase();

      if (normalized.includes('not linked') || normalized.includes('registered') || normalized.includes('logged in')) {
        return { ok: false, error: 'session_already_registered', status: current.status };
      }

      if (normalized.includes('connection closed') || normalized.includes('closed')) {
        lastError = 'pairing_channel_not_ready';
      } else {
        lastError = message || 'pairing_code_unavailable';
      }
    }

    if (attempt < 8) {
      await sleep(1000);
    }
  }

  return { ok: false, error: lastError, status: instances.get(name)?.status };
}

/**
 * Desconecta e remove a instância da memória (credenciais permanecem em disco).
 */
export function disconnectInstance(name: string, options?: { keepAutostart?: boolean }): boolean {
  const ctx = instances.get(name);
  if (!ctx) return false;
  closeSocket(ctx.sock);
  instances.delete(name);
  reconnectAttempts.delete(name);
  if (!options?.keepAutostart) {
    markAutostart(name, false);
  }
  pairingIssuedAt.delete(name);
  chatCache.delete(name);
  stopAlwaysOnline(name);
  stopContinuousHistorySync(name);
  return true;
}

/**
 * Logout + apaga pasta de auth e remove instância. Próxima conexão gerará novo QR.
 */
export async function logoutInstance(name: string, authFolder: string): Promise<{ ok: boolean; error?: string }> {
  const normalizedName = String(name ?? '').trim();
  if (!isValidInstanceName(normalizedName)) {
    return { ok: false, error: 'invalid_instance_name' };
  }
  name = normalizedName;

  const ctx = instances.get(name);
  if (ctx) {
    try {
      if (typeof ctx.sock.logout === 'function') {
        await ctx.sock.logout();
      }
    } catch {
      // ignore
    }
    closeSocket(ctx.sock);
    instances.delete(name);
    reconnectAttempts.delete(name);
    markAutostart(name, false);
    pairingIssuedAt.delete(name);
    chatCache.delete(name);
    stopAlwaysOnline(name);
    stopContinuousHistorySync(name);
  }
  const authPath = path.resolve(process.cwd(), authFolder, name);
  try {
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
  return { ok: true };
}

/**
 * Remove a instância (fecha socket e remove do mapa). Não apaga credenciais.
 */
export function removeInstance(name: string): boolean {
  return disconnectInstance(name);
}

export function getInstanceChatList(name: string): Array<{
  jid: string;
  title: string;
  unreadCount: number;
  messageCount: number;
  lastMessage: string;
  lastTimestamp: number;
}> {
  const chats = chatCache.get(name);
  if (!chats) return [];
  return [...chats.values()]
    .map((chat) => ({
      jid: chat.jid,
      title: chat.title,
      unreadCount: chat.unreadCount,
      messageCount: chat.messages.length,
      lastMessage: chat.lastMessage,
      lastTimestamp: chat.lastTimestamp,
    }))
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
}

export function getInstanceChatMessages(name: string, jid: string): CachedMessage[] {
  const chats = chatCache.get(name);
  if (!chats) return [];
  const chat = chats.get(jid);
  if (!chat) return [];
  return [...chat.messages].sort((a, b) => a.timestamp - b.timestamp);
}

export async function syncInstanceChatHistory(
  name: string,
  jid: string,
  options?: { maxBatches?: number; fetchCount?: number }
): Promise<{ ok: boolean; imported: number; batches: number; done: boolean; error?: string }> {
  const ctx = instances.get(name);
  if (!ctx) {
    return { ok: false, imported: 0, batches: 0, done: false, error: 'instance_not_found' };
  }
  if (ctx.status !== 'connected') {
    return { ok: false, imported: 0, batches: 0, done: false, error: 'instance_not_connected' };
  }

  const settings = getInstanceGeneral(name);
  if (settings.ignoreGroups && jid.endsWith('@g.us')) {
    return { ok: false, imported: 0, batches: 0, done: false, error: 'groups_ignored_by_settings' };
  }

  const anySock = ctx.sock as any;
  if (typeof anySock.fetchMessageHistory !== 'function') {
    return { ok: false, imported: 0, batches: 0, done: false, error: 'history_fetch_not_supported' };
  }

  const maxBatches = Math.max(1, Math.min(Number(options?.maxBatches ?? 15), 50));
  const fetchCount = Math.max(10, Math.min(Number(options?.fetchCount ?? CONTINUOUS_HISTORY_FETCH_COUNT), 500));

  let imported = 0;
  let batches = 0;
  let done = false;

  for (let i = 0; i < maxBatches; i++) {
    const current = getInstanceChatMessages(name, jid);
    const oldest = current.length > 0 ? current[0] : undefined;
    const oldestKey = oldest
      ? {
          remoteJid: jid,
          id: oldest.id,
          fromMe: oldest.fromMe,
        }
      : undefined;
    const oldestTimestamp = oldest ? normalizeTimestamp(oldest.timestamp) : undefined;

    let response: unknown;
    try {
      response = await anySock.fetchMessageHistory(fetchCount, oldestKey, oldestTimestamp);
    } catch {
      return { ok: false, imported, batches, done: false, error: 'history_fetch_failed' };
    }

    const raw = extractMessagesFromHistoryResponse(response).filter((msg) => {
      const key = (msg.key ?? {}) as { remoteJid?: string };
      return String(key.remoteJid ?? '').trim() === jid;
    });
    if (raw.length === 0) {
      done = true;
      break;
    }

    const result = ingestMessagesToCache(name, raw, { fromHistory: true });
    imported += result.inserted;
    batches += 1;

    if (result.inserted === 0) {
      done = true;
      break;
    }
  }

  return { ok: true, imported, batches, done };
}

export function markInstanceChatAsRead(name: string, jid: string): void {
  const chats = chatCache.get(name);
  if (!chats) return;
  const chat = chats.get(jid);
  if (!chat) return;
  chat.unreadCount = 0;
  chats.set(jid, chat);
}

export async function applyReadSettingsToCachedMessages(name: string): Promise<{ ok: boolean; count: number }> {
  const ctx = instances.get(name);
  if (!ctx || typeof ctx.sock.readMessages !== 'function') {
    return { ok: false, count: 0 };
  }

  const settings = getInstanceGeneral(name);
  if (!settings.autoReadMessages && !settings.readStatus) {
    return { ok: true, count: 0 };
  }

  const chats = chatCache.get(name);
  if (!chats) {
    return { ok: true, count: 0 };
  }

  const keys = new Map<string, { remoteJid: string; id: string; fromMe?: boolean }>();
  for (const [jid, chat] of chats.entries()) {
    if (settings.ignoreGroups && jid.endsWith('@g.us')) continue;

    const readNormalChat = settings.autoReadMessages && jid !== 'status@broadcast';
    const readStatusChat = settings.readStatus && jid === 'status@broadcast';
    if (!readNormalChat && !readStatusChat) continue;

    for (const message of chat.messages) {
      if (message.fromMe) continue;
      keys.set(`${jid}:${message.id}`, {
        remoteJid: jid,
        id: message.id,
        fromMe: false,
      });
    }

    chat.unreadCount = 0;
    chats.set(jid, chat);
  }

  if (!keys.size) {
    return { ok: true, count: 0 };
  }

  try {
    await ctx.sock.readMessages([...keys.values()]);
    return { ok: true, count: keys.size };
  } catch {
    return { ok: false, count: keys.size };
  }
}
