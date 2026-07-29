import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { parseApiKeyConfiguration } from '../middleware/api-auth.js';

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);

test('API_KEYS_JSON accepts documented object form', () => {
  const parsed = parseApiKeyConfiguration('', JSON.stringify({
    automation: { key: KEY_A, scopes: ['instances:*', 'messages:send'] },
  }));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.records, [{
    keyId: 'automation',
    key: KEY_A,
    scopes: ['instances:*', 'messages:send'],
  }]);
});

test('API_KEYS_JSON keeps backwards-compatible array form', () => {
  const parsed = parseApiKeyConfiguration('', JSON.stringify([
    { id: 'operator', key: KEY_B, scopes: ['*'] },
  ]));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.records[0]?.keyId, 'operator');
});

test('invalid or empty API_KEYS_JSON is rejected instead of opening the API', () => {
  assert.ok(parseApiKeyConfiguration('', '{bad').errors.length > 0);
  assert.ok(parseApiKeyConfiguration('', '{}').records.length === 0);
  assert.ok(parseApiKeyConfiguration('', JSON.stringify({ broken: { scopes: ['*'] } })).errors.length > 0);
});

test('duplicate key ids and material are rejected', () => {
  const parsed = parseApiKeyConfiguration(KEY_A, JSON.stringify([
    { id: 'default', key: KEY_A, scopes: ['*'] },
  ]));
  assert.ok(parsed.errors.some((error) => error.includes('duplicate API key id')));
  assert.ok(parsed.errors.some((error) => error.includes('duplicate API key material')));
});

test('production boot fails closed for invalid API_KEYS_JSON', () => {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), 'beyound-auth-config-test-'));
  try {
    const result = spawnSync(process.execPath, ['dist/index.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        API_KEY: '',
        API_KEYS_JSON: '{}',
        PORT: '0',
        AUTH_FOLDER: path.join(runtimeDir, 'auth'),
        AUDIT_LOG_PATH: path.join(runtimeDir, 'audit.log'),
        WEBHOOK_DB_PATH: path.join(runtimeDir, 'webhooks.sqlite'),
        INTEGRATIONS_DB_PATH: path.join(runtimeDir, 'integrations.sqlite'),
        MESSAGES_DB_PATH: path.join(runtimeDir, 'messages.sqlite'),
      },
      encoding: 'utf8',
      timeout: 15_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /API key configuration/i);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});
