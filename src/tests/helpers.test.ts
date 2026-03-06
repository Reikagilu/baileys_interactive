import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInstanceName, toJid } from '../utils/helpers.js';

test('normalizeInstanceName accepts valid names and fallback', () => {
  assert.equal(normalizeInstanceName('main'), 'main');
  assert.equal(normalizeInstanceName('  suporte_01  '), 'suporte_01');
  assert.equal(normalizeInstanceName(undefined, 'main'), 'main');
});

test('normalizeInstanceName rejects invalid names', () => {
  assert.equal(normalizeInstanceName('..'), null);
  assert.equal(normalizeInstanceName('../main'), null);
  assert.equal(normalizeInstanceName('main/session'), null);
  assert.equal(normalizeInstanceName(''), null);
});

test('toJid converts a valid phone number', () => {
  assert.equal(toJid('55 (11) 98888-7777'), '5511988887777@s.whatsapp.net');
});

test('toJid preserves already formatted jid and rejects short number', () => {
  assert.equal(toJid('12345@s.whatsapp.net'), '12345@s.whatsapp.net');
  assert.equal(toJid('99999'), null);
});
