#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import dotenv from 'dotenv';

const result = dotenv.config();
const failures = [];
const warnings = [];

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) failures.push(`Node.js 20+ is required (found ${process.versions.node}).`);
if (result.error) failures.push('Missing .env. Run: cp .env.example .env');

const apiKey = String(process.env.API_KEY ?? '').trim();
const placeholders = /replace|change-me|your-|example|generate/i;
if (apiKey.length < 32 || placeholders.test(apiKey)) {
  failures.push('API_KEY must be a random value with at least 32 characters. Generate one with: openssl rand -hex 32');
}

const serverUrl = String(process.env.SERVER_URL ?? '').trim();
try {
  const parsed = new URL(serverUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('protocol');
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    warnings.push('SERVER_URL uses HTTP in production. Put Beyound behind HTTPS before exposing it.');
  }
} catch {
  failures.push('SERVER_URL must be an absolute http(s) URL.');
}

for (const path of ['package.json', 'docker-compose.yml', 'src/index.ts']) {
  if (!fs.existsSync(path)) failures.push(`Required project file is missing: ${path}`);
}

if (!process.env.COMPOSE_PROJECT_NAME) {
  warnings.push('COMPOSE_PROJECT_NAME is unset. Set it to keep volume names stable when the folder is renamed.');
}
if (process.env.PUBLIC_DOCS_ENABLED === 'true') warnings.push('PUBLIC_DOCS_ENABLED=true exposes API documentation without a key.');
if (process.env.PUBLIC_METRICS_ENABLED === 'true') warnings.push('PUBLIC_METRICS_ENABLED=true exposes metrics without a key.');
if (process.env.ALLOW_PRIVATE_NETWORK_WEBHOOKS === 'true') warnings.push('Private-network webhook destinations are enabled.');
if (!process.env.CHATWOOT_WEBHOOK_SECRET && process.env.NODE_ENV === 'production') warnings.push('CHATWOOT_WEBHOOK_SECRET is not configured.');

for (const warning of warnings) console.warn(`WARN: ${warning}`);
if (failures.length) {
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  console.error(`\nDoctor found ${failures.length} blocking issue(s).`);
  process.exit(1);
}
console.log(`OK: Beyound configuration is usable (${warnings.length} warning(s)).`);
