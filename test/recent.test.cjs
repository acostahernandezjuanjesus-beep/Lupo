const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestPurchases, priceChanges } = require('../recent');

let id = 0;
const row = (extra = {}) => ({
    id: ++id, date: '2026-10-05', folio: 'A1', supplier: 'Acme Tools', description: 'LIJA FINA', description_norm: 'LIJA FINA',
    unit_price: '15.000', amount: '150.00', code: null, product: null, ...extra,
});
const TODAY = new Date('2026-10-14T12:00:00Z');

test('latestPurchases: a folio is one purchase and its lines are summed', () => {
    const r = latestPurchases([
        row({ folio: 'A1', amount: '100.00' }), row({ folio: 'A1', amount: '50.50' }),
        row({ folio: 'B2', supplier: 'Bolt Co', date: '2026-10-07', amount: '30.00' }),
    ]);
    assert.deepEqual(r, [
        { date: '2026-10-07', folio: 'B2', supplier: 'Bolt Co', lines: 1, amount: '30.00' },
        { date: '2026-10-05', folio: 'A1', supplier: 'Acme Tools', lines: 2, amount: '150.50' },
    ]);
});

test('latestPurchases: the same folio from another supplier or date is not merged; without a folio each line is a purchase', () => {
    const r = latestPurchases([
        row({ folio: 'A1' }), row({ folio: 'A1', supplier: 'Bolt Co' }), row({ folio: 'A1', date: '2026-10-06' }),
        row({ folio: null }), row({ folio: null }),
    ]);
    assert.equal(r.length, 5);
});

test('latestPurchases: newest first and only the n requested', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row({ folio: `F${i}`, date: `2026-10-0${i + 1}` }));
    assert.deepEqual(latestPurchases(rows, 3).map(c => c.folio), ['F7', 'F6', 'F5']);
});

test('priceChanges: latest against previous of the same description, with the change in %', () => {
    const r = priceChanges([
        row({ date: '2026-09-01', folio: 'X', unit_price: '100.000' }),
        row({ date: '2026-10-05', folio: 'Y', unit_price: '110.000', supplier: 'Bolt Co' }),
    ], { today: TODAY });
    assert.equal(r.length, 1);
    assert.equal(r[0].change, 10);
    assert.deepEqual(r[0].previous, { price: '100', date: '2026-09-01', supplier: 'Acme Tools' });
    assert.deepEqual(r[0].latest, { price: '110', date: '2026-10-05', supplier: 'Bolt Co' });
});

test('priceChanges: the same price, or a change under 2%, is not news', () => {
    const base = { description_norm: 'A', description: 'A' };
    const pair = unit_price => [row({ ...base, date: '2026-09-01', folio: 'X', unit_price: '100' }), row({ ...base, folio: 'Y', unit_price })];
    assert.deepEqual(priceChanges(pair('100'), { today: TODAY }), []);
    assert.deepEqual(priceChanges(pair('101.9'), { today: TODAY }), []);
    assert.equal(priceChanges(pair('102'), { today: TODAY }).length, 1);
});

test('priceChanges: a single purchase has nothing to compare with, and no price does not count', () => {
    assert.deepEqual(priceChanges([row()], { today: TODAY }), []);
    assert.deepEqual(priceChanges([row({ unit_price: '0' }), row({ unit_price: null, folio: 'Z', date: '2026-10-06' })], { today: TODAY }), []);
});

test('priceChanges: compares the SAME description, not those sharing a product', () => {
    const r = priceChanges([
        row({ description_norm: 'EXTENSION 3 M', description: 'EXTENSION 3 M', product: 'Extension cord', code: 'ELE-EXT', date: '2026-09-01', folio: 'X', unit_price: '42.24' }),
        row({ description_norm: 'EXTENSION 6 M', description: 'EXTENSION 6 M', product: 'Extension cord', code: 'ELE-EXT', date: '2026-10-05', folio: 'Y', unit_price: '50.86' }),
    ], { today: TODAY });
    assert.deepEqual(r, [], 'two sizes of the same product are not a price change');
});

test('priceChanges: only what is recent relative to the latest date on record, newest first', () => {
    const f = (d, date, folio, unit_price) => row({ description_norm: d, description: d, date, folio, unit_price });
    const r = priceChanges([
        f('V', '2026-03-01', 'a', '10'), f('V', '2026-04-01', 'b', '20'),
        f('N1', '2026-09-20', 'c', '10'), f('N1', '2026-09-25', 'd', '12'),
        f('N2', '2026-09-20', 'e', '10'), f('N2', '2026-10-10', 'f', '5'),
    ], { today: TODAY });
    assert.deepEqual(r.map(c => c.name), ['N2', 'N1'], 'V changed in April: no longer recent');
    assert.equal(r[0].change, -50);
});

test('priceChanges: the name is the product name when linked, and a future date from a typo does not push out recent ones', () => {
    const r = priceChanges([
        row({ product: 'American Thinner', code: 'LUB-T', date: '2026-10-01', folio: 'a', unit_price: '40' }),
        row({ product: 'American Thinner', code: 'LUB-T', date: '2026-10-13', folio: 'b', unit_price: '44' }),
        row({ description_norm: 'ERROR', description: 'ERROR', date: '2036-01-01', folio: 'z', unit_price: '1' }),
    ], { today: TODAY });
    assert.equal(r.length, 1);
    assert.equal(r[0].name, 'American Thinner');
    assert.equal(r[0].code, 'LUB-T');
});
