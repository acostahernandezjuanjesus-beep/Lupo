const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../scripts/loadTS.cjs');
const { bookIncomplete, highThreshold } = load('purchases/spikes.ts');

// Thirteen monthly books with made-up amounts.
const series = [
    ['2025-08', 50000, '2025-08-11', '2025-08-29'], ['2025-09', 130000, '2025-09-01', '2025-10-03'],
    ['2025-10', 100000, '2025-10-07', '2025-10-31'], ['2025-11', 110000, '2025-11-03', '2025-11-28'],
    ['2025-12', 120000, '2025-12-01', '2025-12-23'], ['2026-01', 95000, '2026-01-05', '2026-01-30'],
    ['2026-02', 105000, '2026-02-03', '2026-02-27'], ['2026-03', 150000, '2026-03-02', '2026-04-02'],
    ['2026-04', 200000, '2026-04-06', '2026-04-30'], ['2026-05', 90000, '2026-05-04', '2026-05-29'],
    ['2026-06', 180000, '2026-06-01', '2026-07-03'], ['2026-07', 140000, '2026-07-06', '2026-07-31'],
    ['2026-08', 40000, '2026-08-03', '2026-08-11'],
].map(([period, amount, first_date, last_date]) => ({ period, amount: String(amount), first_date, last_date }));

test('incomplete: only the two Augusts; December (ends on the 23rd) and books that run into the next month count', () => {
    assert.deepEqual(series.filter(bookIncomplete).map(m => m.period), ['2025-08', '2026-08']);
});
test('high = median of the complete books +30%: April and June here', () => {
    const t = highThreshold(series);
    assert.equal(t.complete, 11);
    assert.equal(t.median, 120000);
    assert.ok(Math.abs(t.threshold - 156000) < 0.1);
    assert.deepEqual(series.filter(m => Number(m.amount) > t.threshold).map(m => m.period), ['2026-04', '2026-06']);
});
test('with no complete months there is no threshold: no base is invented', () => {
    assert.equal(highThreshold([series[0]]), null);
    assert.equal(highThreshold([]), null);
});
