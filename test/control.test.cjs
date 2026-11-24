const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// PATCH /api/products/:id/control: switch a product to "tracks stock" or "does not".

async function setup(t, product) {
    const updates = [];
    const pool = {
        async query(sql) {
            if (/FROM products WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: product ? [product] : [] };
            if (/UPDATE products SET control_type/.test(sql)) {
                updates.push(sql);
                const toStock = /SET control_type = 'stock'/.test(sql);
                return { rows: [{ id: product.id, control_type: toStock ? 'stock' : 'no_balance', count_pending: toStock ? true : product.count_pending,
                    minimum: toStock ? 5 : null, target_level: null }] };
            }
            return { rows: [] };
        },
        async connect() { return { query: this.query.bind(this), release() {} }; },
    };
    const identity = {
        requireSession: () => (req, res, next) => {
            const r = req.get('x-role') ?? 'admin';
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

const DISC = { id: 5, control_type: 'no_balance', count_pending: false };

test('control: admin only, no session 401, operator and storekeeper 403, and nothing is written', async t => {
    const e = await setup(t, DISC);
    assert.equal((await e.patch('/5/control', { control_type: 'stock' }, { 'x-role': 'none' })).status, 401);
    for (const role of ['operator', 'storekeeper']) assert.equal((await e.patch('/5/control', { control_type: 'stock' }, { 'x-role': role })).status, 403, role);
    assert.equal(e.updates.length, 0);
});

test('control: to stock it enters UNCOUNTED (never an invented balance)', async t => {
    const e = await setup(t, DISC);
    const r = await e.patch('/5/control', { control_type: 'stock' });
    assert.equal(r.status, 200); assert.equal(r.body.control_type, 'stock'); assert.equal(r.body.count_pending, true);
    assert.match(e.updates[0], /count_pending = true/, 'the SQL sets it, it does not come from the body');
    assert.ok(!/quantity/.test(e.updates[0]), 'the stored balance is not touched');
});

test('control: to no_balance it loses minimum and target; the same value changes nothing', async t => {
    const e = await setup(t, { id: 5, control_type: 'stock', count_pending: false });
    const r = await e.patch('/5/control', { control_type: 'no_balance' });
    assert.equal(r.status, 200); assert.equal(r.body.minimum, null); assert.equal(r.body.target_level, null);
    assert.match(e.updates[0], /minimum = NULL, target_level = NULL/);
    const same = await setup(t, DISC);
    const s = await same.patch('/5/control', { control_type: 'no_balance' });
    assert.equal(s.body.unchanged, true); assert.equal(same.updates.length, 0);
});

test('control: invalid values 400, unit 409, missing 404', async t => {
    const e = await setup(t, DISC);
    for (const body of [{}, { control_type: 'unit' }, { control_type: 'weird' }, { control_type: ['stock'] }]) {
        assert.equal((await e.patch('/5/control', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await e.patch('/x/control', { control_type: 'stock' })).status, 400);
    const u = await setup(t, { id: 5, control_type: 'unit', count_pending: false });
    assert.equal((await u.patch('/5/control', { control_type: 'stock' })).status, 409);
    const none = await setup(t, null);
    assert.equal((await none.patch('/9/control', { control_type: 'stock' })).status, 404);
    assert.equal(e.updates.length + u.updates.length, 0);
});
