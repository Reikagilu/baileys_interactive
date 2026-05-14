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
export interface Logger {
    info(msg: string, ...extra: unknown[]): void;
    success(msg: string, ...extra: unknown[]): void;
    warn(msg: string, ...extra: unknown[]): void;
    error(msg: string, ...extra: unknown[]): void;
    debug(msg: string, ...extra: unknown[]): void;
    /** Returns a child logger with a fixed instance name. */
    child(instance: string): Logger;
}
export declare const log: {
    /** General application / startup logs */
    app: Logger;
    /** WhatsApp instance manager */
    whatsapp: Logger;
    /** Chatwoot bridge */
    chatwoot: Logger;
    /** HTTP request access logs */
    http: Logger;
    /** Webhook delivery worker */
    webhook: Logger;
    /** Audit service */
    audit: Logger;
    /** Message store */
    msgStore: Logger;
    /** Security / auth warnings */
    security: Logger;
    /** Generic factory for ad-hoc modules */
    module: (name: string) => Logger;
};
export default log;
