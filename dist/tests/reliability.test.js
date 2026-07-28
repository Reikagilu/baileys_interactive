import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const runtimeDir = mkdtempSync(path.join(tmpdir(), 'beyound-reliability-'));
process.env.MESSAGES_DB_PATH = path.join(runtimeDir, 'messages.sqlite');
const store = await import('../services/message-store.js');
const instance = 'test', jid = '5511999999999@s.whatsapp.net';
after(() => rmSync(runtimeDir, { recursive: true, force: true }));
test('receipt before ingest remains visible after ingest', () => {
    store.setMessageDeliveryState(instance, 'm-before', { state: 'delivered', statusCode: 3, updatedAt: 200, event: 'messages.update' });
    store.upsertMessage(instance, jid, { id: 'm-before', fromMe: true, text: 'hello', timestamp: 100 });
    const [m] = store.listMessages(instance, jid, 10);
    assert.equal(m.delivery?.state, 'delivered');
    assert.equal(m.delivery?.statusCode, 3);
});
test('older delivery update cannot overwrite newer state', () => {
    store.setMessageDeliveryState(instance, 'm-order', { state: 'read', statusCode: 4, updatedAt: 500 });
    store.setMessageDeliveryState(instance, 'm-order', { state: 'pending', statusCode: 1, updatedAt: 400 });
    assert.equal(store.getMessageDeliveryState(instance, 'm-order')?.state, 'read');
});
test('batch delivery lookup is bounded to requested ids', () => {
    store.setMessageDeliveryState(instance, 'm-a', { state: 'server_ack', updatedAt: 1 });
    store.setMessageDeliveryState(instance, 'm-b', { state: 'failed', updatedAt: 2 });
    const states = store.getMessageDeliveryStates(instance, ['m-a', 'm-b', 'missing']);
    assert.equal(states.size, 2);
    assert.equal(states.get('m-b')?.state, 'failed');
});
