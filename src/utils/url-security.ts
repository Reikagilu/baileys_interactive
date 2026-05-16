import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { promisify } from 'node:util';

export interface OutboundUrlValidationOptions {
  allowPrivateNetwork?: boolean;
  /** When true, also resolve hostname via DNS and reject if any resolved IP is private. */
  resolveDns?: boolean;
  /** Optional allow-list of ports. When omitted, any port is accepted. */
  allowedPorts?: number[];
}

export interface OutboundUrlValidationResult {
  ok: boolean;
  normalizedUrl?: string;
  error?:
    | 'invalid_url'
    | 'invalid_protocol'
    | 'url_credentials_not_allowed'
    | 'private_network_url_not_allowed'
    | 'port_not_allowed'
    | 'dns_resolution_failed';
  details?: string;
}

const dnsLookupAsync = promisify(dnsLookup);

function isPrivateIPv4(hostname: string): boolean {
  const segments = hostname.split('.').map((segment) => Number.parseInt(segment, 10));
  if (segments.length !== 4 || segments.some((segment) => !Number.isFinite(segment) || segment < 0 || segment > 255)) {
    return false;
  }
  const [a, b] = segments;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF
  if (a === 192 && b === 0 && segments[2] === 2) return true; // TEST-NET-1
  if (a === 198 && (b === 51 || b === 52) && segments[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && segments[2] === 113) return true; // TEST-NET-3
  if (a >= 224 && a <= 239) return true; // multicast
  if (a >= 240) return true; // reserved + broadcast
  return false;
}

function isPrivateIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized === '0:0:0:0:0:0:0:1' || normalized === '0:0:0:0:0:0:0:0') return true;
  if (normalized.startsWith('fe80:') || normalized.startsWith('fe80::')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  // IPv4-mapped IPv6: ::ffff:127.0.0.1
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (isIP(mapped) === 4) return isPrivateIPv4(mapped);
  }
  // IPv4-compatible (deprecated): ::a.b.c.d
  if (normalized.startsWith('::') && normalized.length > 2 && /\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    const last = normalized.slice(2);
    if (isIP(last) === 4) return isPrivateIPv4(last);
  }
  // Documentation: 2001:db8::/32
  if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001:db8::')) return true;
  return false;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home') ||
    normalized.endsWith('.lan') ||
    normalized.endsWith('.arpa') ||
    normalized.endsWith('.test') ||
    normalized.endsWith('.invalid') ||
    normalized.endsWith('.example')
  ) {
    return true;
  }
  // Edge case: hostname "0" routes to 127.0.0.1 on Linux.
  if (normalized === '0') return true;
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
  if (options.allowedPorts && options.allowedPorts.length > 0) {
    const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === 'https:' ? 443 : 80;
    if (!options.allowedPorts.includes(port)) {
      return { ok: false, error: 'port_not_allowed', details: `blocked_port=${port}` };
    }
  }
  return { ok: true, normalizedUrl: parsed.toString() };
}

/**
 * Async variant that also resolves the hostname via DNS and rejects when any
 * resolved IP is private. Use this for high-stakes outbound calls (webhooks,
 * integration tests) where DNS rebinding is a real concern.
 */
export async function validateOutboundUrlAsync(input: unknown, options: OutboundUrlValidationOptions = {}): Promise<OutboundUrlValidationResult> {
  const sync = validateOutboundUrl(input, options);
  if (!sync.ok) return sync;
  if (options.allowPrivateNetwork || !options.resolveDns) return sync;

  const parsed = new URL(sync.normalizedUrl!);
  // Skip DNS resolution if hostname is already an IP literal.
  if (isIP(parsed.hostname)) return sync;

  try {
    const addresses = await dnsLookupAsync(parsed.hostname, { all: true });
    for (const addr of addresses) {
      if (addr.family === 4 && isPrivateIPv4(addr.address)) {
        return {
          ok: false,
          error: 'private_network_url_not_allowed',
          details: `resolved_private_ip=${addr.address}`,
        };
      }
      if (addr.family === 6 && isPrivateIPv6(addr.address)) {
        return {
          ok: false,
          error: 'private_network_url_not_allowed',
          details: `resolved_private_ip=${addr.address}`,
        };
      }
    }
  } catch (err) {
    return { ok: false, error: 'dns_resolution_failed', details: String(err) };
  }
  return sync;
}
