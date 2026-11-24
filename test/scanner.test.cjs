/* global DOMException */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../scripts/loadTS.cjs');

// openCamera (client/src/scanner.ts) with a fake `getUserMedia`: what is asked of the browser and when it retries.
// The module loads in Node because importing it does not touch the DOM.

const { openCamera } = load('scanner.ts');

function mock(responses) {
    const calls = [];
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { mediaDevices: { getUserMedia: async constraints => {
            calls.push(constraints.video);
            const r = responses.shift();
            if (r instanceof Error) throw r;
            return r;
        } } },
    });
    return calls;
}
const failure = name => new DOMException('simulated', name);

test('by side: asks for facingMode and NOT a device', async () => {
    const calls = mock(['stream']);
    assert.equal(await openCamera('environment'), 'stream');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].facingMode, 'environment');
    assert.equal(calls[0].deviceId, undefined);
    assert.deepEqual(calls[0].width, { ideal: 1280 });
});

test('with a lens: asks for that EXACT deviceId and no side', async () => {
    const calls = mock(['stream']);
    await openCamera('environment', 'lens-2');
    assert.deepEqual(calls[0].deviceId, { exact: 'lens-2' });
    assert.equal(calls[0].facingMode, undefined);
});

test('with a lens, a NotReadableError is retried ONCE', async () => {
    const calls = mock([failure('NotReadableError'), 'stream']);
    assert.equal(await openCamera('environment', 'lens-2'), 'stream');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].deviceId, { exact: 'lens-2' });
});

test('with a lens, two NotReadableErrors in a row are rethrown (no endless retry)', async () => {
    const calls = mock([failure('NotReadableError'), failure('NotReadableError'), 'never']);
    await assert.rejects(openCamera('environment', 'lens-2'), { name: 'NotReadableError' });
    assert.equal(calls.length, 2);
});

test('no retry by side or on other errors', async () => {
    let calls = mock([failure('NotReadableError'), 'never']);
    await assert.rejects(openCamera('environment'), { name: 'NotReadableError' });
    assert.equal(calls.length, 1);
    calls = mock([failure('OverconstrainedError'), 'never']);
    await assert.rejects(openCamera('environment', 'lens-2'), { name: 'OverconstrainedError' });
    assert.equal(calls.length, 1);
    calls = mock([failure('NotAllowedError'), 'never']);
    await assert.rejects(openCamera('user', 'lens-2'), { name: 'NotAllowedError' });
    assert.equal(calls.length, 1);
});
