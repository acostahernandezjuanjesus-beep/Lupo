const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const { load } = require('../scripts/loadTS.cjs');
const { skip, createDb } = require('../scripts/testDb.cjs');
const { highThreshold, bookIncomplete } = load('purchases/spikes.ts');

// What the Purchases dashboard does when NEW purchase books arrive: it must not assume a fixed number of
// books, a half-finished month must be flagged incomplete without moving the median, and invoices
// must not leak into Purchases. All fake data, run against real PostgreSQL.

let db, server, url;

before(async () => {
    if (skip) return;
    db = await createDb('purchases');
    await db.pool.query(`INSERT INTO users (name, username, role) VALUES ('Test', 'test', 'storekeeper')`);
    const identity = {
        requireSession: () => (req, res, next) => { req.user = { id: 1, role: 'storekeeper' }; next(); },
        requireRole: (...roles) => (req, res, next) =>
            roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Insufficient role' }),
    };
    server = createApp(db.pool, identity).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120_000 });

after(async () => {
    if (skip) return;
    await new Promise(resolve => server.close(resolve));
    await db.close();
});

const get = async route => { const r = await fetch(url + route); assert.equal(r.status, 200, route); return r.json(); };
const summary = () => get('/api/purchases/summary?group_by=category');

// A book for `period` with `n` purchases between days `from` and `to` of the month (amount = 2 x (100 + i)).
async function book(period, from, to, n = 20) {
    const { rows: [b] } = await db.pool.query(
        `INSERT INTO purchase_books (file, period) VALUES ($1, $2) RETURNING id`, [`TEST BOOK ${period}`, period]);
    await addLines(b.id, period, from, to, n);
    return b.id;
}
async function addLines(bookId, period, from, to, n) {
    const { rows: [{ max }] } = await db.pool.query(`SELECT COALESCE(max(row_num), 0)::int AS max FROM purchases WHERE book_id = $1`, [bookId]);
    await db.pool.query(
        `INSERT INTO purchases (book_id, sheet, sheet_order, cell, row_num, type, date, date_status, description, quantity, unit_price)
         SELECT $1::int, 'S1', 1, 'A' || ($5::int + i), $5::int + i, 'purchase',
                make_date(substr($2::text, 1, 4)::int, substr($2::text, 6, 2)::int, $3::int + ((i - 1) % ($4::int - $3::int + 1))),
                'explicit date', 'TEST ITEM ' || ($5::int + i), 2, 100 + i
           FROM generate_series(1, $6::int) AS i`, [bookId, period, from, to, max, n]);
}
const months = (from, to) => {
    const r = []; let [y, m] = from.split('-').map(Number);
    while (`${y}-${String(m).padStart(2, '0')}` <= to) { r.push(`${y}-${String(m).padStart(2, '0')}`); if (++m > 12) { m = 1; y++; } }
    return r;
};

test('with no books: no period, no amount (null, not "0") and an empty series', { skip }, async () => {
    assert.deepEqual(await get('/api/purchases/books'), []);
    const r = await summary();
    assert.deepEqual(r.period, { first_book: null, last_book: null, books: 0 });
    assert.equal(r.summary.amount, null);
    assert.equal(r.summary.purchases, 0);
    assert.deepEqual(r.monthly_series, []);
});

test('13 books: 13 months in order, both Augusts incomplete and 11 in the median', { skip }, async () => {
    for (const p of months('2025-08', '2026-08')) {
        if (p === '2025-08') await book(p, 11, 31);           // starts on the 11th
        else if (p === '2026-08') await book(p, 1, 11);       // ends on the 11th
        else await book(p, 1, 28);
    }
    const r = await summary();
    assert.deepEqual(r.period, { first_book: '2025-08', last_book: '2026-08', books: 13 });
    assert.deepEqual(r.monthly_series.map(m => m.period), months('2025-08', '2026-08'));
    const expected = (await db.pool.query(`SELECT sum(amount)::text AS s FROM purchases WHERE type = 'purchase'`)).rows[0].s;
    assert.equal(r.summary.amount, expected, 'the dashboard amount matches the database to the cent');
    assert.equal(r.summary.purchases, 13 * 20);
    assert.equal((await get('/api/purchases/books')).length, 13);
    // Both Augusts are half books and stay out of the median.
    assert.deepEqual(r.monthly_series.filter(bookIncomplete).map(m => m.period), ['2025-08', '2026-08']);
    assert.equal(highThreshold(r.monthly_series).complete, 11);
});

test('a NEW book (September, partial) shows up, is flagged incomplete and does not move the median', { skip }, async () => {
    const before = await summary();
    const medianBefore = highThreshold(before.monthly_series).median;
    const id = await book('2026-09', 1, 8, 8);                // 8 purchases, one per day from the 1st to the 8th
    const r = await summary();
    assert.deepEqual(r.period, { first_book: '2025-08', last_book: '2026-09', books: 14 });
    const added = r.monthly_series.at(-1);
    assert.equal(added.period, '2026-09');
    assert.equal(added.purchases, 8);
    assert.equal(added.last_date, '2026-09-08');
    assert.equal(bookIncomplete(added), true, 'ends before the 20th: incomplete book');
    const t = highThreshold(r.monthly_series);
    assert.equal(t.complete, 11, 'the partial month does not count for the median');
    assert.equal(t.median, medianBefore, 'and does not move it');
    assert.equal(r.summary.purchases, before.summary.purchases + 8);

    // The other endpoints see it too.
    const books = await get('/api/purchases/books');
    assert.equal(books.length, 14);
    assert.equal(books.at(-1).period, '2026-09');
    assert.equal((await get(`/api/purchases?book_id=${id}`)).total, 8);
    const only = await get('/api/purchases/summary?from=2026-09&to=2026-09&group_by=category');
    assert.equal(only.period.books, 1);
    assert.equal(only.summary.purchases, 8);

    // Once the book is complete (reaches the 28th) it enters the median: 12 complete months.
    await addLines(id, '2026-09', 9, 28, 20);
    const complete = await summary();
    assert.equal(bookIncomplete(complete.monthly_series.at(-1)), false);
    assert.equal(highThreshold(complete.monthly_series).complete, 12);
});

// There is no path from an invoice to Purchases: `invoices` and `invoice_lines` feed accounts payable and
// stock-ins, while Purchases reads only `purchase_books` and `purchases`. This pins that behaviour.
test('a registered invoice does NOT show up in Purchases (they are separate worlds)', { skip }, async () => {
    const before = await summary();
    const { rows: [inv] } = await db.pool.query(
        `INSERT INTO invoices (source, issuer_name, invoice_date, captured_by, total)
         VALUES ('manual', 'TEST SUPPLIER', '2026-09-05', 1, 1160.00) RETURNING id`);
    await db.pool.query(
        `INSERT INTO invoice_lines (invoice_id, sort_order, description, quantity, unit_value, amount)
         VALUES ($1, 1, 'TEST INVOICED ITEM', 10, 100, 1000.00)`, [inv.id]);
    const after = await summary();
    assert.deepEqual(after.period, before.period);
    assert.equal(after.summary.purchases, before.summary.purchases);
    assert.equal(after.summary.amount, before.summary.amount);
    assert.deepEqual(after.monthly_series, before.monthly_series);
    // The invoice does exist.
    assert.equal((await db.pool.query(`SELECT count(*)::int AS n FROM invoices`)).rows[0].n, 1);
});
