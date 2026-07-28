#!/usr/bin/env node
/**
 * Persistent compatibility patch for the Baileys version installed by npm ci.
 *
 * Baileys >= 7.0.0-rc12 already includes the former Beyound workarounds for
 * protocol-message validation, atomic auth writes and stale peer-session cache.
 * We intentionally do not reapply the old stanza pre-decrypt dedupe or
 * note-to-self decrypt suppression: both can discard a legitimate redelivery.
 *
 * Remaining patch: Node Readable.pipe() does not forward source errors to the
 * decrypt transform. A truncated Undici/CDN body must reject the consumer,
 * not surface later as an uncaughtException.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(root, 'node_modules', 'baileys', 'package.json');
const target = path.join(root, 'node_modules', 'baileys', 'lib', 'Utils', 'messages-media.js');
const marker = '[beyound-undici-stream-error-forward]';

function fail(message) {
  console.error(`[patch-baileys] ERRO: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(packagePath) || !fs.existsSync(target)) {
  fail("Baileys não instalado. Rode 'npm ci' antes do patch.");
}
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const match = String(pkg.version ?? '').match(/^7\.0\.0-rc\.?([0-9]+)$/);
if (!match || Number(match[1]) < 12) {
  fail(`versão insegura/não suportada do Baileys: ${pkg.version}; esperado >= 7.0.0-rc12`);
}

let source = fs.readFileSync(target, 'utf8');
if (source.includes(marker)) {
  console.log(`[patch-baileys] patch já aplicado em Baileys ${pkg.version}. Nada a fazer.`);
  process.exit(0);
}

const anchor = `    return fetched.pipe(output, { end: true });`;
const replacement = `    // [beyound-undici-stream-error-forward]\n    // Readable.pipe() does not forward source errors to the destination.\n    // Forward explicitly so a truncated CDN body rejects the consumer instead\n    // of becoming an uncaughtException in the process.\n    fetched.on('error', error => output.destroy(error));\n    return fetched.pipe(output, { end: true });`;
if (!source.includes(anchor)) {
  fail('âncora fetched.pipe não encontrada; layout do Baileys mudou.');
}
source = source.replace(anchor, replacement);
fs.writeFileSync(target, source, 'utf8');
console.log(`[patch-baileys] undici-stream-error-forward aplicado em Baileys ${pkg.version}.`);
