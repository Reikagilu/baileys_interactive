import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  createInstance,
  getInstance,
  getAllInstances,
  normalizePairingPhoneNumber,
  removeInstance,
  requestInstancePairingCode,
  disconnectInstance,
  logoutInstance,
} from '../services/whatsapp.js';
import { config } from '../config.js';

const router = Router();

/**
 * POST /v1/instances
 * Cria uma nova instância e retorna o QR code em base64 (ou status se já conectada).
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { instance = 'main' } = req.body as { instance?: string };
    const name = String(instance).trim() || 'main';

    const result = await createInstance(name, config.authFolder);

    if (!result.ok) {
      return res.status(500).json({ ok: false, error: result.error });
    }

    let qrBase64: string | undefined;
    if (result.qr) {
      qrBase64 = await QRCode.toDataURL(result.qr, { width: 400, margin: 2 });
    }

    const ctx = getInstance(name);
    return res.json({
      ok: true,
      instance: name,
      status: ctx?.status ?? 'connecting',
      qr: qrBase64 ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
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

  let saved: string[] = [];
  const authDir = path.resolve(process.cwd(), config.authFolder);
  try {
    if (fs.existsSync(authDir)) {
      saved = fs.readdirSync(authDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    }
  } catch {
    saved = [];
  }

  return res.json({ ok: true, instances: list, saved });
});

/**
 * GET /v1/instances/saved
 * Lista apenas nomes das conexões salvas (pastas em auth/).
 */
router.get('/saved', (_req: Request, res: Response) => {
  const authDir = path.resolve(process.cwd(), config.authFolder);
  let saved: string[] = [];
  try {
    if (fs.existsSync(authDir)) {
      saved = fs.readdirSync(authDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    }
  } catch {
    saved = [];
  }
  return res.json({ ok: true, saved });
});

/**
 * GET /v1/instances/:name/qr
 * Retorna o QR code da instância em base64 (se estiver em estado qr).
 */
router.get('/:name/qr', async (req: Request, res: Response) => {
  const { name } = req.params;
  const ctx = getInstance(name);
  if (!ctx) {
    return res.status(404).json({ ok: false, error: 'instance_not_found' });
  }
  if (ctx.status !== 'qr' || !ctx.qr) {
    return res.status(400).json({ ok: false, error: 'no_qr_available', status: ctx.status });
  }
  const qrBase64 = await QRCode.toDataURL(ctx.qr, { width: 400, margin: 2 });
  return res.json({ ok: true, instance: name, qr: qrBase64 });
});

/**
 * POST /v1/instances/:name/pairing-code
 * Gera um pairing code para conectar sem QR.
 */
router.post('/:name/pairing-code', async (req: Request, res: Response) => {
  if (!config.pairing.enabled) {
    return res.status(403).json({ ok: false, error: 'pairing_code_disabled' });
  }

  const { name } = req.params;
  const body = (req.body ?? {}) as { phoneNumber?: string; number?: string };
  const rawPhone = String(body.phoneNumber ?? body.number ?? '').trim();
  if (!rawPhone) {
    return res.status(400).json({ ok: false, error: 'phone_number_required' });
  }

  const phoneNumber = normalizePairingPhoneNumber(rawPhone, config.pairing.defaultCountryCode);
  if (!phoneNumber) {
    return res.status(400).json({ ok: false, error: 'invalid_phone_number' });
  }

  let ctx = getInstance(name);
  if (!ctx) {
    const created = await createInstance(name, config.authFolder);
    if (!created.ok) {
      return res.status(500).json({ ok: false, instance: name, error: created.error ?? 'instance_create_failed' });
    }
    ctx = getInstance(name);
  }

  if (!ctx) {
    return res.status(500).json({ ok: false, instance: name, error: 'instance_not_available' });
  }

  if (ctx.status === 'qr') {
    disconnectInstance(name);
    const recreated = await createInstance(name, config.authFolder);
    if (!recreated.ok) {
      return res.status(500).json({ ok: false, instance: name, error: recreated.error ?? 'instance_recreate_failed' });
    }
    ctx = getInstance(name);
    if (!ctx) {
      return res.status(500).json({ ok: false, instance: name, error: 'instance_not_available' });
    }
  }

  const result = await requestInstancePairingCode(name, phoneNumber);
  if (!result.ok) {
    if (result.error === 'instance_already_connected') {
      return res.status(409).json({ ok: false, instance: name, error: result.error, status: result.status ?? ctx.status });
    }
    if (result.error === 'session_already_registered') {
      return res.status(409).json({ ok: false, instance: name, error: result.error, status: result.status ?? ctx.status });
    }
    if (result.error === 'instance_not_found') {
      return res.status(404).json({ ok: false, instance: name, error: result.error });
    }
    if (result.error === 'pairing_channel_not_ready' || result.error === 'empty_pairing_code' || result.error === 'pairing_code_unavailable') {
      return res.status(503).json({ ok: false, instance: name, error: result.error, status: result.status ?? ctx.status });
    }
    return res.status(400).json({ ok: false, instance: name, error: result.error ?? 'pairing_code_failed', status: result.status ?? ctx.status });
  }

  return res.json({
    ok: true,
    instance: name,
    status: result.status ?? ctx.status,
    phoneNumber,
    pairingCode: result.pairingCode,
  });
});

/**
 * GET /v1/instances/:name
 * Status de uma instância.
 */
router.get('/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const ctx = getInstance(name);
  if (!ctx) {
    return res.status(404).json({ ok: false, error: 'instance_not_found' });
  }
  return res.json({
    ok: true,
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
  const removed = disconnectInstance(name);
  return res.json({ ok: removed, instance: name });
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
      return res.status(500).json({ ok: false, instance: name, error: result.error });
    }
    return res.json({ ok: true, instance: name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, error: message });
  }
});

/**
 * DELETE /v1/instances/:name
 * Remove a instância (fecha socket, não apaga credenciais em disco).
 */
router.delete('/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const removed = removeInstance(name);
  return res.json({ ok: removed, instance: name });
});

export default router;
