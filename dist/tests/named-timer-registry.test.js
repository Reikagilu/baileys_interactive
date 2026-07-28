import test from 'node:test';
import assert from 'node:assert/strict';
import { NamedTimerRegistry } from '../utils/named-timer-registry.js';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
test('a newer timer supersedes the prior reconnect for the same instance', async () => {
    const registry = new NamedTimerRegistry();
    const calls = [];
    registry.schedule('KSA', 15, () => { calls.push('old'); });
    registry.schedule('KSA', 5, () => { calls.push('new'); });
    await sleep(30);
    assert.deepEqual(calls, ['new']);
    assert.equal(registry.has('KSA'), false);
});
test('cancel and cancelAll prevent delayed reconnects', async () => {
    const registry = new NamedTimerRegistry();
    const calls = [];
    registry.schedule('KSA', 5, () => { calls.push('KSA'); });
    registry.schedule('main', 5, () => { calls.push('main'); });
    assert.equal(registry.cancel('KSA'), true);
    registry.cancelAll();
    await sleep(20);
    assert.deepEqual(calls, []);
});
