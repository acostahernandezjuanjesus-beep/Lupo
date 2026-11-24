/* eslint-disable no-irregular-whitespace -- invisible characters are the test data */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// Persistence double: exercises the real HTTP contract and the transaction limits,
// with no credentials, sessions or writes to a real database.
async function setup(t, balance = 5, control = 'stock', role = 'admin', pending = true) {
    const product = { id: 1, code: 'TEST', name: 'Test', quantity: balance, control_type: control, count_pending: pending };
    const queries = [], movements = [], categories = ['Tool'];
    const pool = {
        async query(sql, args = []) {
            queries.push({ sql, args });
            if (/INSERT INTO categories/.test(sql)) {
                // two identical requests at once: the database UNIQUE answers 23505
                if (args[0] === 'Race') throw Object.assign(new Error('duplicate'), { code: '23505' });
                if (categories.some(c => c.toLowerCase() === args[0].toLowerCase())) return { rows: [] };
                categories.push(args[0]);
                return { rows: [{ id: categories.length, name: args[0] }] };
            }
            if (/FROM products WHERE id/.test(sql)) return { rows: [{ ...product }] };
            if (/INSERT INTO movements/.test(sql)) {
                const m = { id: 1, quantity: args[2], user_id: args[3], note: args[8], over_negative: args[9] };
                movements.push(m); return { rows: [m] };
            }
            if (/UPDATE products/.test(sql)) {
                if (/SET quantity/.test(sql)) product.quantity = args[0];
                if (!/CASE/.test(sql) || args[1]) product.count_pending = false;
            }
            if (/SELECT COUNT/.test(sql)) return { rows: [{ count: '57' }] };
            return { rows: [] };
        },
        async connect() { return { query: this.query.bind(this), release() {} }; },
    };
    // the double models session AND role, so tests can touch the role too
    const identity = {
        requireSession: () => (req, res, next) => { req.user = { id: 7, role }; next(); },
        requireRole: (...roles) => (req, res, next) =>
            roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Insufficient role' }),
    };
    const server = createApp(pool, identity).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    async function post(body) {
        const r = await fetch(`${url}/api/movements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() };
    }
    return { product, movements, queries, categories, post, url };
}
for (const [type, expected] of [['in', 7], ['return', 7], ['out', 3], ['loan', 3]]) {
    test(`${type}: correct sign, quantity as string and author from the session`, async t => {
        const e = await setup(t);
        const r = await e.post({ product_id: 1, type, quantity: '2', user_id: 999 });
        assert.equal(r.status, 201); assert.equal(r.body.new_balance, expected);
        assert.equal(e.movements[0].user_id, 7);
        assert.equal(e.product.count_pending, true);
        assert.match(e.queries.find(q => /FROM products WHERE id/.test(q.sql)).sql, /FOR UPDATE/);
    });
}
for (const [count, direction, delta] of [[7, 'surplus', 2], [2, 'shortfall', 3]]) {
    test(`adjustment ${direction}: absolute count on a counted product`, async t => {
        const e = await setup(t, 5, 'stock', 'admin', false);
        const r = await e.post({ product_id: 1, type: 'adjustment', count, note: 'Recounted' });
        assert.equal(r.status, 201); assert.equal(r.body.new_balance, count);
        assert.equal(e.movements[0].quantity, delta);
        assert.equal(e.movements[0].note, `Physical count: ${count} (${direction} of ${delta}) — Recounted`);
        assert.equal(e.product.count_pending, false);
    });
}
// The first count claims no surplus or shortfall: the balance it would be compared with started from a zero nobody
// measured. The movement quantity is still the difference, so the log adds up with the balance.
test('first count of an uncounted product: no made-up surplus, and the pending flag is resolved', async t => {
    const e = await setup(t, -3, 'stock', 'admin', true);
    const r = await e.post({ product_id: 1, type: 'adjustment', count: 5, note: 'Counted in the drawer' });
    assert.equal(r.status, 201); assert.equal(r.body.new_balance, 5);
    assert.equal(e.movements[0].note, 'First physical count: 5 — Counted in the drawer');
    assert.equal(e.movements[0].quantity, 8);
    assert.equal(e.product.count_pending, false);
});
// Counting a no_balance product makes it stock-tracked, with the counted amount (the note must not say "surplus of 40" against a zero that measured nothing).
test('counting a no_balance product: admin only, with confirmation, and it becomes stock-tracked with the count', async t => {
    const e = await setup(t, 0, 'no_balance', 'admin', false);
    let r = await e.post({ product_id: 1, type: 'adjustment', count: 40 });
    assert.equal(r.status, 409); assert.equal(r.body.error_code, 'no_balance'); assert.equal(r.body.confirm_with, 'track_stock');
    assert.equal(e.movements.length, 0, 'nothing is written without confirmation');
    r = await e.post({ product_id: 1, type: 'adjustment', count: 40, track_stock: true });
    assert.equal(r.status, 201); assert.equal(r.body.new_balance, 40); assert.equal(r.body.now_tracks_stock, true);
    assert.doesNotMatch(e.movements[0].note, /surplus|shortfall/);
    assert.match(e.movements[0].note, /First physical count: 40 — now stock-tracked/);
    const up = e.queries.find(q => /UPDATE products/.test(q.sql));
    assert.equal(up.args[3], true, 'the UPDATE changes the control type');
});
test('counting a no_balance product as storekeeper or operator: 403, even if confirmed', async t => {
    for (const role of ['storekeeper', 'operator']) {
        const e = await setup(t, 0, 'no_balance', role, false);
        const r = await e.post({ product_id: 1, type: 'adjustment', count: 40, track_stock: true });
        // an operator is refused earlier, for adjusting at all (see the test below); a storekeeper for the no_balance product
        assert.equal(r.status, 403, role); assert.equal(r.body.error_code, role === 'operator' ? 'no_permission' : 'no_balance_admin_only');
        assert.equal(e.movements.length, 0);
    }
});
test('an operator does not record counts or enter prices; their outs work as before', async t => {
    const e = await setup(t, 5, 'stock', 'operator', false);
    const adjustment = await e.post({ product_id: 1, type: 'adjustment', count: 9 });
    assert.equal(adjustment.status, 403); assert.equal(adjustment.body.error_code, 'no_permission');
    const withPrice = await e.post({ product_id: 1, type: 'in', quantity: 1, unit_price: 10 });
    assert.equal(withPrice.status, 403); assert.equal(withPrice.body.error_code, 'no_permission');
    assert.equal(e.movements.length, 0);
    assert.equal((await e.post({ product_id: 1, type: 'out', quantity: 1 })).status, 201);
});
test('a price that does not fit the column is a 400, not a 500', async t => {
    const e = await setup(t, 5, 'stock', 'storekeeper', false);
    for (const price of ['99999999999', '1.005', 1e21]) {
        assert.equal((await e.post({ product_id: 1, type: 'in', quantity: 1, unit_price: price })).status, 400, String(price));
    }
    assert.equal((await e.post({ product_id: 1, type: 'in', quantity: 1, unit_price: '1234567890.25' })).status, 201);
});
test('in and out of a no_balance product work as before: recorded without asking anything or changing its type', async t => {
    const e = await setup(t, 0, 'no_balance', 'storekeeper', false);
    const r = await e.post({ product_id: 1, type: 'in', quantity: '3' });
    assert.equal(r.status, 201); assert.equal(r.body.now_tracks_stock, undefined);
    assert.equal(e.queries.find(q => /UPDATE products/.test(q.sql)).args[3], false);
});
for (const balance of [0, 5]) test(`count with no difference (${balance}) confirms without inventing a movement`, async t => {
    const e = await setup(t, balance);
    const r = await e.post({ product_id: 1, type: 'adjustment', count: balance });
    assert.equal(r.status, 200); assert.equal(r.body.unchanged, true);
    assert.equal(e.product.count_pending, false); assert.equal(e.movements.length, 0);
    assert.ok(e.queries.some(q => q.sql === 'COMMIT'));
});
// On a COUNTED product: with a pending count the rule doesn't apply (below).
test('negative: 409 with no write; confirmed retry 201 with the audit flag', async t => {
    const e = await setup(t, 5, 'stock', 'admin', false);
    const body = { product_id: 1, type: 'out', quantity: 8 };
    const r = await e.post(body);
    assert.equal(r.status, 409); assert.equal(r.body.resulting_balance, -3);
    assert.equal(e.movements.length, 0); assert.equal(e.product.quantity, 5);
    assert.ok(e.queries.some(q => q.sql === 'ROLLBACK'));
    const confirmed = await e.post({ ...body, allow_negative: true });
    assert.equal(confirmed.status, 201); assert.equal(confirmed.body.over_negative, true);
});
// Counted on purpose: with a pending count it would be exempt too, and the test
// would stop testing the no_balance exemption.
test('no_balance exempt from the 409', async t => {
    const e = await setup(t, 0, 'no_balance', 'admin', false);
    const r = await e.post({ product_id: 1, type: 'out', quantity: 2 });
    assert.equal(r.status, 201); assert.equal(r.body.over_negative, false);
    assert.equal(e.movements[0].over_negative, false);
});
// A balance that starts from a zero nobody measured isn't "left negative": no 409 and no over_negative flag.
test('uncounted exempt from the 409 and from the negative-balance flag', async t => {
    const e = await setup(t, 0, 'stock', 'admin', true);
    const r = await e.post({ product_id: 1, type: 'out', quantity: 1 });
    assert.equal(r.status, 201);
    assert.equal(r.body.over_negative, false);
    assert.equal(e.movements[0].over_negative, false);
    assert.equal(r.body.new_balance, -1);
    assert.equal(e.product.count_pending, true);
    assert.match(e.queries.find(q => /FOR UPDATE/.test(q.sql)).sql, /count_pending/);
});
test('validation returns 400 before querying products', async t => {
    const e = await setup(t);
    const r = await e.post({ product_id: 0, type: 'out', quantity: 2 });
    assert.equal(r.status, 400); assert.equal(r.body.error, 'product_id must be a positive integer');
    const category = await fetch(`${e.url}/api/products?category_id=abc`);
    assert.equal(category.status, 400);
    assert.equal((await category.json()).error, 'category_id must be a positive integer');
    assert.equal(e.queries.length, 0);
});
test('level filters COUNT and rows before paginating; invalid values are rejected', async t => {
    const e = await setup(t);
    const r = await fetch(`${e.url}/api/products?level=uncounted&page=2`);
    const data = await r.json(); assert.equal(data.total, 57); assert.equal(data.pages, 2);
    assert.equal(e.queries.length, 2);
    for (const q of e.queries) { assert.match(q.sql, /CASE WHEN p.count_pending/); assert.equal(q.args[0], 'uncounted'); }
    assert.deepEqual(e.queries[1].args, ['uncounted', 50, 50]);
    assert.equal((await fetch(`${e.url}/api/products?level=made-up`)).status, 400);
});

test('inventory filters: location, control and sort arrive as parameters; anything invalid is a 400 with no SQL', async t => {
    const e = await setup(t);
    const r = await fetch(`${e.url}/api/products?location=${encodeURIComponent('TAP DRAWER')}&control=no_balance&sort=name`);
    assert.equal(r.status, 200);
    const [count, rows] = e.queries;
    assert.match(count.sql, /p\.location = \$1 AND p\.control_type = \$2/);
    assert.deepEqual(count.args, ['TAP DRAWER', 'no_balance']);
    assert.match(rows.sql, /ORDER BY p\.name, p\.code, p\.id/);

    // No location: empty or null, with no parameter that counts as text
    e.queries.length = 0;
    await fetch(`${e.url}/api/products?location=no_location`);
    assert.match(e.queries[0].sql, /p\.location IS NULL OR btrim\(p\.location\) = ''/);
    assert.deepEqual(e.queries[0].args, []);

    e.queries.length = 0;
    for (const query of ['control=unit', 'control=x', 'sort=price', 'sort=constructor', 'sort=__proto__',
        'sort=name&sort=code', 'location=a&location=b', `location=${'x'.repeat(101)}`]) {
        const bad = await fetch(`${e.url}/api/products?${query}`);
        assert.equal(bad.status, 400, query);
    }
    assert.equal(e.queries.length, 0);
});

test('create: omitted quantity is left uncounted; an explicit zero is confirmed', async t => {
    const e = await setup(t);
    for (const [quantity, pending] of [[null, true], [0, false], [2, false]]) {
        const r = await fetch(`${e.url}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'NEW', name: 'Test', quantity }) });
        assert.equal(r.status, 201);
        const insert = e.queries.filter(q => /INSERT INTO products/.test(q.sql)).at(-1);
        assert.equal(insert.args[7], pending);
    }
});

// What the database would round or reject stops before the SQL: a price with thousandths was silently rounded,
// and an id outside the integer range reached PostgreSQL raw and came out as a 500.
test('create: price with thousandths, quantity with four decimals and out-of-range id → 400 with no SQL', async t => {
    const e = await setup(t);
    const create = body => fetch(`${e.url}/api/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'NEW', name: 'Test', ...body }) });
    const price = await create({ price: '0.258' });
    assert.equal(price.status, 400);
    assert.equal((await price.json()).error, 'price allows up to 8 integer digits and 2 decimals (cents)');
    const quantity = await create({ quantity: '1.2345', unit: 'kg' });
    assert.equal(quantity.status, 400);
    assert.equal((await quantity.json()).error, 'quantity allows up to 9 integer digits and 3 decimals');
    assert.equal((await create({ category_id: 2147483648 })).status, 400);
    assert.equal((await fetch(`${e.url}/api/products?category_id=2147483648`)).status, 400);
    assert.equal(e.queries.length, 0);
    assert.equal((await create({ price: '12.5' })).status, 201);
});

// Without category creation, an empty install cannot add any product.
test('categories: create normalizes spaces, ignores case and returns the shape of GET /api/categories', async t => {
    const e = await setup(t);
    const create = body => fetch(`${e.url}/api/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await create({ name: '  Safety   gear  kit ' });
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { id: 2, name: 'Safety gear kit', prefix: null, examples: [] });
    // the stored name is the normalized one, not the one that arrived
    assert.equal(e.queries.filter(q => /INSERT INTO categories/.test(q.sql)).at(-1).args[0], 'Safety gear kit');
    // "tool" already exists as "Tool"
    const repeated = await create({ name: 'tool' });
    assert.equal(repeated.status, 409);
    assert.equal((await repeated.json()).error, 'A category with that name already exists');
    // two requests at once: one wins and the other gets the same answer, not a 500
    assert.equal((await create({ name: 'Race' })).status, 409);
    assert.deepEqual(e.categories, ['Tool', 'Safety gear kit']);
});

test('categories: empty, whitespace-only, long or non-text name → 400 without touching the database', async t => {
    const e = await setup(t);
    const create = body => fetch(`${e.url}/api/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const name of [undefined, '', '   ', 7, ['x'], { a: 1 }, 'x'.repeat(51)]) {
        const r = await create({ name });
        assert.equal(r.status, 400, JSON.stringify(name));
    }
    assert.equal((await fetch(`${e.url}/api/categories`, { method: 'POST' })).status, 400);   // no body
    assert.equal(e.queries.length, 0);
    assert.equal((await create({ name: 'x'.repeat(50) })).status, 201);                       // 50 is fine
});

// What you get copying from a PDF or an invoice: invisible characters, the same word with the accent
// apart, and names that say nothing. Categories can't be renamed or deleted, so whatever gets in stays.
test('categories: no invisibles, NFC, at least one letter, counted in characters', async t => {
    const e = await setup(t);
    const create = name => fetch(`${e.url}/api/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    // only invisibles, or only punctuation: 400 (nothing to show)
    for (const name of ['​', '­', '⠀', 'ㅤ', '​​  ­', '---', '…', '  ¡! ']) {
        const r = await create(name);
        assert.equal(r.status, 400, JSON.stringify(name));
    }
    // with an invisible in the middle: removed, so the twin "Safety​gear" never exists
    assert.equal((await create('Safety​ gear­ kit')).status, 201);
    assert.equal(e.categories.at(-1), 'Safety gear kit');
    // the BEL control and the direction mark are removed; what's left is the word
    assert.equal((await create('a\u0007b')).status, 201);
    assert.equal(e.categories.at(-1), 'ab');
    assert.equal((await create('‮abc')).status, 201);
    assert.equal(e.categories.at(-1), 'abc');
    // NFD ("e" + loose accent) and NFC are the same word: NFC is stored, and the second is a duplicate
    assert.equal((await create('Eléctrico')).status, 201);
    assert.equal(e.categories.at(-1), 'Eléctrico');
    const twin = await create('Eléctrico');
    assert.equal(twin.status, 409);
    // PostgreSQL counts characters, not UTF-16 units: a letter and 49 emoji are 50 characters (99 units) and
    // fit; with 50 emoji it's 51. (Only emoji wouldn't do either: there's no letter or number.)
    assert.equal((await create('a' + '\u{1F527}'.repeat(49))).status, 201);
    assert.equal((await create('b' + '\u{1F527}'.repeat(50))).status, 400);
    assert.equal((await create('\u{1F527}'.repeat(5))).status, 400);
});

// A POST with no body used to blow up outside the try and Express answered with its HTML,
// including the stack and the server's disk paths.
test('no body or broken JSON: a JSON 400, never the Express stack', async t => {
    const e = await setup(t);
    for (const path of ['/api/session', '/api/movements']) {
        const r = await fetch(`${e.url}${path}`, { method: 'POST' });
        assert.equal(r.status, 400, path);
        assert.match(r.headers.get('content-type'), /json/, path);
        assert.doesNotMatch(await r.text(), /index\.js|at /, path);
    }
    const broken = await fetch(`${e.url}/api/movements`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":' });
    assert.equal(broken.status, 400);
    assert.equal((await broken.json()).error, 'The body is not valid JSON');
    assert.equal(e.movements.length, 0);
});
test('an /api route that does not exist is a JSON 404 and does not reveal Express', async t => {
    const e = await setup(t);
    const r = await fetch(`${e.url}/api/does-not-exist`);
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error, 'Route not found');
    assert.equal(r.headers.get('x-powered-by'), null);
});
// It used to only require a number: 0.0001 rounded to 0 in numeric(12,3) and hit the CHECK (500),
// half a pair went through, and a folio over 40 characters blew the varchar(40).
test('movement: fraction of a whole unit, four decimals and long folio → 400 with no write', async t => {
    const e = await setup(t);
    e.product.unit = 'pair';
    const half = await e.post({ product_id: 1, type: 'out', quantity: 0.5 });
    assert.equal(half.status, 400);
    assert.equal(half.body.error, 'fractions of "pair" are not allowed');
    assert.ok(e.queries.some(q => q.sql === 'ROLLBACK'));
    const count = await e.post({ product_id: 1, type: 'adjustment', count: 2.5 });
    assert.equal(count.status, 400);
    assert.equal((await e.post({ product_id: 1, type: 'out', quantity: '0.0001' })).status, 400);
    assert.equal((await e.post({ product_id: 1, type: 'out', quantity: '0.000' })).status, 400);
    assert.equal((await e.post({ product_id: 1, type: 'out', quantity: 1, folio: 'F'.repeat(41) })).status, 400);
    assert.equal((await e.post({ product_id: 1, type: 'out', quantity: 1, note: { a: 1 } })).status, 400);
    assert.equal(e.movements.length, 0);
    e.product.unit = 'kg';
    assert.equal((await e.post({ product_id: 1, type: 'out', quantity: '0.5' })).status, 201);
});
test('allow_negative only confirms with true: "false" as text does not skip the 409', async t => {
    const e = await setup(t, 5, 'stock', 'admin', false);
    for (const value of ['false', 'true', 1]) {
        const r = await e.post({ product_id: 1, type: 'out', quantity: 8, allow_negative: value });
        assert.equal(r.status, 409, JSON.stringify(value));
    }
    assert.equal(e.movements.length, 0);
});
test('health: 200 with a database, 503 without it, and no session required', async t => {
    const e = await setup(t);
    const r = await fetch(`${e.url}/api/health`);
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    // real identity (no double): if it asked for a session, this would be 401
    const down = { async query() { throw new Error('ECONNREFUSED'); } };
    const server = createApp(down).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const without = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    assert.equal(without.status, 503); assert.equal((await without.json()).ok, false);
});

// The dashboard draws the whole scale: all five levels always arrive, as numbers, even if one has
// no products (a missing level isn't an "unknown" zero, it's a real zero: no product falls there).
test('summary: complete levels as numbers, not counting the no_balance ones', async t => {
    const queries = [];
    const pool = { async query(sql) {
        queries.push(sql);
        return { rows: [{ products: '609', with_stock: '567', levels: { uncounted: 57, ample: 12 } }] };
    } };
    const identity = { requireSession: () => (req, res, next) => { req.user = { id: 1, role: 'operator' }; next(); }, requireRole: () => (q, r, n) => n() };
    const server = createApp(pool, identity).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/summary`)).json();
    assert.equal(r.products, 609); assert.equal(r.with_stock, 567);
    assert.deepEqual(r.levels, { uncounted: 57, no_minimum: 0, below_min: 0, restock: 0, ample: 12 });
    assert.match(queries[0], /control_type <> 'no_balance'\s+GROUP BY 1/);
});
