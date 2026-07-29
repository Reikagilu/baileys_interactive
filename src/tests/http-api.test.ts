import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';

const API_KEY = 'integration-test-api-key-do-not-use';
let runtimeDir = '';
let baseUrl = '';
let serverProcess: ChildProcessWithoutNullStreams | null = null;
let serverLogs = '';

function appendServerLog(chunk: Buffer | string): void {
  serverLogs += String(chunk);
  if (serverLogs.length > 20_000) serverLogs = serverLogs.slice(-20_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const tempServer = createServer();
    tempServer.once('error', reject);
    tempServer.listen(0, '127.0.0.1', () => {
      const address = tempServer.address();
      if (!address || typeof address === 'string') {
        tempServer.close(() => reject(new Error('failed_to_resolve_test_port')));
        return;
      }
      tempServer.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServerReady(timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`server_not_ready\n${serverLogs}`);
}

async function stopServer(): Promise<void> {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const child = serverProcess;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    sleep(3_000),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}

interface JsonResponse {
  status: number;
  json: Record<string, any>;
  text: string;
  headers: Headers;
}

async function requestJson(endpoint: string, options: {
  method?: string;
  authenticated?: boolean;
  body?: unknown;
} = {}): Promise<JsonResponse> {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (options.authenticated ?? true) headers.set('x-api-key', API_KEY);
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text, headers: response.headers };
}

before(async () => {
  runtimeDir = mkdtempSync(path.join(tmpdir(), 'beyound-http-test-'));
  mkdirSync(path.join(runtimeDir, 'auth'), { recursive: true });
  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      API_KEY,
      API_KEYS_JSON: '',
      AUTH_FOLDER: path.join(runtimeDir, 'auth'),
      AUDIT_LOG_PATH: path.join(runtimeDir, 'audit.log'),
      WEBHOOK_DB_PATH: path.join(runtimeDir, 'webhooks.sqlite'),
      INTEGRATIONS_DB_PATH: path.join(runtimeDir, 'integrations.sqlite'),
      MESSAGES_DB_PATH: path.join(runtimeDir, 'messages.sqlite'),
      REQUEST_LOGS_ENABLED: 'false',
      WEBHOOK_EMBEDDED_WORKER_ENABLED: 'false',
      ALLOW_PRIVATE_NETWORK_WEBHOOKS: 'false',
      ALLOW_PRIVATE_NETWORK_INTEGRATIONS: 'false',
      PUBLIC_DOCS_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', appendServerLog);
  serverProcess.stderr.on('data', appendServerLog);
  await waitForServerReady();
});

after(async () => {
  await stopServer();
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
});

test('health endpoint returns ok and requestId', async () => {
  const response = await requestJson('/health', { authenticated: false });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(typeof response.json.requestId, 'string');
});

test('instances route requires API key when authentication is enabled', async () => {
  const response = await requestJson('/v1/instances', { authenticated: false });
  assert.equal(response.status, 401);
  assert.equal(response.json.error, 'missing_api_key');
});

test('instances list succeeds with a valid API key', async () => {
  const response = await requestJson('/v1/instances');
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.ok(Array.isArray(response.json.instances));
  assert.ok(Array.isArray(response.json.saved));
});

test('instances route rejects invalid names', async () => {
  const response = await requestJson('/v1/instances/bad.name');
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'invalid_instance_name');
});

test('Swagger UI is real HTML, authenticated and protected by CSP', async () => {
  const unauthorized = await requestJson('/docs', { authenticated: false });
  assert.equal(unauthorized.status, 401);
  const response = await requestJson('/docs');
  assert.equal(response.status, 200);
  assert.match(response.text, /SwaggerUIBundle/);
  assert.match(response.text, /swagger-ui-bundle\.js/);
  assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
});

test('OpenAPI serves a valid contract', async () => {
  const response = await requestJson('/openapi.json');
  assert.equal(response.status, 200);
  assert.equal(response.json.openapi, '3.1.0');
  assert.ok(Object.keys(response.json.paths ?? {}).length >= 75);
});

test('webhook creation blocks private network destinations', async () => {
  const response = await requestJson('/v1/webhooks', {
    method: 'POST',
    body: { name: 'local-loopback', url: 'http://127.0.0.1:8080/webhook', events: ['SEND_MESSAGE'] },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'invalid_url');
  assert.equal(response.json.details?.reason, 'private_network_url_not_allowed');
});

test('n8n integration blocks private network destinations', async () => {
  const response = await requestJson('/v1/integrations/main/n8n', {
    method: 'PATCH',
    body: { enabled: true, webhookUrl: 'http://localhost:5678/hook' },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.error, 'invalid_n8n_webhook_url');
});

test('n8n integration accepts a public destination', async () => {
  const response = await requestJson('/v1/integrations/main/n8n', {
    method: 'PATCH',
    body: {
      enabled: true,
      webhookUrl: 'https://example.com/webhook',
      authHeaderName: 'x-test-token',
      authHeaderValue: 'test-value',
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.match(String(response.json.integration?.n8n?.webhookUrl), /^https:\/\/example\.com\/webhook/);
});
