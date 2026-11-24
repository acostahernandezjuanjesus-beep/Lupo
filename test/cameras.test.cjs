const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../scripts/loadTS.cjs');
const { rearLenses, nextLens, usableLenses, measureFrame, isCovered, createWatcher } = load('cameras.ts');

// Covered lenses and lens switching (client/src/cameras.ts). Pure module: no browser needed.

const cam = (deviceId, label, kind = 'videoinput') => ({ deviceId, label, kind });

// An RGBA frame of `n` points: each point comes from `point(i)` = [r, g, b].
const frame = (n, point) => {
    const data = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) { const [r, g, b] = point(i); data.set([r, g, b, 255], i * 4); }
    return data;
};
const gray = v => () => [v, v, v];
// Deterministic noise (no Math.random: the test must not depend on luck).
const noise = (base, amplitude) => i => { const d = ((i * 2654435761) % 1000) / 1000 * amplitude - amplitude / 2; return [base + d, base + d, base + d]; };

test('rearLenses: Android Chrome, iPhone Safari and a webcam', () => {
    // A Samsung: three rear and two front, mixed.
    const samsung = [
        cam('a0', 'camera2 0, facing back'), cam('a1', 'camera2 1, facing front'),
        cam('a2', 'camera2 2, facing back'), cam('a3', 'camera2 3, facing front'), cam('a4', 'camera2 4, facing back'),
    ];
    assert.deepEqual(rearLenses(samsung).map(l => l.deviceId), ['a0', 'a2', 'a4']);
    // An iPhone, in English and in Spanish.
    const iphone = [cam('i1', 'Front Camera'), cam('i2', 'Back Camera'), cam('i3', 'Back Ultra Wide Camera'), cam('i4', 'Cámara trasera')];
    assert.deepEqual(rearLenses(iphone).map(l => l.deviceId), ['i2', 'i3', 'i4']);
    // A computer does not say which side it is on: none qualifies, even if there are two.
    assert.deepEqual(rearLenses([cam('w1', 'Integrated Camera'), cam('w2', 'Logitech C920')]), []);
});

test('rearLenses: the other ways to say "rear" (rear, environment, posterior)', () => {
    const others = [cam('r', 'Rear Camera'), cam('e', 'environment facing'), cam('p', 'Cámara posterior'), cam('f', 'Front Camera')];
    assert.deepEqual(rearLenses(others).map(l => l.deviceId), ['r', 'e', 'p']);
});

test('rearLenses: without permission there are no ids, and microphones do not count', () => {
    assert.deepEqual(rearLenses([cam('', 'camera2 0, facing back')]), []);
    assert.deepEqual(rearLenses([cam('m1', 'back microphone', 'audioinput')]), []);
    assert.deepEqual(rearLenses([]), []);
    // "feedback" or "background" are not "back".
    assert.deepEqual(rearLenses([cam('x', 'Feedback Cam')]), []);
});

test('nextLens wraps around, and with fewer than two there is nowhere to go', () => {
    const l = [cam('a', 'back 1'), cam('b', 'back 2'), cam('c', 'back 3')];
    assert.equal(nextLens(l, 'a').deviceId, 'b');
    assert.equal(nextLens(l, 'b').deviceId, 'c');
    assert.equal(nextLens(l, 'c').deviceId, 'a');
    // The current one is not in the list: start with the first.
    assert.equal(nextLens(l, 'zzz').deviceId, 'a');
    assert.equal(nextLens(l, null).deviceId, 'a');
    assert.equal(nextLens([l[0]], 'a'), null);
    assert.equal(nextLens([], null), null);
});

test('nextLens with two lenses (the most common case): the other one, back and forth', () => {
    const l = [cam('a', 'back 1'), cam('b', 'back 2')];
    assert.equal(nextLens(l, 'a').deviceId, 'b');
    assert.equal(nextLens(l, 'b').deviceId, 'a');
});

test('nextLens skips bad lenses: one that failed to open is not picked again', () => {
    const l = [cam('a', 'back 1'), cam('b', 'back 2'), cam('c', 'back 3')];
    // B is listed but does not open: from A go to C, and from C back to A without passing through B.
    assert.equal(nextLens(l, 'a', new Set(['b'])).deviceId, 'c');
    assert.equal(nextLens(l, 'c', new Set(['b'])).deviceId, 'a');
    // After B failed (the current one is B, which is in the bad set): C follows, not A.
    assert.equal(nextLens(l, 'b', new Set(['b'])).deviceId, 'c');
    // If all the others are bad there is nowhere to go.
    assert.equal(nextLens(l, 'a', new Set(['b', 'c'])), null);
    assert.equal(nextLens([l[0], l[1]], 'a', new Set(['b'])), null);
    // The current one is not returned to itself even if it is the only good one.
    assert.equal(nextLens(l, 'c', new Set(['a', 'b'])), null);
});

test('usableLenses drops the bad ones and keeps the order', () => {
    const l = [cam('a', 'back 1'), cam('b', 'back 2'), cam('c', 'back 3')];
    assert.deepEqual(usableLenses(l, new Set(['b'])).map(x => x.deviceId), ['a', 'c']);
    assert.deepEqual(usableLenses(l, new Set()).map(x => x.deviceId), ['a', 'b', 'c']);
});

test('measureFrame: black, even gray, an image with detail, and a frame with no data', () => {
    const black = measureFrame(frame(768, gray(0)));
    assert.equal(black.mean, 0);
    assert.equal(black.deviation, 0);
    const even = measureFrame(frame(768, gray(128)));
    assert.ok(Math.abs(even.mean - 128) < 0.01 && even.deviation < 0.01);
    // Half black, half white: the variation is large.
    const bars = measureFrame(frame(768, i => (i % 2 ? [255, 255, 255] : [0, 0, 0])));
    assert.ok(bars.deviation > 100);
    // Red and blue are averaged separately: a reddish frame shows it.
    const reddish = measureFrame(frame(768, () => [200, 40, 30]));
    assert.ok(reddish.red > 6 * reddish.blue);
    // No data is NOT "covered": it could not be measured.
    const empty = measureFrame(new Uint8ClampedArray(0));
    assert.equal(isCovered(empty), false);
});

test('isCovered: black and flat dark yes; a bright wall, a scene with detail and a shadow with detail no', () => {
    assert.equal(isCovered(measureFrame(frame(768, gray(0)))), true);           // tape or a case
    assert.equal(isCovered(measureFrame(frame(768, noise(4, 6)))), true);       // black with sensor noise
    assert.equal(isCovered(measureFrame(frame(768, () => [60, 14, 8]))), true); // finger: little reddish, even light
    assert.equal(isCovered(measureFrame(frame(768, gray(200)))), false);        // plain bright wall: nothing to change
    assert.equal(isCovered(measureFrame(frame(768, noise(120, 120)))), false);  // scene with detail
    assert.equal(isCovered(measureFrame(frame(768, noise(40, 80)))), false);    // dim light with detail (a shelf)
});

test('isCovered: each threshold is decided by a case (removing the condition or moving the value breaks a test)', () => {
    // Only the BLACK branch decides: mean 7.8 but variation 8.3 (> 6), so it is not "flat".
    const nearBlackNoisy = measureFrame(frame(768, noise(5, 40)));
    assert.ok(nearBlackNoisy.mean < 10 && nearBlackNoisy.deviation > 6);
    assert.equal(isCovered(nearBlackNoisy), true);
    // Only the FLAT branch decides: mean 30 (> 10), variation 2.9 (< 6) -> covered; with variation 11.6 -> not.
    assert.equal(isCovered(measureFrame(frame(768, noise(30, 10)))), true);
    assert.equal(isCovered(measureFrame(frame(768, noise(30, 40)))), false);
    // Dark mean boundary: the same flat frame, from 55 (covered) to 65 (bright).
    assert.equal(isCovered(measureFrame(frame(768, gray(55)))), true);
    assert.equal(isCovered(measureFrame(frame(768, gray(65)))), false);
});

const DARK = measureFrame(frame(768, gray(0)));
const BRIGHT = measureFrame(frame(768, noise(120, 120)));

test('watcher: does not act during the grace period or on a passing shadow', () => {
    const v = createWatcher();
    v.restart(0);
    // Inside the grace period (1.5 s), not even with ten dark samples.
    for (let t = 0; t < 1500; t += 150) assert.equal(v.sample(DARK, t, 3), 'wait');
    // Two dark samples in a row and then a bright one: no alarm, and the count goes back to zero.
    assert.equal(v.sample(DARK, 1600, 3), 'wait');
    assert.equal(v.sample(DARK, 2000, 3), 'wait');
    assert.equal(v.sample(BRIGHT, 2400, 3), 'wait');
    assert.equal(v.sample(DARK, 2800, 3), 'wait');
    assert.equal(v.sample(DARK, 3200, 3), 'wait');
});

test('watcher: three dark samples in a row switch lens, once', () => {
    const v = createWatcher();
    v.restart(0);
    assert.equal(v.sample(DARK, 2000, 3), 'wait');
    assert.equal(v.sample(DARK, 2400, 3), 'wait');
    assert.equal(v.sample(DARK, 2800, 3), 'switch');
    // After switching the grace period is back: the new lens is not judged by its first frames.
    v.restart(2800);
    for (let t = 2800; t < 4300; t += 400) assert.equal(v.sample(DARK, t, 3), 'wait');
});

test('watcher: with every lens covered it tries the others and warns ONCE', () => {
    const v = createWatcher();
    let now = 0;
    v.restart(now);
    const three = () => { const r = []; for (let i = 0; i < 3; i++) { now += 400; r.push(v.sample(DARK, now, 3)); } return r; };
    now = 1500;
    assert.deepEqual(three(), ['wait', 'wait', 'switch']);      // lens 1 -> 2
    v.restart(now); now += 1500;
    assert.deepEqual(three(), ['wait', 'wait', 'switch']);      // lens 2 -> 3
    v.restart(now); now += 1500;
    assert.deepEqual(three(), ['wait', 'wait', 'no-image']);    // all three covered: say so, stop going around
    // Still covered: no repeated warning and no more switching.
    assert.deepEqual(three(), ['wait', 'wait', 'wait']);
    assert.deepEqual(three(), ['wait', 'wait', 'wait']);
    // Someone uncovers it: the image counts as recovered after THREE bright samples in a row (one is not enough),
    // and the warning goes away and everything is re-armed.
    const bright = () => { const r = []; for (let i = 0; i < 3; i++) { now += 400; r.push(v.sample(BRIGHT, now, 3)); } return r; };
    assert.deepEqual(bright(), ['wait', 'wait', 'image']);
    assert.deepEqual(three(), ['wait', 'wait', 'switch']);
});

test('watcher: the "no-image" warning can be given again after the image recovers', () => {
    const v = createWatcher();
    let now = 0;
    v.restart(now); now = 1500;
    const run = (m, n) => { const r = []; for (let i = 0; i < n; i++) { now += 400; r.push(v.sample(m, now, 1)); } return r; };
    assert.deepEqual(run(DARK, 3), ['wait', 'wait', 'no-image']);
    assert.deepEqual(run(BRIGHT, 3), ['wait', 'wait', 'image']);
    // Covered again: the warning must be able to come out again (if `warned` were not cleared, never again).
    assert.deepEqual(run(DARK, 3), ['wait', 'wait', 'no-image']);
});

test('watcher: after rearm() the warning can also be given again', () => {
    const v = createWatcher();
    v.restart(0);
    for (const t of [2000, 2400]) v.sample(DARK, t, 1);
    assert.equal(v.sample(DARK, 2800, 1), 'no-image');
    // The person taps Scan again with the lens still covered.
    v.rearm(); v.restart(3000);
    for (const t of [4600, 5000]) v.sample(DARK, t, 1);
    assert.equal(v.sample(DARK, 5400, 1), 'no-image');
});

test('watcher: a scene right at the threshold does not switch lens forever', () => {
    // Covered, covered, covered, bright, repeated (a plain wall in dim light: the mean hovers around 60).
    // Before, each bright sample reset the attempts and it made ~50 switches in 160 s without ever warning.
    const v = createWatcher();
    const pattern = [DARK, DARK, DARK, BRIGHT];
    let now = 0, switches = 0, warnings = 0;
    v.restart(now);
    for (let i = 0; i < 400; i++) {
        now += 400;
        const r = v.sample(pattern[i % 4], now, 3);
        if (r === 'switch') { switches++; v.restart(now); }
        if (r === 'no-image') warnings++;
    }
    assert.equal(switches, 2, 'with three lenses the other two are tried and no more');
    assert.equal(warnings, 1, 'and it warns once');
});

test('watcher: with a single lens (or a webcam) it warns right away, without switching', () => {
    for (const lenses of [0, 1]) {
        const v = createWatcher();
        v.restart(0);
        assert.equal(v.sample(DARK, 2000, lenses), 'wait');
        assert.equal(v.sample(DARK, 2400, lenses), 'wait');
        assert.equal(v.sample(DARK, 2800, lenses), 'no-image');
    }
});

test('watcher: rearm forgets the attempts (the person tapped Scan again)', () => {
    const v = createWatcher();
    v.restart(0);
    for (const t of [2000, 2400]) v.sample(DARK, t, 2);
    assert.equal(v.sample(DARK, 2800, 2), 'switch');   // 1 attempt out of 1 possible
    v.restart(2800);
    for (const t of [4400, 4800]) v.sample(DARK, t, 2);
    assert.equal(v.sample(DARK, 5200, 2), 'no-image');
    v.rearm(); v.restart(6000);
    for (const t of [7600, 8000]) v.sample(DARK, t, 2);
    assert.equal(v.sample(DARK, 8400, 2), 'switch');   // starts over
});
