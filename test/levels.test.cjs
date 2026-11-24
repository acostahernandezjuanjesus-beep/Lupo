const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// PATCH /api/products/:id/levels: minimum and target level of a product.

async function setup(t, product) {
    const updates = [];
    const pool = {
        async query(sql, args = []) {
            if (/FROM products WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: product ? [product] : [] };
            if (/UPDATE products SET minimum/.test(sql)) {
                updates.push(args);
                return { rows: [{ id: args[2], minimum: args[0] === null ? null : Number(args[0]), target_level: args[1] === null ? null : Number(args[1]) }] };
            }
            return { rows: [] };
        },
        async connect() { return { query: this.query.bind(this), release() {} }; },
    };
    const identity = {
        requireSession: () => (req, res, next) => {
            const r = req.get('x-role') ?? 'storekeeper';
            if (r === 'none') return res.status(401).json({ error: 'no session' });
            req.user = { id: 7, role: r }; next();
        },
        requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'no permission' }),
    };
    const server = createApp(pool, identity).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}/api/products`;
    const patch = async (route, body, headers = {}) => {
        const r = await fetch(base + route, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { patch, updates };
}

const DISC = { id: 5, unit: 'piece', control_type: 'stock', minimum: '20.000', target_level: null };

test('levels: permissions, no session 401, operator 403, and nothing is written', async t => {
    const e = await setup(t, DISC);
    assert.equal((await e.patch('/5/levels', { minimum: 10 }, { 'x-role': 'none' })).status, 401);
    assert.equal((await e.patch('/5/levels', { minimum: 10 }, { 'x-role': 'operator' })).status, 403);
    assert.equal(e.updates.length, 0);
});

test('levels: sets the target against the existing minimum, and null clears it (it is not zero)', async t => {
    const e = await setup(t, DISC);
    let r = await e.patch('/5/levels', { target_level: 100 });
    assert.equal(r.status, 200); assert.equal(r.body.minimum, 20); assert.equal(r.body.target_level, 100);
    assert.deepEqual(e.updates[0], ['20.000', '100', 5], 'the untouched minimum is sent back as is');
    r = await e.patch('/5/levels', { target_level: null });
    assert.equal(r.status, 200); assert.equal(r.body.target_level, null, 'back to "nobody has defined it"');
    r = await e.patch('/5/levels', { target_level: '' });
    assert.equal(r.body.target_level, null);
});

test('levels: the target has to exceed the minimum, and with no minimum there is no target', async t => {
    const e = await setup(t, DISC);
    for (const [body, why] of [[{ target_level: 20 }, 'equal to the minimum'], [{ target_level: 10 }, 'below the minimum'],
        [{ minimum: 150, target_level: 100 }, 'the new minimum passes the target']]) {
        const r = await e.patch('/5/levels', body);
        assert.equal(r.status, 400, why);
    }
    const noMin = await setup(t, { ...DISC, minimum: null });
    assert.match((await noMin.patch('/5/levels', { target_level: 100 })).body.error, /minimum/);
    assert.equal(e.updates.length + noMin.updates.length, 0, 'no rejection wrote anything');
});

test('levels: malformed values are 400; a fraction of a kilo is not; no fields is', async t => {
    const e = await setup(t, DISC);
    for (const body of [{}, { minimum: 'lots' }, { minimum: -1 }, { minimum: 1.5 }, { minimum: 1.2345 }, { minimum: true }, { target_level: [] }, { minimum: 10000000000 }]) {
        assert.equal((await e.patch('/5/levels', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await e.patch('/x/levels', { minimum: 1 })).status, 400);
    assert.equal(e.updates.length, 0);
    const kg = await setup(t, { ...DISC, unit: 'kg', minimum: null });
    assert.equal((await kg.patch('/5/levels', { minimum: 2.5 })).status, 200, 'a kilo does allow fractions');
});

test('levels: a no_balance product has no levels (409), and a missing product is 404', async t => {
    const gas = await setup(t, { ...DISC, control_type: 'no_balance' });
    const r = await gas.patch('/5/levels', { minimum: 10 });
    assert.equal(r.status, 409); assert.equal(r.body.error_code, 'no_balance');
    assert.equal(gas.updates.length, 0);
    const none = await setup(t, null);
    assert.equal((await none.patch('/99/levels', { minimum: 10 })).status, 404);
});
