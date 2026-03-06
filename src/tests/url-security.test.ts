import test from 'node:test';
import assert from 'node:assert/strict';
import { validateOutboundUrl } from '../utils/url-security.js';

test('validateOutboundUrl accepts public https URL', () => {
  const result = validateOutboundUrl('https://api.example.com/webhook');
  assert.equal(result.ok, true);
  assert.equal(result.normalizedUrl, 'https://api.example.com/webhook');
});

test('validateOutboundUrl rejects non-http protocols', () => {
  const result = validateOutboundUrl('ftp://example.com/path');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_protocol');
});

test('validateOutboundUrl rejects URL credentials', () => {
  const result = validateOutboundUrl('https://user:pass@example.com/webhook');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'url_credentials_not_allowed');
});

test('validateOutboundUrl blocks private network by default', () => {
  const result = validateOutboundUrl('http://127.0.0.1:3000/hook');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'private_network_url_not_allowed');
});

test('validateOutboundUrl allows private network when explicitly enabled', () => {
  const result = validateOutboundUrl('http://127.0.0.1:3000/hook', { allowPrivateNetwork: true });
  assert.equal(result.ok, true);
  assert.equal(result.normalizedUrl, 'http://127.0.0.1:3000/hook');
});
