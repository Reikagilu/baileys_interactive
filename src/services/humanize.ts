/**
 * Humanization helpers — masking robotic patterns that the WhatsApp servers
 * heuristically use to flag automated accounts.
 *
 * Goals:
 *   - Add jitter to all fixed cadences (intervals, retries, delays).
 *   - Stagger bursts of actions (read receipts, history fetches, attachment
 *     sends) so they look like a person, not a script.
 *   - Centralize tunables in one place so we can tweak across the codebase.
 *
 * Config policy: each instance has a `humanize` block in GeneralConfig. When
 * `humanize.enabled === false` the helpers degrade gracefully and resolve
 * with no delay (zero sleep, zero jitter) — so the panel can opt-out fast.
 */

import { getInstanceGeneral } from './instance-config.js';

/** Sleep, but resolves immediately if `ms <= 0`. */
export function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random integer in [min, max] inclusive. */
export function randomIntBetween(min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

/**
 * Apply ±jitterPct around a base value. Example: jitter(10_000, 0.3) returns
 * a number in [7_000, 13_000]. `jitterPct` is clamped to [0, 1].
 */
export function jitter(baseMs: number, jitterPct = 0.3): number {
  const pct = Math.max(0, Math.min(1, jitterPct));
  if (pct === 0) return Math.max(0, baseMs);
  const delta = baseMs * pct;
  const min = baseMs - delta;
  const max = baseMs + delta;
  return Math.max(0, Math.floor(min + Math.random() * (max - min)));
}

/**
 * Read the humanize block of an instance with safe defaults. Defaults to ON
 * with conservative numbers — operators can override per instance via the
 * panel. If `humanize.enabled === false`, callers must still receive numbers
 * (we hand back the structured object), but should branch on `enabled`.
 */
export interface HumanizeSettings {
  enabled: boolean;
  /** Random pre-send wait in ms (uniform). 0 disables. */
  preSendMinMs: number;
  preSendMaxMs: number;
  /** Random sleep between consecutive attachments in a Chatwoot dispatch. */
  betweenAttachmentsMinMs: number;
  betweenAttachmentsMaxMs: number;
  /** Auto-typing duration model when sending text. */
  typingBaseMs: number;
  typingPerCharMs: number;
  typingMinMs: number;
  typingMaxMs: number;
  /** Auto-read delay (ms) before marking incoming messages as read. */
  autoReadDelayMinMs: number;
  autoReadDelayMaxMs: number;
  /** Max chats to mark-read per batch when ack-ing many at once. */
  autoReadChunkSize: number;
  autoReadChunkSleepMinMs: number;
  autoReadChunkSleepMaxMs: number;
  /** History sync cadence (ms) — applied with ±jitter. */
  historySyncBaseMs: number;
  historySyncJitterPct: number;
  /** Chats per history-sync tick. */
  historyBatchChats: number;
  /** Sleep between two consecutive fetchMessageHistory calls. */
  historyFetchSleepMinMs: number;
  historyFetchSleepMaxMs: number;
  /** Always-online ping cadence + jitter. */
  alwaysOnlineBaseMs: number;
  alwaysOnlineJitterPct: number;
  /** Call rejection delay (ms). 0 disables (immediate reject). */
  rejectCallMinMs: number;
  rejectCallMaxMs: number;
}

const DEFAULT_HUMANIZE: HumanizeSettings = {
  enabled: true,
  preSendMinMs: 250,
  preSendMaxMs: 900,
  betweenAttachmentsMinMs: 900,
  betweenAttachmentsMaxMs: 2500,
  typingBaseMs: 800,
  typingPerCharMs: 50,
  typingMinMs: 600,
  typingMaxMs: 9000,
  autoReadDelayMinMs: 2500,
  autoReadDelayMaxMs: 11000,
  autoReadChunkSize: 8,
  autoReadChunkSleepMinMs: 400,
  autoReadChunkSleepMaxMs: 1500,
  historySyncBaseMs: 10 * 60 * 1000, // 10min base, ±30% = [7min, 13min]
  historySyncJitterPct: 0.3,
  historyBatchChats: 2,
  historyFetchSleepMinMs: 900,
  historyFetchSleepMaxMs: 2400,
  alwaysOnlineBaseMs: 75_000, // ~75s base, ±25% = [56s, 94s]
  alwaysOnlineJitterPct: 0.25,
  rejectCallMinMs: 1500,
  rejectCallMaxMs: 6000,
};

/**
 * Returns the merged humanize settings for an instance. Reads from
 * GeneralConfig.humanize (when present) and falls back to defaults per field
 * — that way partial config blobs from older instances still work.
 */
export function getHumanizeSettings(instance: string): HumanizeSettings {
  const general = getInstanceGeneral(instance) as { humanize?: Partial<HumanizeSettings> };
  const patch = general.humanize ?? {};
  return { ...DEFAULT_HUMANIZE, ...patch };
}

/** Helper: respect enabled flag and resolve to 0 when off. */
export function humanizedSleep(instance: string, minMs: number, maxMs: number): Promise<void> {
  const cfg = getHumanizeSettings(instance);
  if (!cfg.enabled) return Promise.resolve();
  return sleep(randomIntBetween(minMs, maxMs));
}

/** Compute auto-typing ms based on text length, clamped + jittered. */
export function computeTypingMs(instance: string, text: string): number {
  const cfg = getHumanizeSettings(instance);
  if (!cfg.enabled) return 0;
  const baseLen = (text ?? '').length;
  const raw = cfg.typingBaseMs + baseLen * cfg.typingPerCharMs;
  const jittered = jitter(raw, 0.25);
  return Math.max(cfg.typingMinMs, Math.min(cfg.typingMaxMs, jittered));
}

export { DEFAULT_HUMANIZE };
