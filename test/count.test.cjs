const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../scripts/loadTS.cjs');
const { adjust, difference } = load('count.ts');

test('adjust: steps up and down by one, and never goes below zero', () => {
    assert.equal(adjust('50', 1, 'piece'), '51');
    assert.equal(adjust('50', -1, 'piece'), '49');
    assert.equal(adjust('0', -1, 'piece'), '0');
});

test('adjust: an uncounted product does not start at an invented zero, up gives 1 and down gives 0 on purpose', () => {
    assert.equal(adjust('', 1, 'piece'), '1');
    assert.equal(adjust('', -1, 'piece'), '0');
    assert.equal(adjust('abc', 1, 'piece'), '1');
});

test('adjust: whole units round what was typed, fractional units keep it without floating point noise', () => {
    assert.equal(adjust('2.5', 1, 'piece'), '4');
    assert.equal(adjust('2.5', 1, 'kg'), '3.5');
    assert.equal(adjust('0.1', 1, 'kg'), '1.1');
    assert.equal(adjust('0.2', -1, 'kg'), '0');
});

test('difference: signed, and nothing if there is no balance to compare or it did not change', () => {
    assert.equal(difference(50, '53'), '+3');
    assert.equal(difference(50, '48'), '−2');
    assert.equal(difference(50, '50'), null);
    assert.equal(difference(null, '5'), null, 'no balance (uncounted) means no difference to report');
    assert.equal(difference(50, ''), null);
    assert.equal(difference(1.5, '2.25'), '+0.75');
});
