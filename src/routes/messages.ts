import { Router, type Request, type Response } from 'express';
import { getInstance } from '../services/whatsapp.js';
import { toJid, isConnected } from '../utils/helpers.js';
import { config } from '../config.js';

const router = Router();

function validateInstance(instanceName: string, res: Response): ReturnType<typeof getInstance> {
  const ctx = getInstance(instanceName);
  if (!ctx) {
    res.status(404).json({ ok: false, error: 'instance_not_found' });
    return undefined;
  }
  if (!isConnected(ctx)) {
    res.status(400).json({ ok: false, error: 'instance_not_connected', status: ctx.status });
    return undefined;
  }
  return ctx;
}

// --- 1. MENU TEXTO (opções numeradas) ---
router.post('/send_menu', async (req: Request, res: Response) => {
  try {
    const { instance = 'main', to, title, text, options, footer } = req.body as {
      instance?: string;
      to: string;
      title?: string;
      text?: string;
      options: string[];
      footer?: string;
    };

    if (!to || !Array.isArray(options) || options.length === 0) {
      return res.status(400).json({ ok: false, error: 'missing to/options' });
    }

    const ctx = validateInstance(instance, res);
    if (!ctx) return;

    const jid = toJid(to);
    if (!jid) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    let menuText = '';
    if (title) menuText += `*${title}*\n\n`;
    if (text) menuText += `${text}\n\n`;
    options.forEach((opt, idx) => {
      const label = typeof opt === 'string' ? opt : (opt as { text?: string }).text ?? `Opção ${idx + 1}`;
      menuText += `*${idx + 1}.* ${label}\n`;
    });
    if (footer) menuText += `\n_${footer}_`;

    await ctx.sock.sendMessage(jid, { text: menuText.trim() });
    return res.json({ ok: true, hint: 'User should reply with the option number (1, 2, 3...)' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

// --- 2. BOTÕES QUICK REPLY (nativeButtons) ---
router.post('/send_buttons_helpers', async (req: Request, res: Response) => {
  try {
    const { instance = 'main', to, text, buttons, footer } = req.body as {
      instance?: string;
      to: string;
      text: string;
      buttons: Array<{ id: string; text: string }>;
      footer?: string;
    };

    if (!to || !text || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ ok: false, error: 'missing to/text/buttons' });
    }
    const limited = buttons.slice(0, config.limits.maxButtons);

    const ctx = validateInstance(instance, res);
    if (!ctx) return;

    const jid = toJid(to);
    if (!jid) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    const nativeButtons = limited.map((btn, idx) => ({
      type: 'reply' as const,
      id: btn.id ?? `btn_${idx}`,
      text: btn.text ?? `Botão ${idx + 1}`,
    }));

    const result = await ctx.sock.sendMessage(jid, {
      nativeButtons,
      text: String(text),
      footer: footer ? String(footer) : undefined,
    });

    return res.json({ ok: true, format: 'nativeButtons', messageId: result?.key?.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

// --- 3. BOTÕES CTA (URL, COPY, CALL) ---
router.post('/send_interactive_helpers', async (req: Request, res: Response) => {
  try {
    const { instance = 'main', to, text, buttons, footer } = req.body as {
      instance?: string;
      to: string;
      text: string;
      buttons: Array<{
        type: 'url' | 'copy' | 'call';
        text: string;
        url?: string;
        copyCode?: string;
        copyText?: string;
        phoneNumber?: string;
      }>;
      footer?: string;
    };

    if (!to || !text || !Array.isArray(buttons) || buttons.length === 0) {
      return res.status(400).json({ ok: false, error: 'missing to/text/buttons' });
    }

    const ctx = validateInstance(instance, res);
    if (!ctx) return;

    const jid = toJid(to);
    if (!jid) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    const nativeButtons = buttons.slice(0, config.limits.maxButtons).map((btn, idx) => {
      const type = (btn.type ?? 'reply').toLowerCase();
      if (type === 'url' || btn.url) {
        return { type: 'url' as const, text: btn.text ?? 'Abrir', url: btn.url! };
      }
      if (type === 'copy' || btn.copyCode || btn.copyText) {
        return { type: 'copy' as const, text: btn.text ?? 'Copiar', copyText: btn.copyCode ?? btn.copyText ?? '' };
      }
      if (type === 'call' || btn.phoneNumber) {
        return { type: 'call' as const, text: btn.text ?? 'Ligar', phoneNumber: btn.phoneNumber! };
      }
      return { type: 'reply' as const, id: `btn_${idx}`, text: btn.text ?? 'Botão' };
    });

    const result = await ctx.sock.sendMessage(jid, {
      nativeButtons,
      text: String(text),
      footer: footer ? String(footer) : undefined,
    });

    return res.json({ ok: true, format: 'nativeButtons', messageId: result?.key?.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

// --- 4. LISTA DROPDOWN (nativeList) ---
router.post('/send_list_helpers', async (req: Request, res: Response) => {
  try {
    const { instance = 'main', to, text, footer, buttonText, sections } = req.body as {
      instance?: string;
      to: string;
      text: string;
      footer?: string;
      buttonText: string;
      sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>;
    };

    if (!to || !text || !buttonText || !Array.isArray(sections) || sections.length === 0) {
      return res.status(400).json({ ok: false, error: 'missing to/text/buttonText/sections' });
    }

    const ctx = validateInstance(instance, res);
    if (!ctx) return;

    const jid = toJid(to);
    if (!jid) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    const result = await ctx.sock.sendMessage(jid, {
      nativeList: {
        buttonText: String(buttonText),
        sections: sections.map((s) => ({
          title: s.title ?? 'Opções',
          rows: (s.rows ?? []).map((row, idx) => ({
            id: row.id ?? `row_${idx}`,
            title: row.title ?? 'Item',
            description: row.description ?? '',
          })),
        })),
      },
      text: String(text),
      footer: footer ? String(footer) : undefined,
    });

    return res.json({ ok: true, format: 'nativeList', messageId: result?.key?.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

// --- 5. ENQUETE / POLL ---
router.post('/send_poll', async (req: Request, res: Response) => {
  try {
    const { instance = 'main', to, name, options, selectableCount } = req.body as {
      instance?: string;
      to: string;
      name: string;
      options: string[];
      selectableCount?: number;
    };

    if (!to || !name || !Array.isArray(options) || options.length < 2) {
      return res.status(400).json({ ok: false, error: 'missing to/name/options (min 2)' });
    }
    const opts = options.slice(0, config.limits.maxPollOptions).map((o) => (typeof o === 'string' ? o : String(o)));

    const ctx = validateInstance(instance, res);
    if (!ctx) return;

    const jid = toJid(to);
    if (!jid) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    // Formato que funciona no InfiniteAPI/Baileys: poll com name, values e selectableCount
    const result = await ctx.sock.sendMessage(jid, {
      poll: {
        name: String(name),
        values: opts,
        selectableCount: Math.min(Math.max(1, selectableCount ?? 1), opts.length),
      },
    });
    return res.json({ ok: true, messageId: result?.key?.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

// --- 6. CARROSSEL (nativeCarousel) ---
router.post('/send_carousel_helpers', async (req: Request, res: Response) => {
  try {
    const { instance = 'main', to, text, footer, cards } = req.body as {
      instance?: string;
      to: string;
      text?: string;
      footer?: string;
      cards: Array<{
        title?: string;
        body?: string;
        footer?: string;
        imageUrl?: string;
        buttons?: Array<{ id: string; text: string }>;
      }>;
    };

    if (!to || !Array.isArray(cards) || cards.length === 0) {
      return res.status(400).json({ ok: false, error: 'missing to/cards' });
    }
    const limited = cards.slice(0, config.limits.maxCarouselCards);

    const ctx = validateInstance(instance, res);
    if (!ctx) return;

    const jid = toJid(to);
    if (!jid) return res.status(400).json({ ok: false, error: 'invalid_phone' });

    const formattedCards = limited.map((card, idx) => ({
      title: card.title ?? `Card ${idx + 1}`,
      body: card.body ?? '',
      footer: card.footer,
      image: card.imageUrl ? { url: card.imageUrl } : undefined,
      buttons: (card.buttons ?? []).map((btn, bIdx) => ({
        type: 'reply' as const,
        id: btn.id ?? `card${idx}_btn${bIdx}`,
        text: btn.text ?? 'Botão',
      })),
    }));

    const result = await ctx.sock.sendMessage(jid, {
      nativeCarousel: { cards: formattedCards },
      text: text ? String(text) : undefined,
      footer: footer ? String(footer) : undefined,
    });

    return res.json({ ok: true, format: 'nativeCarousel', messageId: result?.key?.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

export default router;
