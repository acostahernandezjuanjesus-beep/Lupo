const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../scripts/loadTS.cjs');
const { levelStateOf, formatQuantity } = load('level.ts');
const product = (quantity, minimum = 8, count_pending = false) => ({ quantity, minimum, count_pending });
test('five levels, with inclusive limits at the minimum and at 125%', () => {
    for (const [p, level] of [[product(100, 8, true), 'uncounted'], [product(0, null), 'no_minimum'], [product(8), 'below_min'], [product(10), 'restock'], [product(10.001), 'ample']]) assert.equal(levelStateOf(p).level, level);
    assert.equal(levelStateOf(product(-1)).proportion, 0);
    assert.equal(levelStateOf(product(9)).minMark, 0.5);
});
test('quantities: trailing zeros are dropped, fractions are kept unrounded', () => {
    for (const [n, expected] of [[12, '12'], [1.25, '1.25'], [1.234, '1.234'], [1.2345, '1.2345'], [-2.5, '-2.5'], [0, '0']]) assert.equal(formatQuantity(n), expected);
});
