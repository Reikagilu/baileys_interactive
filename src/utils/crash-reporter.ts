// Crash reporting — observa process.on('uncaughtException') e
// 'unhandledRejection', persiste o stack trace completo em
// /app/data/crashes.log, e dispara webhook 'process.crash'.
//
// Por que: a falha F1 observada em 2026-07-19T21:18:18 mostrou que
// `TypeError: terminated` em um Readable não tratado derruba o processo
// sem nenhum alerta visível. Logs do Docker rotacionam em ~10min,
// então o stack trace se perde antes do operador notar.
//
// Aqui escrevemos o stack em arquivo persistente (volume /app/data)
// e tentamos emitir o webhook antes do Node morrer. Como o evento é
// síncrono, a escrita do arquivo é garantida; o webhook é best-effort.

import fs from 'node:fs';
import path from 'node:path';
import { emitWebhookEvent } from '../services/webhooks.js';
import { recordCrash as metricsRecordCrash } from './metrics.js';

const CRASH_LOG_PATH = path.resolve(process.cwd(), 'data', 'crashes.log');
const CRASH_LIMIT = 200; // manter últimas 200 entradas

export interface CrashReport {
  ts: string;
  kind: 'uncaughtException' | 'unhandledRejection' | 'fatalError';
  message: string;
  stack?: string;
  exitCode?: number;
}

function ensureCrashDir(): void {
  const dir = path.dirname(CRASH_LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function trimLog(): void {
  try {
    const content = fs.readFileSync(CRASH_LOG_PATH, 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    if (lines.length <= CRASH_LIMIT) return;
    const keep = lines.slice(-CRASH_LIMIT);
    fs.writeFileSync(CRASH_LOG_PATH, keep.join('\n') + '\n');
  } catch {
    // ignore
  }
}

function appendCrashLine(line: string): void {
  try {
    ensureCrashDir();
    fs.appendFileSync(CRASH_LOG_PATH, line + '\n');
    trimLog();
  } catch (err) {
    // Não podemos fazer muito — pelo menos tenta stderr
    try { process.stderr.write(`crash-reporter: falha ao escrever crash log: ${String(err)}\n`); } catch {}
  }
}

export function recordCrash(report: CrashReport): void {
  // Linha única com payload JSON legível (stack truncado pra 12 linhas)
  const stackOneLine = (report.stack ?? '').split('\n').slice(0, 12).join(' | ');
  const line = JSON.stringify({
    ts: report.ts,
    kind: report.kind,
    msg: report.message,
    exit: report.exitCode,
    stack: stackOneLine,
  });
  appendCrashLine(line);
}

/**
 * Dispara webhook 'process.crash' para hooks registrados.
 * Best-effort: se falhar (DB travado, etc.), pelo menos o arquivo
 * crashes.log já tem o stack.
 */
export function emitCrashWebhook(report: CrashReport): void {
  try {
    emitWebhookEvent('process.crash', report, undefined);
  } catch (err) {
    try { process.stderr.write(`crash-reporter: webhook emit failed: ${String(err)}\n`); } catch {}
  }
}

/**
 * Registra os handlers de uncaughtException e unhandledRejection.
 * Idempotente: pode ser chamado mais de uma vez sem duplicar listeners.
 */
let installed = false;
export function installCrashHandlers(): void {
  if (installed) return;
  installed = true;

  process.on('uncaughtException', (err, origin) => {
    const report: CrashReport = {
      ts: new Date().toISOString(),
      kind: 'uncaughtException',
      message: err?.message ?? String(err),
      stack: err?.stack,
    };
    recordCrash(report);
    metricsRecordCrash();
    emitCrashWebhook(report);
    try {
      process.stderr.write(
        `\n[crash-reporter] uncaughtException at ${report.ts}\n` +
        `  message: ${report.message}\n` +
        `  origin: ${String(origin)}\n` +
        `  stack: ${(err?.stack ?? '').split('\n').slice(0, 20).join('\n  ')}\n`
      );
    } catch {}
  });

  process.on('unhandledRejection', (reason, _promise) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    const report: CrashReport = {
      ts: new Date().toISOString(),
      kind: 'unhandledRejection',
      message: err.message,
      stack: err.stack,
    };
    recordCrash(report);
    metricsRecordCrash();
    emitCrashWebhook(report);
    try {
      process.stderr.write(
        `\n[crash-reporter] unhandledRejection at ${report.ts}\n` +
        `  message: ${report.message}\n` +
        `  stack: ${(err.stack ?? '').split('\n').slice(0, 20).join('\n  ')}\n`
      );
    } catch {}
  });
}

export const CRASH_LOG_FILE = CRASH_LOG_PATH;