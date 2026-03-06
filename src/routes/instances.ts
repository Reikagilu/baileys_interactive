import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  createInstance,
  getInstance,
  getAllInstances,
  getInstanceChatList,
  getInstanceChatMessages,
  markInstanceChatAsRead,
  normalizePairingPhoneNumber,
  removeInstance,
  requestInstancePairingCode,
  disconnectInstance,
  logoutInstance,
  applyInstanceRuntimeSettings,
  applyReadSettingsToCachedMessages,
  syncInstanceChatHistory,
} from '../services/whatsapp.js';
import { config } from '../config.js';
import { writeAuditEvent } from '../services/audit-log.js';
import {
  INSTANCE_EVENT_NAMES,
  emitInstanceEvent,
  getInstancePanelConfig,
  updateInstanceEvents,
  updateInstanceGeneral,
  updateInstanceProxy,
} from '../services/instance-config.js';
import { isValidInstanceName, normalizeInstanceName } from '../utils/helpers.js';
import { sendError, sendOk } from '../utils/api-response.js';
import { validateOutboundUrl } from '../utils/url-security.js';

const router = Router();

function listSavedInstances(): string[] {
  const authDir = path.resolve(process.cwd(), config.authFolder);
  try {
    if (!fs.existsSync(authDir)) return [];
    return fs.readdirSync(authDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidInstanceName(entry.name))
      .map((entry) => entry.name.trim());
  } catch {
    return [];
  }
}

router.param('name', (req, res, next, rawName: string) => {
  const instance = normalizeInstanceName(rawName);
  if (!instance) {
    return sendError(res, 400, 'invalid_instance_name');
  }
  req.params.name = instance;
  next();
});

/**
 * POST /v1/instances
 * Cria uma nova instância e retorna o QR code em base64 (ou status se já conectada).
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { instance = 'main' } = req.body as { instance?: string };
    const name = normalizeInstanceName(instance, 'main');
    if (!name) {
      return sendError(res, 400, 'invalid_instance_name');
    }

    const result = await createInstance(name, config.authFolder);

    if (!result.ok) {
      return sendError(res, 500, 'instance_create_failed', result.error);
    }

    let qrBase64: string | undefined;
    if (result.qr) {
      qrBase64 = await QRCode.toDataURL(result.qr, { width: 400, margin: 2 });
    }

    const ctx = getInstance(name);
    writeAuditEvent(req, res, {
      action: 'instances.create_or_connect',
      target: name,
      details: { status: ctx?.status ?? 'connecting' },
    });
    return sendOk(res, {
      instance: name,
      status: ctx?.status ?? 'connecting',
      qr: qrBase64 ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendError(res, 500, 'instance_create_failed', message);
  }
});

/**
 * GET /v1/instances
 * Lista instâncias ativas e salvas (pastas em auth/).
 */
router.get('/', (_req: Request, res: Response) => {
  const list = getAllInstances().map((ctx) => ({
    instance: ctx.name,
    status: ctx.status,
    hasQr: Boolean(ctx.qr),
    createdAt: ctx.createdAt.toISOString(),
  }));

  const saved = listSavedInstances();

  return sendOk(res, { instances: list, saved });
});

/**
 * GET /v1/instances/saved
 * Lista apenas nomes das conexões salvas (pastas em auth/).
 */
router.get('/saved', (_req: Request, res: Response) => {
  const saved = listSavedInstances();
  return sendOk(res, { saved });
});

/**
 * GET /v1/instances/:name/qr
 * Retorna o QR code da instância em base64 (se estiver em estado qr).
 */
router.get('/:name/qr', async (req: Request, res: Response) => {
  const { name } = req.params;
  const ctx = getInstance(name);
  if (!ctx) {
    return sendError(res, 404, 'instance_not_found');
  }
  if (ctx.status !== 'qr' || !ctx.qr) {
    return sendError(res, 400, 'no_qr_available', undefined, { status: ctx.status });
  }
  const qrBase64 = await QRCode.toDataURL(ctx.qr, { width: 400, margin: 2 });
  return sendOk(res, { instance: name, qr: qrBase64 });
});

/**
 * POST /v1/instances/:name/pairing-code
 * Gera um pairing code para conectar sem QR.
 */
router.post('/:name/pairing-code', async (req: Request, res: Response) => {
  if (!config.pairing.enabled) {
    return sendError(res, 403, 'pairing_code_disabled');
  }

  const { name } = req.params;
  const body = (req.body ?? {}) as { phoneNumber?: string; number?: string };
  const rawPhone = String(body.phoneNumber ?? body.number ?? '').trim();
  if (!rawPhone) {
    return sendError(res, 400, 'phone_number_required');
  }

  const phoneNumber = normalizePairingPhoneNumber(rawPhone, config.pairing.defaultCountryCode);
  if (!phoneNumber) {
    return sendError(res, 400, 'invalid_phone_number');
  }

  let ctx = getInstance(name);
  let justCreatedOrReset = false;
  if (!ctx) {
    const created = await createInstance(name, config.authFolder);
    if (!created.ok) {
      return sendError(res, 500, 'instance_create_failed', created.error, { instance: name });
    }
    ctx = getInstance(name);
    justCreatedOrReset = true;
  }

  if (!ctx) {
    return sendError(res, 500, 'instance_not_available', undefined, { instance: name });
  }

  if (ctx.status !== 'connected' && !justCreatedOrReset && config.pairing.forceFreshSession) {
    await logoutInstance(name, config.authFolder);
    const recreatedFresh = await createInstance(name, config.authFolder);
    if (!recreatedFresh.ok) {
      return sendError(res, 500, 'instance_recreate_failed', recreatedFresh.error, { instance: name });
    }
    ctx = getInstance(name);
    justCreatedOrReset = true;
    if (!ctx) {
      return sendError(res, 500, 'instance_not_available', undefined, { instance: name });
    }
  }

  if (ctx.status === 'qr' || ctx.status === 'disconnected') {
    disconnectInstance(name);
    const recreated = await createInstance(name, config.authFolder);
    if (!recreated.ok) {
      return sendError(res, 500, 'instance_recreate_failed', recreated.error, { instance: name });
    }
    ctx = getInstance(name);
    justCreatedOrReset = true;
    if (!ctx) {
      return sendError(res, 500, 'instance_not_available', undefined, { instance: name });
    }
  }

  if (justCreatedOrReset) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  let result = await requestInstancePairingCode(name, phoneNumber);

  const transientPairingError = (() => {
    const errorText = String(result.error ?? '').toLowerCase();
    return (
      result.error === 'pairing_channel_not_ready' ||
      result.error === 'empty_pairing_code' ||
      result.error === 'pairing_code_unavailable' ||
      errorText.includes('connection closed') ||
      errorText.includes('stream errored') ||
      errorText.includes('timed out')
    );
  })();

  if (!result.ok && transientPairingError) {
    disconnectInstance(name);
    const recreated = await createInstance(name, config.authFolder);
    if (recreated.ok) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      result = await requestInstancePairingCode(name, phoneNumber);
    }
  }

  if (!result.ok) {
    if (result.error === 'instance_already_connected') {
      return sendError(res, 409, result.error, undefined, { instance: name, status: result.status ?? ctx.status });
    }
    if (result.error === 'session_already_registered') {
      return sendError(res, 409, result.error, undefined, { instance: name, status: result.status ?? ctx.status });
    }
    if (result.error === 'instance_not_found') {
      return sendError(res, 404, result.error, undefined, { instance: name });
    }
    if (
      result.error === 'pairing_channel_not_ready' ||
      result.error === 'empty_pairing_code' ||
      result.error === 'pairing_code_unavailable' ||
      result.error === 'pairing_code_unstable'
    ) {
      return sendError(res, 503, result.error, undefined, { instance: name, status: result.status ?? ctx.status });
    }
    return sendError(res, 400, result.error ?? 'pairing_code_failed', undefined, {
      instance: name,
      status: result.status ?? ctx.status,
    });
  }

  writeAuditEvent(req, res, {
    action: 'instances.pairing_code.generate',
    target: name,
    details: { phoneNumber },
  });

  return sendOk(res, {
    instance: name,
    status: result.status ?? ctx.status,
    phoneNumber,
    pairingCode: result.pairingCode,
  });
});

/**
 * GET /v1/instances/:name/details
 * Detalhes ricos para tela da conexão.
 */
router.get('/:name/details', (req: Request, res: Response) => {
  const { name } = req.params;
  const ctx = getInstance(name);
  const panel = getInstancePanelConfig(name);

  if (!ctx) {
    return sendOk(res, {
      instance: name,
      status: 'disconnected',
      hasQr: false,
      createdAt: new Date().toISOString(),
      linkedNumber: null,
      profileName: null,
      profilePictureUrl: null,
      settings: panel,
    });
  }

  return sendOk(res, {
    instance: ctx.name,
    status: ctx.status,
    hasQr: Boolean(ctx.qr),
    createdAt: ctx.createdAt.toISOString(),
    linkedNumber: ctx.linkedNumber ?? null,
    profileName: ctx.profileName ?? null,
    profilePictureUrl: ctx.profilePictureUrl ?? null,
    settings: panel,
  });
});

/**
 * POST /v1/instances/:name/restart
 * Reinicia a conexão mantendo sessão (quando possível).
 */
router.post('/:name/restart', async (req: Request, res: Response) => {
  const { name } = req.params;
  const existed = Boolean(getInstance(name));
  disconnectInstance(name, { keepAutostart: true });
  const recreated = await createInstance(name, config.authFolder);
  if (!recreated.ok) {
    return sendError(res, 500, 'instance_restart_failed', recreated.error, { instance: name });
  }

  writeAuditEvent(req, res, {
    action: 'instances.restart',
    target: name,
    details: { existed },
  });

  return sendOk(res, { instance: name });
});

/**
 * GET /v1/instances/:name/chats
 */
router.get('/:name/chats', (req: Request, res: Response) => {
  const { name } = req.params;
  if (!getInstance(name)) {
    return sendError(res, 404, 'instance_not_found');
  }
  return sendOk(res, { instance: name, chats: getInstanceChatList(name) });
});

/**
 * GET /v1/instances/:name/chats/:jid/messages
 */
router.get('/:name/chats/:jid/messages', (req: Request, res: Response) => {
  const { name, jid } = req.params;
  if (!getInstance(name)) {
    return sendError(res, 404, 'instance_not_found');
  }
  const decodedJid = decodeURIComponent(jid);
  markInstanceChatAsRead(name, decodedJid);
  return sendOk(res, { instance: name, jid: decodedJid, messages: getInstanceChatMessages(name, decodedJid) });
});

/**
 * POST /v1/instances/:name/chats/:jid/messages
 * Envia mensagem de texto para o chat selecionado no painel.
 */
router.post('/:name/chats/:jid/messages', async (req: Request, res: Response) => {
  const { name, jid } = req.params;
  const ctx = getInstance(name);
  if (!ctx) {
    return sendError(res, 404, 'instance_not_found');
  }
  if (ctx.status !== 'connected') {
    return sendError(res, 409, 'instance_not_connected', undefined, { status: ctx.status });
  }

  const body = (req.body ?? {}) as { text?: string };
  const text = String(body.text ?? '').trim();
  if (!text) {
    return sendError(res, 400, 'text_required');
  }

  const decodedJid = decodeURIComponent(jid);
  try {
    const sent = await ctx.sock.sendMessage(decodedJid, { text });
    writeAuditEvent(req, res, {
      action: 'instances.chat.send_message',
      target: name,
      details: { jid: decodedJid },
    });

    await emitInstanceEvent(name, 'SEND_MESSAGE', {
      to: decodedJid,
      messageId: sent?.key?.id ?? null,
      text,
      source: 'instance_panel_chat',
    });

    return sendOk(res, {
      instance: name,
      jid: decodedJid,
      messageId: sent?.key?.id ?? null,
      timestamp: sent?.messageTimestamp ?? Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendError(res, 500, 'send_message_failed', message || 'send_message_failed');
  }
});

/**
 * POST /v1/instances/:name/chats/:jid/sync-history
 * Busca mensagens antigas do chat selecionado em lotes.
 */
router.post('/:name/chats/:jid/sync-history', async (req: Request, res: Response) => {
  const { name, jid } = req.params;
  const decodedJid = decodeURIComponent(jid);
  const body = (req.body ?? {}) as { maxBatches?: number; fetchCount?: number };

  const result = await syncInstanceChatHistory(name, decodedJid, {
    maxBatches: body.maxBatches,
    fetchCount: body.fetchCount,
  });

  if (!result.ok) {
    const statusCode =
      result.error === 'instance_not_found' ? 404
        : result.error === 'instance_not_connected' ? 409
          : result.error === 'groups_ignored_by_settings' ? 400
            : result.error === 'history_fetch_not_supported' ? 501
              : 500;
    return sendError(res, statusCode, result.error ?? 'sync_history_failed', undefined, {
      instance: name,
      jid: decodedJid,
      imported: result.imported,
      batches: result.batches,
      done: result.done,
    });
  }

  writeAuditEvent(req, res, {
    action: 'instances.chat.sync_history',
    target: name,
    details: {
      jid: decodedJid,
      imported: result.imported,
      batches: result.batches,
      done: result.done,
    },
  });

  return sendOk(res, {
    instance: name,
    jid: decodedJid,
    imported: result.imported,
    batches: result.batches,
    done: result.done,
  });
});

/**
 * GET /v1/instances/:name/settings
 */
router.get('/:name/settings', (req: Request, res: Response) => {
  const { name } = req.params;
  const panel = getInstancePanelConfig(name);
  return sendOk(res, { instance: name, proxy: panel.proxy, general: panel.general });
});

/**
 * PATCH /v1/instances/:name/settings/general
 */
router.patch('/:name/settings/general', async (req: Request, res: Response) => {
  const { name } = req.params;
  const before = getInstancePanelConfig(name);
  const body = (req.body ?? {}) as {
    rejectCalls?: boolean;
    ignoreGroups?: boolean;
    alwaysOnline?: boolean;
    autoReadMessages?: boolean;
    syncFullHistory?: boolean;
    readStatus?: boolean;
  };

  const updated = updateInstanceGeneral(name, {
    rejectCalls: body.rejectCalls,
    ignoreGroups: body.ignoreGroups,
    alwaysOnline: body.alwaysOnline,
    autoReadMessages: body.autoReadMessages,
    syncFullHistory: body.syncFullHistory,
    readStatus: body.readStatus,
  });

  writeAuditEvent(req, res, {
    action: 'instances.settings.general.update',
    target: name,
    details: updated.general,
  });

  const runtime = applyInstanceRuntimeSettings(name);
  const readSyncEnabled =
    (!before.general.autoReadMessages && updated.general.autoReadMessages)
    || (!before.general.readStatus && updated.general.readStatus);
  const readSyncResult = readSyncEnabled
    ? await applyReadSettingsToCachedMessages(name)
    : { ok: true, count: 0 };

  const syncRestartTriggered = false;
  const syncRestartOk = false;
  const syncRestartError: string | undefined = undefined;
  const requiresReconnect = runtime.requiresReconnect;

  return sendOk(res, {
    instance: name,
    general: updated.general,
    runtimeApplied: runtime.ok,
    readSyncApplied: readSyncResult.ok,
    readSyncCount: readSyncResult.count,
    syncRestartTriggered,
    syncRestartOk,
    syncRestartError,
    requiresReconnect,
  });
});

/**
 * PATCH /v1/instances/:name/settings/proxy
 */
router.patch('/:name/settings/proxy', (req: Request, res: Response) => {
  const { name } = req.params;
  const before = getInstancePanelConfig(name);
  const body = (req.body ?? {}) as {
    enabled?: boolean;
    protocol?: string;
    host?: string;
    port?: string;
    username?: string;
    password?: string;
  };

  const nextEnabled = body.enabled ?? before.proxy.enabled;
  const nextHost = String(body.host ?? before.proxy.host).trim();
  const nextPort = String(body.port ?? before.proxy.port).trim();
  if (nextEnabled && (!nextHost || !nextPort)) {
    return sendError(res, 400, 'proxy_host_port_required');
  }

  const updated = updateInstanceProxy(name, {
    enabled: body.enabled,
    protocol: body.protocol,
    host: body.host,
    port: body.port,
    username: body.username,
    password: body.password,
  });

  writeAuditEvent(req, res, {
    action: 'instances.settings.proxy.update',
    target: name,
    details: {
      enabled: updated.proxy.enabled,
      protocol: updated.proxy.protocol,
      host: updated.proxy.host,
      port: updated.proxy.port,
      hasCredentials: Boolean(updated.proxy.username || updated.proxy.password),
    },
  });

  const requiresReconnect =
    before.proxy.enabled !== updated.proxy.enabled
    || before.proxy.protocol !== updated.proxy.protocol
    || before.proxy.host !== updated.proxy.host
    || before.proxy.port !== updated.proxy.port
    || before.proxy.username !== updated.proxy.username
    || before.proxy.password !== updated.proxy.password;

  return sendOk(res, {
    instance: name,
    proxy: updated.proxy,
    requiresReconnect,
  });
});

/**
 * GET /v1/instances/:name/events
 */
router.get('/:name/events', (req: Request, res: Response) => {
  const { name } = req.params;
  const panel = getInstancePanelConfig(name);
  return sendOk(res, {
    instance: name,
    webhookUrl: panel.events.webhookUrl,
    toggles: panel.events.toggles,
    availableEvents: INSTANCE_EVENT_NAMES,
  });
});

/**
 * PATCH /v1/instances/:name/events
 */
router.patch('/:name/events', (req: Request, res: Response) => {
  const { name } = req.params;
  const body = (req.body ?? {}) as {
    webhookUrl?: string;
    toggles?: Partial<Record<(typeof INSTANCE_EVENT_NAMES)[number], boolean>>;
  };

  if (body.webhookUrl !== undefined) {
    const webhookUrl = String(body.webhookUrl).trim();
    if (webhookUrl) {
      const validation = validateOutboundUrl(webhookUrl, {
        allowPrivateNetwork: config.security.allowPrivateNetworkWebhooks,
      });
      if (!validation.ok) {
        return sendError(res, 400, 'invalid_webhook_url', 'Webhook URL blocked by security policy.', {
          reason: validation.error,
          details: validation.details,
        });
      }
      body.webhookUrl = validation.normalizedUrl ?? webhookUrl;
    }
  }

  const updated = updateInstanceEvents(name, {
    webhookUrl: body.webhookUrl,
    toggles: body.toggles,
  });

  writeAuditEvent(req, res, {
    action: 'instances.events.update',
    target: name,
    details: {
      webhookUrl: updated.events.webhookUrl,
      enabledEvents: Object.entries(updated.events.toggles)
        .filter(([, value]) => value)
        .map(([key]) => key),
    },
  });

  return sendOk(res, { instance: name, events: updated.events });
});

/**
 * POST /v1/instances/:name/events/test
 */
router.post('/:name/events/test', async (req: Request, res: Response) => {
  const { name } = req.params;
  const body = (req.body ?? {}) as { event?: string };
  const eventName = String(body.event ?? 'APPLICATION_STARTUP').trim().toUpperCase();
  if (!INSTANCE_EVENT_NAMES.includes(eventName as (typeof INSTANCE_EVENT_NAMES)[number])) {
    return sendError(res, 400, 'invalid_event_name');
  }

  const testResult = await emitInstanceEvent(
    name,
    eventName as (typeof INSTANCE_EVENT_NAMES)[number],
    {
      source: 'manual_test',
    },
    {
      ignoreToggle: true,
    }
  );

  if (!testResult.ok) {
    const statusCode = testResult.skipped ? 400 : 502;
    return sendError(res, statusCode, testResult.error ?? 'event_test_failed', undefined, {
      instance: name,
      event: eventName,
      skipped: testResult.skipped,
      status: testResult.status,
    });
  }

  writeAuditEvent(req, res, {
    action: 'instances.events.test',
    target: name,
    details: { event: eventName },
  });

  return sendOk(res, { instance: name, event: eventName, status: testResult.status ?? 200 });
});

/**
 * GET /v1/instances/:name
 * Status de uma instância.
 */
router.get('/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const ctx = getInstance(name);
  if (!ctx) {
    return sendError(res, 404, 'instance_not_found');
  }
  return sendOk(res, {
    instance: ctx.name,
    status: ctx.status,
    hasQr: Boolean(ctx.qr),
    createdAt: ctx.createdAt.toISOString(),
  });
});

/**
 * POST /v1/instances/:name/disconnect
 * Desconecta e remove a instância da memória (credenciais ficam em disco; reconectar pode usar sessão salva).
 */
router.post('/:name/disconnect', (req: Request, res: Response) => {
  const { name } = req.params;
  if (!getInstance(name)) {
    return sendError(res, 404, 'instance_not_found');
  }
  const removed = disconnectInstance(name);
  void emitInstanceEvent(name, 'CONNECTION_UPDATE', { status: 'disconnected', source: 'manual_disconnect' });
  writeAuditEvent(req, res, {
    action: 'instances.disconnect',
    target: name,
    outcome: removed ? 'success' : 'failure',
  });
  return sendOk(res, { instance: name, disconnected: removed });
});

/**
 * POST /v1/instances/:name/logout
 * Logout + apaga pasta de auth. Próxima conexão gera novo QR.
 */
router.post('/:name/logout', async (req: Request, res: Response) => {
  try {
    const { name } = req.params;
    const result = await logoutInstance(name, config.authFolder);
    if (!result.ok) {
      if (result.error === 'invalid_instance_name') {
        return sendError(res, 400, result.error, undefined, { instance: name });
      }
      return sendError(res, 500, 'instance_logout_failed', result.error, { instance: name });
    }
    await emitInstanceEvent(name, 'LOGOUT_INSTANCE', { source: 'api' });
    writeAuditEvent(req, res, {
      action: 'instances.logout',
      target: name,
      details: { authFolder: config.authFolder },
    });
    return sendOk(res, { instance: name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendError(res, 500, 'instance_logout_failed', message);
  }
});

/**
 * DELETE /v1/instances/:name
 * Remove a instância (fecha socket, não apaga credenciais em disco).
 */
router.delete('/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  if (!getInstance(name)) {
    return sendError(res, 404, 'instance_not_found');
  }
  const removed = removeInstance(name);
  if (removed) {
    void emitInstanceEvent(name, 'REMOVE_INSTANCE', { source: 'api' });
  }
  writeAuditEvent(req, res, {
    action: 'instances.remove',
    target: name,
    outcome: removed ? 'success' : 'failure',
  });
  if (!removed) {
    return sendError(res, 500, 'instance_remove_failed', undefined, { instance: name });
  }
  return sendOk(res, { instance: name, removed: true });
});

export default router;
