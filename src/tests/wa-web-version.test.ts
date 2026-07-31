import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FALLBACK_WA_WEB_VERSION,
  formatWaWebVersion,
  parseConfiguredWaWebVersion,
  resolveWaWebVersion,
} from '../utils/wa-web-version.js';

test('WHATSAPP_WEB_VERSION accepts an explicit three-part version', () => {
  const parsed = parseConfiguredWaWebVersion(' 2.3000.1044254868 ');
  assert.deepEqual(parsed, [2, 3000, 1044254868]);
  assert.equal(formatWaWebVersion(parsed!), '2.3000.1044254868');
});

test('WHATSAPP_WEB_VERSION rejects malformed values instead of silently downgrading', () => {
  assert.throws(() => parseConfiguredWaWebVersion('latest'), /exactly three numeric components/);
  assert.throws(() => parseConfiguredWaWebVersion('2.3000'), /exactly three numeric components/);
  assert.equal(parseConfiguredWaWebVersion(''), null);
});

test('explicit env version has priority over online discovery', async () => {
  let fetched = false;
  const selected = await resolveWaWebVersion([2, 3000, 1044254868], async () => {
    fetched = true;
    return { version: [9, 9, 9] };
  });
  assert.equal(fetched, false);
  assert.deepEqual(selected, { version: [2, 3000, 1044254868], source: 'env' });
});

test('empty env uses online discovery and falls back deterministically on failure', async () => {
  assert.deepEqual(
    await resolveWaWebVersion(null, async () => ({ version: [2, 3000, 1044259999] })),
    { version: [2, 3000, 1044259999], source: 'online' },
  );
  assert.deepEqual(
    await resolveWaWebVersion(null, async () => { throw new Error('offline'); }),
    { version: FALLBACK_WA_WEB_VERSION, source: 'fallback' },
  );
});
