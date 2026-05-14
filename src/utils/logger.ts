/**
 * Centralized logger with ANSI color support.
 *
 * Levels:
 *   info  → plain text (white)
 *   warn  → yellow
 *   error → bold red
 *   debug → dim/gray  (only when LOG_LEVEL=debug)
 *   success → green
 *
 * Format:
 *   [HH:MM:SS] [MODULE] [INSTANCE?] MESSAGE  key=value ...
 *
 * Colors are auto-disabled when stdout is not a TTY (e.g. Docker log drivers,
 * files) so structured output stays readable. Set NO_COLOR=1 to force-disable
 * or FORCE_COLOR=1 to force-enable.
 */

// ── ANSI codes ──────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const WHITE  = '\x1b[37m';
const BRIGHT_RED    = '\x1b[91m';
const BRIGHT_YELLOW = '\x1b[93m';
const BRIGHT_CYAN   = '\x1b[96m';

function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

let _colorEnabled: boolean | null = null;
function colorEnabled(): boolean {
  if (_colorEnabled === null) _colorEnabled = useColor();
  return _colorEnabled;
}

function c(code: string, text: string): string {
  return colorEnabled() ? `${code}${text}${RESET}` : text;
}

// ── Log level ───────────────────────────────────────────────────────────────
type Level = 'debug' | 'info' | 'success' | 'warn' | 'error';

const LOG_LEVEL_RANK: Record<Level, number> = {
  debug: 0,
  info: 1,
  success: 1,
  warn: 2,
  error: 3,
};

function activeLevel(): Level {
  const env = (process.env.LOG_LEVEL ?? '').toLowerCase();
  if (env === 'debug') return 'debug';
  if (env === 'warn')  return 'warn';
  if (env === 'error') return 'error';
  return 'info';
}

function shouldLog(level: Level): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[activeLevel()];
}

// ── Timestamp ───────────────────────────────────────────────────────────────
function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ── Core formatter ──────────────────────────────────────────────────────────
function format(level: Level, module: string, instance: string | undefined, message: string): string {
  const ts = c(DIM, `[${timestamp()}]`);

  // Module badge
  let moduleBadge: string;
  switch (level) {
    case 'error':   moduleBadge = c(`${BOLD}${BRIGHT_RED}`,    `[${module}]`); break;
    case 'warn':    moduleBadge = c(BRIGHT_YELLOW,              `[${module}]`); break;
    case 'success': moduleBadge = c(GREEN,                      `[${module}]`); break;
    case 'debug':   moduleBadge = c(DIM,                        `[${module}]`); break;
    default:        moduleBadge = c(BRIGHT_CYAN,                `[${module}]`); break;
  }

  // Instance badge (highlighted separately so it stands out)
  const instanceBadge = instance
    ? c(`${BOLD}${CYAN}`, `[${instance}]`) + ' '
    : '';

  // Message styling
  let msg: string;
  switch (level) {
    case 'error':   msg = c(`${BOLD}${RED}`, message); break;
    case 'warn':    msg = c(YELLOW, message); break;
    case 'success': msg = c(GREEN, message); break;
    case 'debug':   msg = c(DIM, message); break;
    default:        msg = c(WHITE, message); break;
  }

  return `${ts} ${moduleBadge} ${instanceBadge}${msg}`;
}

// ── Extra args serializer ───────────────────────────────────────────────────
function serializeExtra(extra: unknown[]): string {
  if (extra.length === 0) return '';
  return ' ' + extra
    .map((a) => {
      if (a instanceof Error) {
        const stack = a.stack ?? `${a.name}: ${a.message}`;
        return colorEnabled()
          ? `\n${c(`${BOLD}${RED}`, '  Error:')} ${c(RED, stack)}`
          : `\n  Error: ${stack}`;
      }
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    })
    .join(' ');
}

// ── Logger factory ──────────────────────────────────────────────────────────

export interface Logger {
  info   (msg: string, ...extra: unknown[]): void;
  success(msg: string, ...extra: unknown[]): void;
  warn   (msg: string, ...extra: unknown[]): void;
  error  (msg: string, ...extra: unknown[]): void;
  debug  (msg: string, ...extra: unknown[]): void;
  /** Returns a child logger with a fixed instance name. */
  child  (instance: string): Logger;
}

function makeLogger(module: string, instance?: string): Logger {
  function log(level: Level, msg: string, extra: unknown[]): void {
    if (!shouldLog(level)) return;
    const line = format(level, module, instance, msg) + serializeExtra(extra);
    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  return {
    info   (msg, ...extra) { log('info',    msg, extra); },
    success(msg, ...extra) { log('success', msg, extra); },
    warn   (msg, ...extra) { log('warn',    msg, extra); },
    error  (msg, ...extra) { log('error',   msg, extra); },
    debug  (msg, ...extra) { log('debug',   msg, extra); },
    child  (inst: string)  { return makeLogger(module, inst); },
  };
}

// ── Named module loggers ────────────────────────────────────────────────────

export const log = {
  /** General application / startup logs */
  app:        makeLogger('app'),
  /** WhatsApp instance manager */
  whatsapp:   makeLogger('whatsapp'),
  /** Chatwoot bridge */
  chatwoot:   makeLogger('chatwoot-bridge'),
  /** HTTP request access logs */
  http:       makeLogger('http'),
  /** Webhook delivery worker */
  webhook:    makeLogger('webhook-worker'),
  /** Audit service */
  audit:      makeLogger('audit'),
  /** Message store */
  msgStore:   makeLogger('message-store'),
  /** Security / auth warnings */
  security:   makeLogger('security'),
  /** Generic factory for ad-hoc modules */
  module:     (name: string) => makeLogger(name),
};

export default log;
