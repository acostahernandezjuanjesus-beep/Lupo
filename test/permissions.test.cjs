const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// Role permissions. These rules live on the server and are invisible from the UI:
// hiding a menu link doesn't hide an endpoint.
//   - the storekeeper sees purchases (they are costs); the operator doesn't
//   - the operator doesn't see who holds a tool, or they'd ask the coworker directly and the out would skip the storeroom
//   - nobody outside storekeeper and admin sees prices
async function setup(t, role) {
    const queries = [];
    const pool = {
        async query(sql, args = []) {
            queries.push({ sql, args });
            // Purchases queries go before the generic cases: a generic "FROM movements m" match once returned the
            // wrong row and the route failed with a 500 the test didn't notice. Each purchases query gets a row of
            // its own shape, and the tests require the exact success status, not just "not 403".
            // Product rows go before purchases: for a storekeeper the products SELECT includes the last purchase,
            // which reads purchase_books. The row has only what the query asked for: no `p.price` or
            // `last_purchase` in the SELECT, no key in the row. The catalog COUNT is not a product row.
            if (/FROM products p\s/.test(sql) && !/SELECT COUNT|UNION ALL/.test(sql)) {
                const row = { id: 1, code: 'TEST', name: 'Test', quantity: 3 };
                if (/p\.price/.test(sql)) row.price = '123.45';
                if (/last_purchase/.test(sql)) row.last_purchase = { price: '120.00', date: '2026-08-01', period: '2026-08', supplier: 'X' };
                if (/m\.unit_price/.test(sql)) row.unit_price = '99.00';
                return { rows: [row] };
            }
            if (/purchase_books/.test(sql)) {
                return {
                    rows: [{
                        period: { first_book: null, last_book: null, books: 0 },
                        summary: { purchases: 0, no_amount: 0, notes: 0, amount: null },
                        coverage: {}, monthly_series: [], breakdown: [],
                        total: 0, lines: [], purchase_groups: [],
                    }],
                };
            }
            if (/FROM purchases\s+WHERE description_norm/.test(sql)) {
                return { rows: [{ lines: 1, purchases: 1, amount: '10.000000' }] };
            }
            if (/FROM product_aliases a/.test(sql)) return { rows: [] };
            if (/INSERT INTO product_aliases/.test(sql)) {
                return { rows: [{ id: 1, alias_id: 1, code: 'TEST', name: 'Test' }] };
            }
            // create from a scanned code: nobody owns the code
            if (/UNION ALL/.test(sql)) return { rows: [] };
            if (/INSERT INTO product_codes/.test(sql)) {
                return { rows: [{ id: 1, code: '7500000000017', format: null }] };
            }
            if (/INSERT INTO products/.test(sql)) {
                return { rows: [{ id: 2, code: 'NEW', name: 'New', count_pending: true }] };
            }
            if (/INSERT INTO categories/.test(sql)) return { rows: [{ id: 5, name: args[0] }] };
            if (/DELETE FROM product_aliases/.test(sql)) return { rows: [], rowCount: 1 };
            if (/SELECT COUNT/.test(sql)) return { rows: [{ count: '1' }] };
            if (/FROM movements m/.test(sql)) {
                const row = { id: 1, type: 'out', user: 'Storekeeper', responsible: 'Other' };
                if (/m\.unit_price/.test(sql)) row.unit_price = '99.00';
                return { rows: [row] };
            }
            if (/GROUP BY location/.test(sql)) return { rows: [{ location: 'DRAWER', products: 4 }] };
            if (/btrim\(location\) = ''/.test(sql)) return { rows: [{ products: 2 }] };
            return { rows: [] };
        },
        async connect() { return { query: this.query.bind(this), release() {} }; },
    };
    const identity = {
        requireSession: () => (req, res, next) => { req.user = { id: 7, role }; next(); },
        requireRole: (...roles) => (req, res, next) =>
            roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Insufficient role' }),
    };
    const server = createApp(pool, identity).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, method = 'GET', body) => {
        const init = { method };
        if (body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = JSON.stringify(body);
        }
        const r = await fetch(url + path, init);
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    return { request, queries };
}

// Every purchases endpoint with a valid request and its success status.
const PURCHASES = [
    ['GET', '/api/purchases/books', undefined, 200],
    ['GET', '/api/purchases/summary?group_by=category', undefined, 200],
    ['GET', '/api/purchases?status=linked', undefined, 200],
    ['GET', '/api/purchases/recurring', undefined, 200],
    ['GET', '/api/purchases/recent', undefined, 200],
    ['POST', '/api/purchases/link', { description: 'DISC', product_id: 1 }, 201],
    ['POST', '/api/purchases/bring',
        { description: 'DISC', product: { code: 'NEW', name: 'New', control_type: 'stock' } }, 201],
    ['DELETE', '/api/purchases/links/1', undefined, 204],
];

test('purchases: the operator gets 403 on every endpoint and no query runs', async t => {
    const e = await setup(t, 'operator');
    // invalid parameters too: the role is checked before validation, so the operator can't probe which filters exist
    const invalid = [
        ['GET', '/api/purchases/summary?from=bad&group_by=nothing'],
        ['GET', '/api/purchases?book_id=abc'],
        ['GET', '/api/purchases/recurring?page=1e100'],
        ['POST', '/api/purchases/link', {}],
        ['POST', '/api/purchases/bring', { product: 'x' }],
        ['DELETE', '/api/purchases/links/abc'],
    ];
    for (const [method, path, body] of [...PURCHASES, ...invalid]) {
        const r = await e.request(path, method, body);
        assert.equal(r.status, 403, `${method} ${path}`);
    }
    // and it bounces BEFORE querying: no query is paid for just to throw it away
    assert.equal(e.queries.length, 0);
});

test('purchases: storekeeper and admin get into every endpoint', async t => {
    for (const role of ['storekeeper', 'admin']) {
        const e = await setup(t, role);
        for (const [method, path, body, expected] of PURCHASES) {
            const r = await e.request(path, method, body);
            assert.equal(r.status, expected, `${role}: ${method} ${path}`);
        }
    }
});

test('movements: the operator only reaches their own; the storekeeper sees everything', async t => {
    const op = await setup(t, 'operator');
    await op.request('/api/movements');
    const filtered = op.queries.filter(q => /user_id = \$1 OR m\.responsible_id = \$1/.test(q.sql));
    assert.equal(filtered.length, 2, 'the filter must be in the COUNT and in the detail');
    // the id comes from the session, never the query: if it came from the client, changing the URL would show someone else's movements
    assert.equal(filtered[0].args[0], 7);

    const sk = await setup(t, 'storekeeper');
    await sk.request('/api/movements');
    assert.equal(sk.queries.filter(q => /responsible_id = \$/.test(q.sql)).length, 0);
});

// Creating categories changes the catalog structure, so it's for storekeeper and admin, like creating a product.
// The operator bounces BEFORE querying, even with an invalid body.
test('categories: the operator cannot create (403, no queries); storekeeper and admin can', async t => {
    const op = await setup(t, 'operator');
    for (const body of [{ name: 'New' }, {}, { name: 'x'.repeat(80) }]) {
        assert.equal((await op.request('/api/categories', 'POST', body)).status, 403);
    }
    assert.equal(op.queries.length, 0);
    // listing them stays open to anyone with a session: the operator needs them to filter the inventory
    assert.equal((await op.request('/api/categories')).status, 200);
    for (const role of ['storekeeper', 'admin']) {
        const e = await setup(t, role);
        const r = await e.request('/api/categories', 'POST', { name: 'New' });
        assert.equal(r.status, 201, role);
        assert.deepEqual(r.body, { id: 5, name: 'New', prefix: null, examples: [] });
    }
});

test('movements: the operator cannot widen their scope through the URL', async t => {
    const e = await setup(t, 'operator');
    // even asking for someone else's product, the per-person cut stays on
    await e.request('/api/movements?product_id=99&type=out');
    const detail = e.queries.find(q => /FROM movements m/.test(q.sql));
    assert.match(detail.sql, /user_id = \$1 OR m\.responsible_id = \$1/);
    assert.equal(detail.args[0], 7);
});

test('price: the key is omitted for the operator in the catalog and by-code', async t => {
    for (const path of ['/api/products', '/api/products/by-code?code=TEST']) {
        const op = await setup(t, 'operator');
        const r = await op.request(path);
        const row = Array.isArray(r.body?.products) ? r.body.products[0] : r.body;
        // omitted, not sent as null: null would say "no price recorded", which is not the same as "you can't see it"
        assert.equal('price' in row, false, `${path} must not carry the price key`);
        // the last purchase from the books is cost too: it doesn't travel either
        assert.equal('last_purchase' in row, false, `${path} must not carry the last_purchase key`);

        const sk = await setup(t, 'storekeeper');
        const r2 = await sk.request(path);
        const row2 = Array.isArray(r2.body?.products) ? r2.body.products[0] : r2.body;
        assert.equal(row2.price, '123.45');
        assert.equal(row2.last_purchase.price, '120.00');
    }
});

test('price: the movement log omits the unit price for the operator', async t => {
    const op = await setup(t, 'operator');
    const r = await op.request('/api/movements');
    assert.equal(r.status, 200);
    assert.equal('unit_price' in r.body.movements[0], false);

    const sk = await setup(t, 'storekeeper');
    const r2 = await sk.request('/api/movements');
    assert.equal(r2.body.movements[0].unit_price, '99.00');
});

test('purchases of a product: only storekeeper and admin, and the operator bounces without querying', async t => {
    const op = await setup(t, 'operator');
    for (const path of ['/api/products/1/purchases', '/api/products/abc/purchases']) {
        assert.equal((await op.request(path)).status, 403, path);
    }
    assert.equal(op.queries.length, 0);
    for (const role of ['storekeeper', 'admin']) {
        const e = await setup(t, role);
        assert.equal((await e.request('/api/products/1/purchases')).status, 200, role);
        assert.equal((await e.request('/api/products/abc/purchases')).status, 400, role);
    }
});

test('locations: anyone with a session, with the products that have no location counted apart', async t => {
    const op = await setup(t, 'operator');
    const r = await op.request('/api/locations');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { locations: [{ location: 'DRAWER', products: 4 }], no_location: 2 });
});

test('catalog: creating from a scanned code is for storekeeper and admin', async t => {
    const body = {
        barcode: '7500000000017',
        product: { code: 'NEW', name: 'New', control_type: 'stock' },
    };
    const operator = await setup(t, 'operator');
    // an invalid body too: the role is checked before validation
    for (const b of [body, {}]) {
        const r = await operator.request('/api/products/with-code', 'POST', b);
        assert.equal(r.status, 403);
    }
    assert.equal(operator.queries.length, 0);

    for (const role of ['storekeeper', 'admin']) {
        const e = await setup(t, role);
        const r = await e.request('/api/products/with-code', 'POST', body);
        assert.equal(r.status, 201, role);
    }
});
