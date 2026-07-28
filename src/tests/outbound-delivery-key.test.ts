import test from 'node:test';
import assert from 'node:assert/strict';
import { outboundDeliveryMessageId } from '../utils/outbound-delivery-key.js';

test('delivery events accept only explicit outbound keys', () => {
  assert.equal(outboundDeliveryMessageId({ id: ' out-1 ', fromMe: true }), 'out-1');
  assert.equal(outboundDeliveryMessageId({ id: 'in-1', fromMe: false }), null);
  assert.equal(outboundDeliveryMessageId({ id: 'unknown' }), null);
  assert.equal(outboundDeliveryMessageId({ id: '   ', fromMe: true }), null);
});
