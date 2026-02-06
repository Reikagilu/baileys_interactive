import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  createInstance,
  getInstance,
  getAllInstances,
  removeInstance,
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
