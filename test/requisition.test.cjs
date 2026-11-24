const { test } = require('node:test');
const assert = require('node:assert/strict');
const { suggestOrder, requisition } = require('../requisition');

const base = { id: 1, code: 'ABR-DISCO-X', name: 'Disc', unit: 'piece', control_type: 'stock', count_pending: false };

test('the typical example: target 100, 50 on hand, order 50, with the why', () => {
    const s = suggestOrder({ ...base, quantity: 50, minimum: 60, target_level: 100 });
    assert.equal(s.status, 'order_now'); assert.equal(s.order, 50);
    assert.equal(s.why, 'There are 50 piece; the minimum is 60 and the target level is 100. Order 50 piece to reach 100.');
});
test('thresholds follow the level scale: <= minimum orders now; <= minimum x 1.25 orders soon; above, up to date', () => {
    const p = { ...base, minimum: 40, target_level: 100 };
    assert.equal(suggestOrder({ ...p, quantity: 40 }).status, 'order_now', 'equal to the minimum already counts as below it');
    assert.equal(suggestOrder({ ...p, quantity: 41 }).status, 'order_soon');
    assert.equal(suggestOrder({ ...p, quantity: 50 }).status, 'order_soon', '40 x 1.25 = 50');
    const upToDate = suggestOrder({ ...p, quantity: 51 });
    assert.equal(upToDate.status, 'up_to_date'); assert.equal(upToDate.order, null);
});
test('never an invented zero: no suggestion when it is not counted, even if the balance is 0', () => {
    const s = suggestOrder({ ...base, quantity: 0, minimum: 60, target_level: 100, count_pending: true });
    assert.equal(s.status, 'no_data'); assert.equal(s.reason, 'not_counted'); assert.equal(s.order, null);
    assert.doesNotMatch(s.why, /Order/);
});
test('no_balance (discs, electrodes, gases): no data, and it says so; stock is not made up', () => {
    const s = suggestOrder({ ...base, control_type: 'no_balance', quantity: 0, minimum: 60, target_level: 100 });
    assert.equal(s.status, 'no_data'); assert.equal(s.reason, 'no_stock_tracking');
});
test('no minimum: no data. No target: says it is time but not how much', () => {
    assert.equal(suggestOrder({ ...base, quantity: 5, minimum: null }).reason, 'no_minimum');
    const s = suggestOrder({ ...base, quantity: 5, minimum: 10, target_level: null });
    assert.equal(s.status, 'order_now'); assert.equal(s.order, null); assert.equal(s.reason, 'no_target');
    assert.match(s.why, /Set a target level/);
});
test('a target that does not exceed the minimum is bad data, not an order of zero', () => {
    const s = suggestOrder({ ...base, quantity: 5, minimum: 10, target_level: 10 });
    assert.equal(s.status, 'no_data'); assert.equal(s.reason, 'invalid_target');
});
test('whole units round up to whole; measures keep decimals', () => {
    const pair = suggestOrder({ ...base, unit: 'pair', quantity: 2, minimum: 4, target_level: 9.5 });
    assert.equal(pair.order, 8, 'half a pair is not bought: 7.5 becomes 8');
    const kg = suggestOrder({ ...base, unit: 'kg', quantity: 2, minimum: 4, target_level: 9.5 });
    assert.equal(kg.order, 7.5);
});
test('numbers arrive as numeric text and do not break', () => {
    const s = suggestOrder({ ...base, quantity: '50.000', minimum: '60.000', target_level: '100.000' });
    assert.equal(s.order, 50);
});
test('requisition: lists the urgent first and only counts the no-data ones, by reason', () => {
    const list = [
        { ...base, id: 1, code: 'B', quantity: 50, minimum: 40, target_level: 100 },                  // soon
        { ...base, id: 2, code: 'A', quantity: 10, minimum: 40, target_level: 100 },                  // now
        { ...base, id: 3, code: 'C', quantity: 500, minimum: 40, target_level: 100 },                 // up to date
        { ...base, id: 4, code: 'D', quantity: 0, minimum: null },                                    // no minimum
        { ...base, id: 5, code: 'E', quantity: 0, minimum: 5, count_pending: true },                  // not counted
        { ...base, id: 6, code: 'F', quantity: 0, minimum: 5, control_type: 'no_balance' },           // no stock tracking
        { ...base, id: 7, code: 'G', quantity: 0, minimum: null, count_pending: true },               // not counted
    ];
    const r = requisition(list);
    assert.deepEqual(r.order.map(x => x.code), ['A', 'B']);
    assert.deepEqual(r.summary, { order_now: 1, order_soon: 1, up_to_date: 1, no_data: { no_minimum: 1, not_counted: 2, no_stock_tracking: 1 } });
    assert.equal(r.order.length, 2, 'no-data products are not listed');
});
