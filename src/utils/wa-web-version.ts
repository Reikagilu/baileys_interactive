export type WaWebVersion = [number, number, number];
export type WaWebVersionSource = 'env' | 'online' | 'fallback';

// Latest protocol revision validated against web.whatsapp.com/sw.js on 2026-07-31.
// Used only when WHATSAPP_WEB_VERSION is empty and online discovery fails.
export const FALLBACK_WA_WEB_VERSION: WaWebVersion = [2, 3000, 1044254868];

function normalizeWaWebVersion(value: unknown): WaWebVersion | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const version = value.slice(0, 3).map(Number);
  if (!version.every((part) => Number.isSafeInteger(part) && part >= 0)) return null;
  return [version[0], version[1], version[2]];
}

export function parseConfiguredWaWebVersion(raw: string | undefined): WaWebVersion | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('WHATSAPP_WEB_VERSION must contain exactly three numeric components, for example 2.3000.1044254868');
  }
  const version = normalizeWaWebVersion(value.split('.'));
  if (!version) throw new Error('WHATSAPP_WEB_VERSION contains an invalid numeric component');
  return version;
}

export async function resolveWaWebVersion(
  configured: WaWebVersion | null,
  fetchLatest: () => Promise<{ version?: unknown }>,
): Promise<{ version: WaWebVersion; source: WaWebVersionSource }> {
  if (configured) return { version: configured, source: 'env' };
  try {
    const discovered = normalizeWaWebVersion((await fetchLatest()).version);
    if (discovered) return { version: discovered, source: 'online' };
  } catch {
    // Deterministic fallback below keeps reconnects working during network/API failures.
  }
  return { version: [...FALLBACK_WA_WEB_VERSION], source: 'fallback' };
}

export function formatWaWebVersion(version: WaWebVersion): string {
  return version.join('.');
}
