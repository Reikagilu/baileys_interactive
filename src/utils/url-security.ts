import { isIP } from 'node:net';

export interface OutboundUrlValidationOptions {
  allowPrivateNetwork?: boolean;
}

export interface OutboundUrlValidationResult {
  ok: boolean;
  normalizedUrl?: string;
  error?:
    | 'invalid_url'
    | 'invalid_protocol'
    | 'url_credentials_not_allowed'
    | 'private_network_url_not_allowed';
  details?: string;
}

function isPrivateIPv4(hostname: string): boolean {
  const segments = hostname.split('.').map((segment) => Number.parseInt(segment, 10));
  if (segments.length !== 4 || segments.some((segment) => !Number.isFinite(segment) || segment < 0 || segment > 255)) {
    return false;
  }

  const [a, b] = segments;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.home')
    || normalized.endsWith('.lan')
    || normalized.endsWith('.arpa')
  ) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateIPv4(normalized);
  if (ipVersion === 6) return isPrivateIPv6(normalized);

  return false;
}

export function validateOutboundUrl(input: unknown, options: OutboundUrlValidationOptions = {}): OutboundUrlValidationResult {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'invalid_url' };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'invalid_protocol' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'url_credentials_not_allowed' };
  }

  if (!options.allowPrivateNetwork && isPrivateHostname(parsed.hostname)) {
    return {
      ok: false,
      error: 'private_network_url_not_allowed',
      details: `blocked_host=${parsed.hostname.toLowerCase()}`,
    };
  }

  return { ok: true, normalizedUrl: parsed.toString() };
}
