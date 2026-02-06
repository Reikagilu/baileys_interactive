import path from 'node:path';
import fs from 'node:fs';
import type { InstanceContext } from '../types/whatsapp.js';

const instances = new Map<string, InstanceContext>();

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

/**
 * Cria e inicia uma nova instância WhatsApp (InfiniteAPI/Baileys).
 * Gera QR code até o usuário escanear e conectar.
 * Em 515 (restartRequired) recria o socket automaticamente após 2s.
 */
export async function createInstance(
  name: string,
  authFolder: string
): Promise<{ ok: boolean; instance: string; qr?: string; error?: string }> {
  if (instances.has(name)) {
    const ctx = instances.get(name)!;
    if (ctx.status === 'connected') {
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

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      version,
      browser: Browsers.windows('Chrome'),
    }) as InstanceContext['sock'];

    const ctx: InstanceContext = {
      name,
      sock,
      status: 'connecting',
      qr: null,
      createdAt: new Date(),
      authFolder,
    };
    instances.set(name, ctx);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ((update: unknown) => {
      const { connection, qr, lastDisconnect } = (update ?? {}) as {
        connection?: string;
        qr?: string;
        lastDisconnect?: { error?: { output?: { statusCode?: number } } };
      };

      if (qr) {
        ctx.status = 'qr';
        ctx.qr = qr;
      }

      if (connection === 'open') {
        ctx.status = 'connected';
        ctx.qr = null;
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        ctx.status = 'disconnected';
        ctx.qr = null;

        if (code === DisconnectReason.loggedOut || code === DisconnectReason.connectionReplaced) {
          closeSocket(ctx.sock);
          instances.delete(name);
          return;
        }

        // 515 = restartRequired: pairing concluído, WA pede reinício. Recriar socket com o mesmo auth.
        if (code === DisconnectReason.restartRequired) {
          const folder = ctx.authFolder;
          closeSocket(ctx.sock);
          instances.delete(name);
          setTimeout(() => {
            createInstance(name, folder).catch(() => {});
          }, 2000);
        }
      }
    }));

    return { ok: true, instance: name, qr: ctx.qr ?? undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, instance: name, error: message };
  }
}

/**
 * Desconecta e remove a instância da memória (credenciais permanecem em disco).
 */
export function disconnectInstance(name: string): boolean {
  const ctx = instances.get(name);
  if (!ctx) return false;
  closeSocket(ctx.sock);
  instances.delete(name);
  return true;
}

/**
 * Logout + apaga pasta de auth e remove instância. Próxima conexão gerará novo QR.
 */
export async function logoutInstance(name: string, authFolder: string): Promise<{ ok: boolean; error?: string }> {
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
