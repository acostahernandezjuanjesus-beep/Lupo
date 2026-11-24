const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../scripts/loadTS.cjs');
const { TYPES, REASONS, definitionOf, quantityWithUnit, movementSummary } = load('movement.ts');

// A sentence that lies about the balance (a -3 where nobody has counted, an invented zero) is worse than no sentence.

const counted = { unit: 'piece', quantity: 12, count_pending: false, control_type: 'stock' };
const summary = (type, extra = {}, product = counted) => movementSummary({ type, product, quantity: 3, responsible: 'Ana Perez', operator: 'Luis', ...extra });

test('there are five types, none preselected, and all but the adjustment ask who', () => {
    assert.deepEqual(TYPES.map(t => t.type), ['out', 'loan', 'in', 'return', 'adjustment']);
    assert.deepEqual(TYPES.filter(t => t.question === null).map(t => t.type), ['adjustment'], 'whoever counts does the adjustment');
    assert.deepEqual(TYPES.map(t => t.sign), [-1, -1, 1, 1, 0]);
    for (const t of TYPES) assert.ok(REASONS[t.type].length > 0, `reasons for ${t.type}`);
});

test('quantityWithUnit: singular, plural and units that do not change', () => {
    assert.equal(quantityWithUnit(1, 'piece'), '1 piece');
    assert.equal(quantityWithUnit(3, 'piece'), '3 pieces');
    assert.equal(quantityWithUnit(2, 'pair'), '2 pairs');
    assert.equal(quantityWithUnit(2.5, 'kg'), '2.5 kg');
    assert.equal(quantityWithUnit(4, 'roll'), '4 roll', 'an unknown unit is said as is, its plural is not invented');
});

test('an out lowers the balance and an in raises it, with the sentence saying who', () => {
    const s = summary('out');
    assert.deepEqual([s.action, s.result, s.who, s.recordedBy, s.negative], ['Out: 3 pieces', 'Will be 9 pieces', 'Taken by Ana Perez', 'Recorded by Luis', false]);
    assert.equal(summary('loan').result, 'Will be 9 pieces');
    assert.equal(summary('loan').who, 'Borrowed by Ana Perez');
    const e = summary('in');
    assert.deepEqual([e.action, e.result, e.who], ['In: 3 pieces', 'Will be 15 pieces', 'Delivered by Ana Perez']);
    assert.equal(summary('return').result, 'Will be 15 pieces');
    assert.equal(summary('return').who, 'Returned by Ana Perez');
});

test('an adjustment SETS the balance to the count and has no "who"', () => {
    const a = summary('adjustment', { quantity: 7 });
    assert.deepEqual([a.action, a.result, a.who], ['Count: 7 pieces', 'Will be 7 pieces', null]);
    assert.equal(summary('adjustment', { quantity: 0 }).result, 'Will be 0 pieces', 'counting zero is a count on purpose');
});

test('an out that is too large leaves a negative balance and flags it; the number is shown (the starting balance is real)', () => {
    const r = summary('out', { quantity: 15 });
    assert.equal(r.negative, true);
    assert.equal(r.result, 'Will be -3 pieces');
});

test('RULE 1: without a count no balance is computed, and it says why', () => {
    const uncounted = { unit: 'piece', quantity: 0, count_pending: true, control_type: 'stock' };
    for (const type of ['out', 'loan', 'in', 'return']) {
        const r = summary(type, {}, uncounted);
        assert.match(r.result, /Not counted/, type);
        assert.equal(r.negative, false, `${type}: a -3 from a zero nobody measured is invented`);
        assert.doesNotMatch(r.result, /−|-\d|\d/, type);
    }
    assert.equal(summary('adjustment', { quantity: 5 }, uncounted).result, 'Will be 5 pieces', 'counting does resolve the "I do not know"');
});

test('an item that is not stock-tracked announces no balance; counting it makes it tracked', () => {
    const noBalance = { unit: 'piece', quantity: 40, count_pending: false, control_type: 'no_balance' };
    assert.match(summary('out', {}, noBalance).result, /Not stock-tracked/);
    assert.equal(summary('out', {}, noBalance).negative, false);
    assert.match(summary('adjustment', { quantity: 9 }, noBalance).result, /start tracking stock/);
});

test('no quantity yet: only the type, no balance; with no responsible chosen there is no "who"', () => {
    const r = summary('out', { quantity: null, responsible: null });
    assert.deepEqual([r.action, r.result, r.who], ['Out', null, null]);
    assert.equal(movementSummary({ type: 'in', product: counted, quantity: NaN, responsible: null, operator: 'Luis' }).result, null);
});

test('definitionOf finds each type', () => {
    for (const t of TYPES) assert.equal(definitionOf(t.type).title, t.title);
});
