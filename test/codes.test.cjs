const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// The fake pool keeps codes in memory instead of returning canned rows: most of what is tested here
// depends on prior state (linking a code twice means something different if another product owns it).
async function setup(t, role = 'storekeeper') {
    const products = [
        { id: 1, code: 'SOLD-MICRO-70S6-035', name: 'Microwire 70S-6' },
        { id: 2, code: 'ABR-DISCO-CORTE-4_5-0_045', name: 'Cutting disc 4.5"' },
    ];
    const codes = [{ id: 10, product_id: 1, code: '7501234567890', format: 'ean_13' }];
    let nextId = 11;
    let nextProduct = 3;
    // BEGIN snapshots the state and ROLLBACK restores it, so a test can assert a failed create left no orphan product.
    let snapshot = null;
    // Simulates someone else linking a code between the check and this create's INSERT.
    const race = { code: null };
    const released = { n: 0 };
    const sqls = [];

    const pool = {
        async query(sql, args = []) {
            sqls.push(sql.trim().split(/\s+/)[0]);
            if (/^\s*BEGIN/.test(sql)) { snapshot = { products: products.map(p => ({ ...p })), codes: codes.map(l => ({ ...l })) }; return { rows: [] }; }
            if (/^\s*ROLLBACK/.test(sql)) {
                if (snapshot) { products.splice(0, products.length, ...snapshot.products); codes.splice(0, codes.length, ...snapshot.codes); }
                snapshot = null;
                return { rows: [] };
            }
            if (/^\s*COMMIT/.test(sql)) { snapshot = null; return { rows: [] }; }
            // Owner of a code: linked, or equal to an internal code.
            if (/UNION ALL/.test(sql)) {
                const wanted = args[0];
                const l = codes.find(x => x.code === wanted);
                if (l) {
                    const p = products.find(x => x.id === l.product_id);
                    return { rows: [{ id: l.id, product_id: p.id, product_code: p.code, name: p.name }] };
                }
                const p = products.find(x => x.code.toUpperCase() === String(wanted).toUpperCase());
                return { rows: p ? [{ id: null, product_id: p.id, product_code: p.code, name: p.name }] : [] };
            }
            if (/INSERT INTO products/.test(sql)) {
                const [code, name] = args;
                if (products.some(p => p.code === code)) throw Object.assign(new Error('duplicate'), { code: '23505' });
                const row = { id: nextProduct++, code, name, args, sql };
                products.push(row);
                // count_pending comes from the SQL, not a parameter: if someone made it one, the test must notice.
                const uncounted = /,\s*true\)\s*RETURNING/.test(sql);
                return { rows: [{ id: row.id, code, name, unit: args[4], control_type: args[6], minimum: args[7] === null ? null : String(args[7]), count_pending: uncounted }] };
            }
            // Create-with-code has no ON CONFLICT: the clash arrives as 23505.
            if (/INSERT INTO product_codes/.test(sql) && !/ON CONFLICT/.test(sql)) {
                const [productId, code, format, createdBy] = args;
                if (race.code === code) {
                    codes.push({ id: nextId++, product_id: 1, code, format: null });
                    // The other person's link is already done: this create's ROLLBACK must not undo it.
                    if (snapshot) snapshot.codes.push(codes[codes.length - 1]);
                    race.code = null;
                }
                if (codes.some(l => l.code === code)) throw Object.assign(new Error('duplicate'), { code: '23505' });
                const row = { id: nextId++, product_id: productId, code, format, created_by: createdBy };
                codes.push(row);
                return { rows: [{ id: row.id, code, format }] };
            }
            // Resolve a code: by link or by internal code.
            if (/FROM product_codes WHERE upper\(code\) = upper\(\$1\)\)/.test(sql)) {
                const wanted = args[0];
                // Case-insensitive: a supplier number typed "z-20120" is the same as "Z-20120".
                const byLink = codes.find(l => String(l.code).toUpperCase() === String(wanted).toUpperCase());
                const p = products.find(x =>
                    (byLink && x.id === byLink.product_id) ||
                    x.code.toUpperCase() === String(wanted).toUpperCase());
                return { rows: p ? [{ ...p, quantity: 12, unit: 'piece' }] : [] };
            }
            if (/INSERT INTO product_codes/.test(sql)) {
                const [productId, code, format] = args;
                if (codes.some(l => l.code === code)) return { rows: [] };   // ON CONFLICT DO NOTHING
                const row = { id: nextId++, product_id: productId, code, format };
                codes.push(row);
                return { rows: [row] };
            }
            if (/JOIN products p ON p\.id = c\.product_id/.test(sql)) {
                const l = codes.find(x => x.code === args[0]);
                if (!l) return { rows: [] };
                const p = products.find(x => x.id === l.product_id);
                return { rows: [{ id: l.id, product_id: l.product_id, product_code: p.code, name: p.name }] };
            }
            if (/DELETE FROM product_codes/.test(sql)) {
                const [codeId, productId] = args;
                const i = codes.findIndex(l => l.id === codeId && l.product_id === productId);
                if (i === -1) return { rowCount: 0, rows: [] };
                codes.splice(i, 1);
                return { rowCount: 1, rows: [] };
            }
            return { rows: [] };
        },
        async connect() { return { query: this.query.bind(this), release() { released.n++; } }; },
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

    async function request(route, options) {
        const r = await fetch(url + route, options);
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    }
    const link = (id, body) => request(`/api/products/${id}/codes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    const createWithCode = body => request('/api/products/with-code', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    return { request, link, codes, products, race, createWithCode, released, sqls };
}

test('resolves the manufacturer code and the internal one', async t => {
    const e = await setup(t);

    const barcode = await e.request('/api/products/by-code?code=7501234567890');
    assert.equal(barcode.status, 200);
    assert.equal(barcode.body.code, 'SOLD-MICRO-70S6-035');

    // The drawer label carries the internal code; scanning it is the same gesture, so it resolves the same.
    const internal = await e.request('/api/products/by-code?code=abr-disco-corte-4_5-0_045');
    assert.equal(internal.status, 200);
    assert.equal(internal.body.id, 2);
});

test('unknown code: 404 that returns the code so it can be linked', async t => {
    const e = await setup(t);
    const r = await e.request('/api/products/by-code?code=0000000000000');
    assert.equal(r.status, 404);
    assert.equal(r.body.error_code, 'unknown_code');
    assert.equal(r.body.code, '0000000000000');
});

test('empty or missing code: 400 before querying', async t => {
    const e = await setup(t);
    assert.equal((await e.request('/api/products/by-code')).status, 400);
    assert.equal((await e.request('/api/products/by-code?code=%20%20')).status, 400);
});

test('link: 201 when new, 200 if it was already on the same product', async t => {
    const e = await setup(t);

    const created = await e.link(2, { code: '7509876543210', format: 'ean_13' });
    assert.equal(created.status, 201);
    assert.equal(created.body.product_id, 2);

    // Scanning the same spool twice is not a mistake.
    const again = await e.link(2, { code: '7509876543210' });
    assert.equal(again.status, 200);
    assert.equal(again.body.already_linked, true);
    assert.equal(e.codes.filter(l => l.code === '7509876543210').length, 1);
});

test('linking a code that belongs to another product: 409 saying whose', async t => {
    const e = await setup(t);
    const r = await e.link(2, { code: '7501234567890' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error_code, 'code_taken');
    assert.equal(r.body.product.code, 'SOLD-MICRO-70S6-035');
});

test('an operator does not link codes', async t => {
    const e = await setup(t, 'operator');
    const r = await e.link(1, { code: '7511111111111' });
    assert.equal(r.status, 403);
    assert.equal(e.codes.length, 1);
});

test("unlinking only reaches the product's own codes", async t => {
    const e = await setup(t);

    // Link 10 belongs to product 1; asking for it through product 2's route does not delete it.
    const foreign = await e.request('/api/products/2/codes/10', { method: 'DELETE' });
    assert.equal(foreign.status, 404);
    assert.equal(e.codes.length, 1);

    const own = await e.request('/api/products/1/codes/10', { method: 'DELETE' });
    assert.equal(own.status, 204);
    assert.equal(e.codes.length, 0);
});

// Create a product from a scanned code

/** How many times a statement (BEGIN, COMMIT, ROLLBACK...) ran. */
const times = (e, statement) => e.sqls.filter(x => x === statement).length;

const NEW_PRODUCT = { code: 'ESC-SYM-1400', name: 'Symcode MJ-1400 scanner', unit: 'piece', category_id: 1, control_type: 'stock' };

test('create with code: enters uncounted and the next scan finds it', async t => {
    const e = await setup(t);
    // Even if the body carries quantity or count_pending the server ignores them: holding one says nothing about how many there are.
    const r = await e.createWithCode({
        barcode: '(MJ-1400CA)-1-1USB', format: 'code_128',
        // The author comes from the session: whatever the body says is ignored.
        user_id: 999, created_by: 999,
        product: { ...NEW_PRODUCT, quantity: 99, count_pending: false, created_by: 999 },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.product.code, 'ESC-SYM-1400');
    assert.equal(r.body.product.count_pending, true);
    assert.equal(r.body.code.code, '(MJ-1400CA)-1-1USB');
    assert.equal(e.codes.find(l => l.code === '(MJ-1400CA)-1-1USB').created_by, 7);
    assert.equal(times(e, 'COMMIT'), 1);
    assert.equal(times(e, 'ROLLBACK'), 0);
    assert.equal(e.released.n, 1);

    const inserted = e.products.find(p => p.code === 'ESC-SYM-1400');
    assert.match(inserted.sql, /VALUES \(\$1, \$2, 0, .*, true\)/s);
    assert.equal(inserted.args.includes(99), false);

    const scan = await e.request('/api/products/by-code?code=' + encodeURIComponent('(MJ-1400CA)-1-1USB'));
    assert.equal(scan.status, 200);
    assert.equal(scan.body.code, 'ESC-SYM-1400');
});

test('create with a code that already has an owner: 409 naming it, and nothing is created', async t => {
    const e = await setup(t);
    const linked = await e.createWithCode({ barcode: '7501234567890', product: NEW_PRODUCT });
    assert.equal(linked.status, 409);
    assert.equal(linked.body.error_code, 'code_taken');
    assert.equal(linked.body.product.code, 'SOLD-MICRO-70S6-035');

    // Equal to an INTERNAL code: linking it to another product would make a scan find two products and return either.
    const internal = await e.createWithCode({ barcode: 'abr-disco-corte-4_5-0_045', product: NEW_PRODUCT });
    assert.equal(internal.status, 409);
    assert.equal(internal.body.error_code, 'code_taken');
    assert.equal(internal.body.product.id, 2);

    assert.equal(e.products.length, 2);
    // Each 409 rolls back its transaction and returns the connection to the pool.
    assert.equal(times(e, 'ROLLBACK'), 2);
    assert.equal(times(e, 'COMMIT'), 0);
    assert.equal(e.released.n, 2);
});

test('create with a repeated internal code: 409 and the scanned code stays free', async t => {
    const e = await setup(t);
    const r = await e.createWithCode({ barcode: '7500000000017', product: { ...NEW_PRODUCT, code: 'SOLD-MICRO-70S6-035' } });
    assert.equal(r.status, 409);
    assert.equal(r.body.error_code, 'duplicate_code');
    assert.equal(e.codes.some(l => l.code === '7500000000017'), false);
    assert.equal(e.products.length, 2);
    assert.equal(times(e, 'ROLLBACK'), 1);
    assert.equal(e.released.n, 1);
});

test('create with code: if someone else links it mid-create, the product is rolled back and the clash is named', async t => {
    const e = await setup(t);
    e.race.code = '7500000000024';
    const r = await e.createWithCode({ barcode: '7500000000024', product: NEW_PRODUCT });
    assert.equal(r.status, 409);
    assert.equal(r.body.error_code, 'code_taken');
    assert.equal(r.body.product.code, 'SOLD-MICRO-70S6-035');
    // No orphan product: the next scan must not offer to create it again.
    assert.equal(e.products.some(p => p.code === 'ESC-SYM-1400'), false);
    assert.equal(times(e, 'ROLLBACK'), 1);
    assert.equal(times(e, 'COMMIT'), 0);
    assert.equal(e.released.n, 1);
});

test('create with code: validation before touching the database', async t => {
    const e = await setup(t);
    const cases = [
        [{ product: NEW_PRODUCT }, /barcode is required/],
        [{ barcode: '   ', product: NEW_PRODUCT }, /barcode is required/],
        [{ barcode: 'x'.repeat(201), product: NEW_PRODUCT }, /cannot exceed 200/],
        [{ barcode: '7500000000031' }, /product is required/],
        [{ barcode: '7500000000031', product: [NEW_PRODUCT] }, /product is required/],
        [{ barcode: '7500000000031', product: { ...NEW_PRODUCT, name: '' } }, /code and name are required/],
        // No default: whether it tracks stock is up to whoever creates it.
        [{ barcode: '7500000000031', product: { ...NEW_PRODUCT, control_type: undefined } }, /control_type is required/],
        [{ barcode: '7500000000031', product: { ...NEW_PRODUCT, control_type: 'no_balance', minimum: 3 } }, /without stock tracking cannot have a minimum/],
        [{ barcode: '7500000000031', product: { ...NEW_PRODUCT, minimum: 1.5 } }, /fractions/],
    ];
    for (const [body, message] of cases) {
        const r = await e.createWithCode(body);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
        assert.match(r.body.error, message);
    }
    assert.equal(e.products.length, 2);
    // Not a single query: it is rejected before asking for a connection.
    assert.deepEqual(e.sqls, []);
    assert.equal(e.released.n, 0);
});

test('an operator does not create from a code', async t => {
    const e = await setup(t, 'operator');
    const r = await e.createWithCode({ barcode: '7500000000048', product: NEW_PRODUCT });
    assert.equal(r.status, 403);
    assert.equal(e.products.length, 2);
    assert.equal(e.codes.length, 1);
});

test('link: a code over 200 characters is rejected just like on create', async t => {
    const e = await setup(t);
    const r = await e.link(2, { code: 'x'.repeat(201) });
    assert.equal(r.status, 400);
    assert.equal(e.codes.length, 1);
});

test('link the supplier number: stored UPPERCASE with its type, and another spelling is the same code', async t => {
    const e = await setup(t);
    const a = await e.link(2, { type: 'supplier', code: ' z-20120 ', description: 'DISCO DE DESBASTE' });
    assert.equal(a.status, 201); assert.equal(a.body.code, 'Z-20120');
    assert.equal(e.codes.find(l => l.code === 'Z-20120').format, 'supplier');
    const b = await e.link(2, { type: 'supplier', code: 'Z-20120' });
    assert.equal(b.status, 200); assert.equal(b.body.already_linked, true);
    const c = await e.link(1, { type: 'supplier', code: 'z-20120' });
    assert.equal(c.status, 409, "another product's code is not linked, however it is spelled");
});
test('link: unknown type and long description are 400, and nothing is written', async t => {
    const e = await setup(t);
    const before = e.codes.length;
    assert.equal((await e.link(2, { type: 'weird', code: 'X-1' })).status, 400);
    assert.equal((await e.link(2, { type: 'supplier', code: 'X-1', description: 'x'.repeat(301) })).status, 400);
    assert.equal((await e.link(2, { type: 'supplier', code: 'X-1', description: 5 })).status, 400);
    assert.equal(e.codes.length, before);
});
