import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('syncFullHistory is connect-only and never schedules periodic history fetches', () => {
  const source = fs.readFileSync('src/services/whatsapp.ts', 'utf8');

  assert.match(source, /syncFullHistory:\s*generalSettings\.syncFullHistory/);
  assert.doesNotMatch(source, /startContinuousHistorySync|runContinuousHistorySync/);
  assert.doesNotMatch(source, /CONTINUOUS_HISTORY_SYNC_MS|syncHistoryIntervals/);
});

test('manual per-chat history sync remains available', () => {
  const source = fs.readFileSync('src/services/whatsapp.ts', 'utf8');

  assert.match(source, /export async function syncInstanceChatHistory/);
  assert.match(source, /fetchMessageHistory/);
});
