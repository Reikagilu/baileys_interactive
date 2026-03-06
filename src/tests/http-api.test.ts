import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

const API_KEY = 'integration-test-api-key';

let runtimeDir = '';
let baseUrl = '';
let serverProcess: ChildProcess | null = null;
let serverLogs = '';

function appendServerLog(chunk: unknown): void {
  const value = typeof chunk === 'string' ? chunk : String(chunk);
  serverLogs += value;
  if (serverLogs.length > 20_000) {
    serverLogs = serverLogs.slice(-20_000);
  }
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
      const { port } = address;
      tempServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForServerReady(timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await sleep(250);
  }
  throw new Error(`server_not_ready\n${serverLogs}`);
}

async function stopServer(): Promise<void> {
  if (!serverProcess || serverProcess.exitCode !== null) return;

  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => {
      serverProcess?.once('exit', () => resolve());
    }),
    sleep(3_000),
  ]);

  if (serverProcess.exitCode === null) {
    serverProcess.kill('SIGKILL');
    await new Promise<void>((resolve) => {
      serverProcess?.once('exit', () => resolve());
    });
  }
}

async function requestJson(
  endpoint: string,
  options: { method?: string; body?: unknown; authenticated?: boolean } = {}
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const method = options.method ?? 'GET';
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  if (options.authenticated ?? true) {
    headers.set('x-api-key', API_KEY);
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }

  return {
    status: response.status,
    json,
    text,
  };
}

before(async () => {
  runtimeDir = mkdtempSync(path.join(tmpdir(), 'baileys-http-test-'));
  mkdirSync(path.join(runtimeDir, 'auth'), { recursive: true });

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    API_KEY,
    API_KEYS_JSON: '',
    AUTH_FOLDER: path.join(runtimeDir, 'auth'),
    AUDIT_LOG_PATH: path.join(runtimeDir, 'audit.log'),
    WEBHOOK_DB_PATH: path.join(runtimeDir, 'webhooks.sqlite'),
    INTEGRATIONS_DB_PATH: path.join(runtimeDir, 'integrations.sqlite'),
    REQUEST_LOGS_ENABLED: 'false',
    WEBHOOK_EMBEDDED_WORKER_ENABLED: 'false',
    ALLOW_PRIVATE_NETWORK_WEBHOOKS: 'false',
    ALLOW_PRIVATE_NETWORK_INTEGRATIONS: 'false',
  };

  serverProcess = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout?.on('data', appendServerLog);
  serverProcess.stderr?.on('data', appendServerLog);

  await waitForServerReady();
});

after(async () => {
  await stopServer();
  if (runtimeDir) {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('health endpoint returns ok and requestId', async () => {
  const response = await requestJson('/health', { authenticated: false });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(typeof response.json.requestId, 'string');
});

test('instances route requires api key when auth enabled', async () => {
  const response = await requestJson('/v1/instances', { authenticated: false });

  assert.equal(response.status, 401);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error, 'missing_api_key');
});

test('instances list succeeds with valid api key', async () => {
  const response = await requestJson('/v1/instances');

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(typeof response.json.requestId, 'string');
  assert.equal(Array.isArray(response.json.instances), true);
  assert.equal(Array.isArray(response.json.saved), true);
});

test('instances route rejects invalid instance name in path', async () => {
  const response = await requestJson('/v1/instances/bad.name');

  assert.equal(response.status, 400);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error, 'invalid_instance_name');
});

test('webhook creation blocks private network destination', async () => {
  const response = await requestJson('/v1/webhooks', {
    method: 'POST',
    body: {
      name: 'local-loopback',
      url: 'http://127.0.0.1:8080/webhook',
      events: ['SEND_MESSAGE'],
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error, 'invalid_url');
  assert.equal((response.json.details as { reason?: string })?.reason, 'private_network_url_not_allowed');
});

test('n8n integration blocks private network destination', async () => {
  const response = await requestJson('/v1/integrations/main/n8n', {
    method: 'PATCH',
    body: {
      enabled: true,
      webhookUrl: 'http://localhost:5678/hook',
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.json.ok, false);
  assert.equal(response.json.error, 'invalid_n8n_webhook_url');
  assert.equal((response.json.details as { reason?: string })?.reason, 'private_network_url_not_allowed');
});

test('n8n integration accepts public destination', async () => {
  const response = await requestJson('/v1/integrations/main/n8n', {
    method: 'PATCH',
    body: {
      enabled: true,
      webhookUrl: 'https://example.com/webhook',
      authHeaderName: 'x-test-token',
      authHeaderValue: 'abc123',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  const integration = response.json.integration as { n8n?: { webhookUrl?: string } };
  const n8n = integration?.n8n;
  assert.ok(n8n && typeof n8n.webhookUrl === 'string');
  assert.equal(String(n8n.webhookUrl).startsWith('https://example.com/webhook'), true);
});
