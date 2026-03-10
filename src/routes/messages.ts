import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { getInstance } from '../services/whatsapp.js';
import { emitWebhookEvent } from '../services/webhooks.js';
import { getIdempotentResult, storeIdempotentResult } from '../services/idempotency.js';
import { emitInstanceEvent } from '../services/instance-config.js';
import { toJid, isUrl, normalizeInstanceName } from '../utils/helpers.js';
import type { MessageContent } from '../types/whatsapp.js';
import { sendError, sendOk } from '../utils/api-response.js';

const router = Router();
const MIN_TYPING_MS = 300;
const MAX_TYPING_MS = 10000;
const AUTO_TYPING_BASE_MS = 700;
const AUTO_TYPING_PER_CHAR_MS = 45;
const AUTO_TYPING_JITTER_MIN_MS = -250;
const AUTO_TYPING_JITTER_MAX_MS = 350;

function parseTypingMs(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded <= 0) return null;
  return Math.max(MIN_TYPING_MS, Math.min(MAX_TYPING_MS, rounded));
}

function parseTypingMode(raw: unknown): 'auto' | 'manual' | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (normalized === 'manual') return 'manual';
  return null;
}

function randomIntBetween(min: number, max: number): number {
  const floorMin = Math.ceil(min);
  const floorMax = Math.floor(max);
  return Math.floor(Math.random() * (floorMax - floorMin + 1)) + floorMin;
}

function computeAutoTypingMs(seedText: string): number {
  const jitter = randomIntBetween(AUTO_TYPING_JITTER_MIN_MS, AUTO_TYPING_JITTER_MAX_MS);
  const raw = AUTO_TYPING_BASE_MS + seedText.length * AUTO_TYPING_PER_CHAR_MS + jitter;
  return Math.max(MIN_TYPING_MS, Math.min(MAX_TYPING_MS, raw));
}

function extractTypingSeed(body: Record<string, unknown>, content: MessageContent | null): string {
  const bodyText = String(body.text ?? body.caption ?? body.name ?? '').trim();
  if (bodyText) return bodyText;

  if (content && typeof content === 'object') {
    const candidate = content as Record<string, unknown>;
    const text = String(candidate.text ?? candidate.caption ?? '').trim();
    if (text) return text;

    const poll = candidate.poll;
    if (poll && typeof poll === 'object') {
      const pollName = String((poll as Record<string, unknown>).name ?? '').trim();
      if (pollName) return pollName;
    }
  }

  return '';
}

function resolveTypingMs(
  body: Record<string, unknown>,
  content: MessageContent | null,
  explicitTypingMs?: number | null
): number | null {
  const manualTyping = explicitTypingMs ?? parseTypingMs(body.typingMs);
  if (manualTyping) return manualTyping;

  const mode = parseTypingMode(body.typingMode);
  if (mode !== 'auto') return null;

  const seedText = extractTypingSeed(body, content);
  return computeAutoTypingMs(seedText);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendMessageWithTyping(
  ctx: ReturnType<typeof validateInstance>,
  jid: string,
  content: MessageContent,
  typingMs: number | null
) {
  if (ctx && typingMs && typeof ctx.sock.sendPresenceUpdate === 'function') {
    try {
      await ctx.sock.presenceSubscribe?.(jid);
    } catch {
      // ignore subscribe failures
    }
    try {
      await ctx.sock.sendPresenceUpdate('composing', jid);
    } catch {
      // ignore presence failures
    }
    await sleep(typingMs);
    try {
      await ctx.sock.sendPresenceUpdate('paused', jid);
    } catch {
      // ignore presence failures
    }
  }
  return ctx?.sock.sendMessage(jid, content);
}

type InteractiveCta =
  | { type: 'url'; text: string; url: string }
  | { type: 'copy'; text: string; copy_code: string }
  | { type: 'call'; text: string; phone_number: string }
  | { type: 'reply'; text: string; id: string };

function validateInstance(instanceName: string, res: Response) {
  const ctx = getInstance(instanceName);
  if (!ctx) {
    sendError(res, 404, 'instance_not_found');
    return null;
  }
  if (ctx.status !== 'connected') {
    sendError(res, 409, 'instance_not_connected', 'Instance must be connected.', { status: ctx.status });
    return null;
  }
  return ctx;
}

function resolveInstanceName(rawInstance: unknown, res: Response): string | null {
  const instance = normalizeInstanceName(rawInstance, 'main');
  if (!instance) {
    sendError(res, 400, 'invalid_instance_name');
    return null;
  }
  return instance;
}

function parseMenuOptions(rawOptions: unknown): Array<{ id: string; text: string; description?: string }> {
  if (!Array.isArray(rawOptions)) return [];

  const options: Array<{ id: string; text: string; description?: string }> = [];
  rawOptions.forEach((option, index) => {
    if (typeof option === 'string') {
      const text = option.trim();
      if (!text) return;
      options.push({ id: String(index + 1), text });
      return;
    }

    if (!option || typeof option !== 'object') return;
    const entry = option as Record<string, unknown>;
    const text = String(entry.text ?? entry.title ?? '').trim();
    if (!text) return;

    const id = String(entry.id ?? index + 1).trim() || String(index + 1);
    const description = String(entry.description ?? '').trim();
    options.push({ id, text, ...(description ? { description } : {}) });
  });

  return options;
}

function parseInteractiveCtas(rawCtas: unknown): InteractiveCta[] {
  if (!Array.isArray(rawCtas)) return [];

  const ctas: InteractiveCta[] = [];
  rawCtas.forEach((cta, index) => {
    if (!cta || typeof cta !== 'object') return;
    const entry = cta as Record<string, unknown>;
    const text = String(entry.text ?? entry.label ?? '').trim();
    if (!text) return;

    const type = String(entry.type ?? 'reply').trim().toLowerCase();
    if (type === 'url') {
      const url = String(entry.url ?? '').trim();
      if (!isUrl(url)) return;
      ctas.push({ type: 'url', text, url });
      return;
    }

    if (type === 'copy') {
      const copyCode = String(entry.copy_code ?? entry.copyCode ?? '').trim();
      if (!copyCode) return;
      ctas.push({ type: 'copy', text, copy_code: copyCode });
      return;
    }

    if (type === 'call') {
      const phoneNumber = String(entry.phone_number ?? entry.phoneNumber ?? '').trim();
      if (!phoneNumber) return;
      ctas.push({ type: 'call', text, phone_number: phoneNumber });
      return;
    }

    const id = String(entry.id ?? `reply_${index + 1}`).trim() || `reply_${index + 1}`;
    ctas.push({ type: 'reply', text, id });
  });

  return ctas;
}

async function sendBasicMessage(
  req: Request,
  res: Response,
  contentFactory: (body: Record<string, unknown>) => MessageContent | null,
  validationError: string
): Promise<Response | void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const instance = resolveInstanceName(body.instance, res);
  if (!instance) return;
  const to = String(body.to ?? '').trim();

  const jid = toJid(to);
  if (!jid) {
    return sendError(res, 400, 'invalid_phone');
  }

  const ctx = validateInstance(instance, res);
  if (!ctx) return;

  const idempotencyKey = String(req.header('idempotency-key') ?? req.header('x-idempotency-key') ?? '').trim();
  if (idempotencyKey) {
    const cached = getIdempotentResult(idempotencyKey, `${req.path}|${instance}|${jid}`);
    if (cached) {
      return sendOk(res, {
        ...(cached.result ?? {}),
        idempotency: {
          key: idempotencyKey,
          replayed: true,
        },
      });
    }
  }

  const content = contentFactory(body);
  if (!content) {
    return sendError(res, 400, validationError);
  }

  const typingMs = resolveTypingMs(body, content);
  const sent = await sendMessageWithTyping(ctx, jid, content, typingMs);
  const resultPayload = {
    instance,
    to: jid,
    messageId: sent?.key?.id,
    idempotency: {
      key: idempotencyKey || null,
      replayed: false,
    },
  };

  if (idempotencyKey) {
    storeIdempotentResult(idempotencyKey, `${req.path}|${instance}|${jid}`, resultPayload);
  }

  emitWebhookEvent(
    'messages.upsert',
    {
      source: 'api',
      direction: 'outbound',
      instance,
      to: jid,
      messageId: sent?.key?.id,
      content,
    },
    instance
  );
  void emitInstanceEvent(instance, 'SEND_MESSAGE', {
    to: jid,
    messageId: sent?.key?.id,
    content,
  });

  return sendOk(res, resultPayload);
}

router.post('/text', (req: Request, res: Response) =>
  sendBasicMessage(
    req,
    res,
    (body) => {
      const text = String(body.text ?? '').trim();
      if (!text) return null;
      return { text };
    },
    'missing_text'
  )
);

router.post('/location', (req: Request, res: Response) =>
  sendBasicMessage(
    req,
    res,
    (body) => {
      const latitude = Number(body.latitude);
      const longitude = Number(body.longitude);
      const name = String(body.name ?? '').trim();
      const address = String(body.address ?? '').trim();
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const location: Record<string, unknown> = { degreesLatitude: latitude, degreesLongitude: longitude };
      if (name) location.name = name;
      if (address) location.address = address;
      const payload: MessageContent = { location };
      return payload;
    },
    'invalid_location_payload'
  )
);

router.post('/contact', (req: Request, res: Response) =>
  sendBasicMessage(
    req,
    res,
    (body) => {
      const displayName = String(body.displayName ?? body.name ?? '').trim();
      const contactNumber = String(body.phoneNumber ?? body.number ?? '').trim();
      const normalized = contactNumber.replace(/\D/g, '');
      if (!displayName || normalized.length < 10) return null;
      return {
        contacts: {
          displayName,
          contacts: [
            {
              displayName,
              vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:${displayName}\nTEL;type=CELL;type=VOICE;waid=${normalized}:${normalized}\nEND:VCARD`,
            },
          ],
        },
      };
    },
    'invalid_contact_payload'
  )
);

router.post('/reaction', (req: Request, res: Response) =>
  sendBasicMessage(
    req,
    res,
    (body) => {
      const messageId = String(body.messageId ?? '').trim();
      const reaction = String(body.reaction ?? body.text ?? '').trim();
      if (!messageId) return null;
      const to = String(body.to ?? '').trim();
      const remoteJid = toJid(to);
      if (!remoteJid) return null;
      return {
        react: {
          text: reaction,
          key: {
            id: messageId,
            remoteJid,
            fromMe: Boolean(body.fromMe),
          },
        },
      };
    },
    'invalid_reaction_payload'
  )
);

router.post('/media', (req: Request, res: Response) =>
  sendBasicMessage(
    req,
    res,
    (body) => {
      const mediaType = String(body.mediaType ?? '').trim();
      const mediaUrl = String(body.mediaUrl ?? '').trim();
      const caption = String(body.caption ?? '').trim();
      const fileName = String(body.fileName ?? '').trim();
      const mimetype = String(body.mimetype ?? '').trim();
      if (!mediaType || !mediaUrl || !isUrl(mediaUrl)) return null;

      const urlPayload = { url: mediaUrl };
      if (mediaType === 'image') return { image: urlPayload, ...(caption ? { caption } : {}) };
      if (mediaType === 'video') return { video: urlPayload, ...(caption ? { caption } : {}) };
      if (mediaType === 'audio') return { audio: urlPayload, ptt: Boolean(body.ptt) };
      if (mediaType === 'document') {
        const payload: MessageContent = { document: urlPayload };
        if (caption) payload.caption = caption;
        if (fileName) payload.fileName = fileName;
        if (mimetype) payload.mimetype = mimetype;
        return payload;
      }
      if (mediaType === 'sticker') return { sticker: urlPayload };
      return null;
    },
    'invalid_media_payload'
  )
);

router.post('/forward', (req: Request, res: Response) =>
  sendBasicMessage(
    req,
    res,
    (body) => {
      const text = String(body.text ?? '').trim();
      const forwardedContent = body.message;
      if (forwardedContent && typeof forwardedContent === 'object') {
        return forwardedContent as MessageContent;
      }
      if (text) {
        return { text };
      }
      return null;
    },
    'missing_message_or_text'
  )
);

/**
 * POST /v1/messages/send_menu
 */
router.post('/send_menu', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    instance?: string;
    to?: string;
    title?: string;
    text?: string;
    options?: Array<{ id: string; text: string; description?: string }>;
    footer?: string;
    typingMs?: number;
    typingMode?: 'auto' | 'manual';
  };

  const instance = resolveInstanceName(body.instance, res);
  if (!instance) return;
  const jid = toJid(body.to ?? '');
  if (!jid) return sendError(res, 400, 'invalid_phone');

  const options = parseMenuOptions(body.options);
  if (!body.text || options.length === 0) {
    return sendError(res, 400, 'missing_text_or_options');
  }

  const ctx = validateInstance(instance, res);
  if (!ctx) return;

  const lines = options.map((opt, idx) => `${idx + 1}. ${opt.text}${opt.description ? ` — ${opt.description}` : ''}`);
  const menuText = [body.title ? `*${body.title}*` : null, body.text, '', ...lines, body.footer ? `\n_${body.footer}_` : null]
    .filter(Boolean)
    .join('\n');

  const menuContent = { text: menuText } as MessageContent;
  const sent = await sendMessageWithTyping(ctx, jid, menuContent, resolveTypingMs(body as unknown as Record<string, unknown>, menuContent, parseTypingMs(body.typingMs)));
  return sendOk(res, { instance, to: jid, messageId: sent?.key?.id, style: 'plain_menu' });
});

/**
 * POST /v1/messages/send_buttons_helpers
 */
router.post('/send_buttons_helpers', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    instance?: string;
    to?: string;
    text?: string;
    footer?: string;
    buttons?: Array<{ id: string; text: string }>;
    typingMs?: number;
    typingMode?: 'auto' | 'manual';
  };

  const instance = resolveInstanceName(body.instance, res);
  if (!instance) return;
  const jid = toJid(body.to ?? '');
  if (!jid) return sendError(res, 400, 'invalid_phone');

  const buttons = Array.isArray(body.buttons) ? body.buttons : [];
  if (!body.text || buttons.length === 0) {
    return sendError(res, 400, 'missing_text_or_buttons');
  }
  if (buttons.length > config.limits.maxButtons) {
    return sendError(res, 400, 'too_many_buttons', undefined, { max: config.limits.maxButtons });
  }

  const ctx = validateInstance(instance, res);
  if (!ctx) return;

  const nativeButtons = buttons.map((b) => ({ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id }) }));

  const content = {
    text: body.text,
    footer: body.footer,
    interactiveButtons: {
      type: 'reply',
      buttons: nativeButtons,
    },
  } as MessageContent;
  const sent = await sendMessageWithTyping(ctx, jid, content, resolveTypingMs(body as unknown as Record<string, unknown>, content, parseTypingMs(body.typingMs)));

  return sendOk(res, { instance, to: jid, messageId: sent?.key?.id, style: 'native_buttons_reply' });
});

/**
 * POST /v1/messages/send_interactive_helpers
 */
router.post('/send_interactive_helpers', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    instance?: string;
    to?: string;
    text?: string;
    footer?: string;
    ctas?: unknown[];
    buttons?: unknown[];
    typingMs?: number;
    typingMode?: 'auto' | 'manual';
  };

  const instance = resolveInstanceName(body.instance, res);
  if (!instance) return;
  const jid = toJid(body.to ?? '');
  if (!jid) return sendError(res, 400, 'invalid_phone');

  const ctas = parseInteractiveCtas(body.ctas ?? body.buttons);
  if (!body.text || ctas.length === 0) {
    return sendError(res, 400, 'missing_text_or_ctas');
  }
  if (ctas.length > config.limits.maxButtons) {
    return sendError(res, 400, 'too_many_ctas', undefined, { max: config.limits.maxButtons });
  }

  const ctx = validateInstance(instance, res);
  if (!ctx) return;

  const buttons = ctas.map((cta) => {
    if (cta.type === 'url') return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: cta.text, url: cta.url }) };
    if (cta.type === 'copy') return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: cta.text, copy_code: cta.copy_code }) };
    if (cta.type === 'call') return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: cta.text, phone_number: cta.phone_number }) };
    return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: cta.text, id: cta.id }) };
  });

  const content = {
    text: body.text,
    footer: body.footer,
    interactiveButtons: {
      type: 'cta',
      buttons,
    },
  } as MessageContent;
  const sent = await sendMessageWithTyping(ctx, jid, content, resolveTypingMs(body as unknown as Record<string, unknown>, content, parseTypingMs(body.typingMs)));

  return sendOk(res, { instance, to: jid, messageId: sent?.key?.id, style: 'native_buttons_cta' });
});

/**
 * POST /v1/messages/send_list_helpers
 */
router.post('/send_list_helpers', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    instance?: string;
    to?: string;
    text?: string;
    footer?: string;
    buttonText?: string;
    sections?: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
    typingMs?: number;
    typingMode?: 'auto' | 'manual';
  };

  const instance = resolveInstanceName(body.instance, res);
  if (!instance) return;
  const jid = toJid(body.to ?? '');
  if (!jid) return sendError(res, 400, 'invalid_phone');

  const sections = Array.isArray(body.sections) ? body.sections : [];
  if (!body.text || !body.buttonText || sections.length === 0) {
    return sendError(res, 400, 'missing_text_or_sections');
  }
  if (sections.length > config.limits.maxListSections) {
    return sendError(res, 400, 'too_many_sections', undefined, { max: config.limits.maxListSections });
  }
  for (const section of sections) {
    if (!Array.isArray(section.rows) || section.rows.length === 0) {
      return sendError(res, 400, 'empty_section_rows');
    }
    if (section.rows.length > config.limits.maxListRowsPerSection) {
      return sendError(res, 400, 'too_many_rows_per_section', undefined, { max: config.limits.maxListRowsPerSection });
    }
  }

  const ctx = validateInstance(instance, res);
  if (!ctx) return;

  const content = {
    text: body.text,
    footer: body.footer,
    interactiveList: {
      type: 'nativeList',
      buttonText: body.buttonText,
      sections,
    },
  } as MessageContent;
  const sent = await sendMessageWithTyping(ctx, jid, content, resolveTypingMs(body as unknown as Record<string, unknown>, content, parseTypingMs(body.typingMs)));

  return sendOk(res, { instance, to: jid, messageId: sent?.key?.id, style: 'native_list' });
});

/**
 * POST /v1/messages/send_poll
 */
router.post('/send_poll', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    instance?: string;
    to?: string;
    name?: string;
    options?: string[];
    selectableCount?: number;
    typingMs?: number;
    typingMode?: 'auto' | 'manual';
  };

  const instance = resolveInstanceName(body.instance, res);
  if (!instance) return;
  const jid = toJid(body.to ?? '');
  if (!jid) return sendError(res, 400, 'invalid_phone');

  const options = Array.isArray(body.options) ? body.options.filter((s) => typeof s === 'string' && s.trim()) : [];
  if (!body.name || options.length < 2) {
    return sendError(res, 400, 'missing_name_or_options');
  }
  if (options.length > config.limits.maxPollOptions) {
    return sendError(res, 400, 'too_many_poll_options', undefined, { max: config.limits.maxPollOptions });
  }

  const selectableCount = Number.isInteger(body.selectableCount) ? Number(body.selectableCount) : 1;
  if (selectableCount < 1 || selectableCount > options.length) {
    return sendError(res, 400, 'invalid_selectable_count');
  }

  const ctx = validateInstance(instance, res);
  if (!ctx) return;

  const content = {
    poll: {
      name: body.name,
      values: options,
      selectableCount,
    },
  } as MessageContent;
  const sent = await sendMessageWithTyping(ctx, jid, content, resolveTypingMs(body as unknown as Record<string, unknown>, content, parseTypingMs(body.typingMs)));

  return sendOk(res, { instance, to: jid, messageId: sent?.key?.id, style: 'poll' });
});

/**
 * POST /v1/messages/send_carousel_helpers
 */
router.post('/send_carousel_helpers', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as {
    instance?: string;
    to?: string;
    text?: string;
    footer?: string;
    cards?: Array<{
      title: string;
      description?: string;
      body?: string;
      imageUrl?: string;
      buttons?: Array<{ id: string; text: string }>;
    }>;
    typingMs?: number;
    typingMode?: 'auto' | 'manual';
  };

  const instance = resolveInstanceName(body.instance, res);
  if (!instance) return;
  const jid = toJid(body.to ?? '');
  if (!jid) return sendError(res, 400, 'invalid_phone');

  const cards = Array.isArray(body.cards) ? body.cards : [];
  if (!body.text || cards.length === 0) {
    return sendError(res, 400, 'missing_text_or_cards');
  }
  if (cards.length > config.limits.maxCarouselCards) {
    return sendError(res, 400, 'too_many_cards', undefined, { max: config.limits.maxCarouselCards });
  }

  for (const card of cards) {
    const buttons = Array.isArray(card.buttons) ? card.buttons : [];
    if (buttons.length > config.limits.maxButtons) {
      return sendError(res, 400, 'too_many_card_buttons', undefined, { max: config.limits.maxButtons });
    }
  }

  const ctx = validateInstance(instance, res);
  if (!ctx) return;

  const carouselCards = cards.map((card) => ({
    title: card.title,
    description: card.description ?? card.body,
    image: card.imageUrl ? { url: card.imageUrl } : undefined,
    buttons: (card.buttons ?? []).map((button) => ({
      name: 'quick_reply',
      buttonParamsJson: JSON.stringify({ display_text: button.text, id: button.id }),
    })),
  }));

  const content = {
    text: body.text,
    footer: body.footer,
    interactiveCarousel: {
      type: 'nativeCarousel',
      cards: carouselCards,
    },
  } as MessageContent;
  const sent = await sendMessageWithTyping(ctx, jid, content, resolveTypingMs(body as unknown as Record<string, unknown>, content, parseTypingMs(body.typingMs)));

  return sendOk(res, { instance, to: jid, messageId: sent?.key?.id, style: 'native_carousel' });
});

export default router;
