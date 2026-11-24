const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const createRequestsRoutes = require('../requests');
const { readRequest } = createRequestsRoutes;
const { Rejection } = require('../util');
const { skip, createDb } = require('../scripts/testDb.cjs');

// Material requests from the shop floor to the storeroom. What matters: who sees what, who can change which
// status, that a request doesn't move stock, and that a phone that resends doesn't fill the queue.

const REJECTS = (fn, re, status = 400) => assert.throws(fn, e => e instanceof Rejection && e.status === status && re.test(e.message));

test('readRequest: clean items and note, no duplicates or absurd quantities', () => {
    assert.deepEqual(readRequest({ items: [{ product_id: '3', quantity: '2' }, { product_id: 4, quantity: 0.5 }], note: '  for the welder ' }),
        { items: [{ product_id: 3, quantity: 2 }, { product_id: 4, quantity: 0.5 }], note: 'for the welder' });
    assert.equal(readRequest({ items: [{ product_id: 1, quantity: 1 }], note: '   ' }).note, null);
    REJECTS(() => readRequest(null), /at least one product/);
    REJECTS(() => readRequest({ items: [] }), /at least one product/);
    REJECTS(() => readRequest({ items: Array.from({ length: 21 }, (_, i) => ({ product_id: i + 1, quantity: 1 })) }), /up to 20/);
    REJECTS(() => readRequest({ items: [{ product_id: 1, quantity: 1 }, { product_id: 1, quantity: 2 }] }), /only once/);
    for (const quantity of [0, -1, 'x', null, 1e9, 0.0001, Infinity]) {
        REJECTS(() => readRequest({ items: [{ product_id: 1, quantity }] }), /[Qq]uantity/);
    }
    REJECTS(() => readRequest({ items: [{ product_id: 'x', quantity: 1 }] }), /product/);
    REJECTS(() => readRequest({ items: [{ product_id: 1, quantity: 1 }], note: 5 }), /note/);
    REJECTS(() => readRequest({ items: [{ product_id: 1, quantity: 1 }], note: 'x'.repeat(301) }), /300/);
});

let testDb, pool, server, url, me;
const users = {};

before(async () => {
    if (skip) return;
    testDb = await createDb('requests');
    pool = testDb.pool;
    for (const [key, role] of [['op1', 'operator'], ['op2', 'operator'], ['sk', 'storekeeper'], ['adm', 'admin']]) {
        const { rows: [u] } = await pool.query(
            `INSERT INTO users (name, username, role) VALUES ($1::text, $1::text, $2) RETURNING id, name, role`, [`test-${key}`, role]);
        users[key] = u;
    }
    for (let i = 1; i <= 5; i++) await pool.query(`INSERT INTO products (code, name, quantity, location) VALUES ($1, $2, 10, 'DRAWER')`, [`P-${i}`, `Test product ${i}`]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = me; next(); });
    app.use('/api/requests', createRequestsRoutes(pool));
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    url = `http://127.0.0.1:${server.address().port}/api/requests`;
}, { timeout: 120_000 });

after(async () => {
    if (skip) return;
    await new Promise(r => server.close(r));
    await testDb.close();
});

const as = key => { me = users[key]; };
const call = async (path, method = 'GET', body) => {
    const r = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const product = async n => (await pool.query('SELECT id, quantity::text FROM products ORDER BY id OFFSET $1 LIMIT 1', [n])).rows[0];

test('requesting: it belongs to whoever holds the session, with its items; it does not move stock', { skip }, async () => {
    const p = await product(0);
    as('op1');
    const movements = async () => (await pool.query('SELECT count(*)::int AS n FROM movements')).rows[0].n;
    const before = await movements();
    const r = await call('', 'POST', { items: [{ product_id: p.id, quantity: 2 }], note: 'urgent', requester_id: users.op2.id });
    assert.equal(r.status, 201);
    const { rows: [s] } = await pool.query('SELECT requester_id, status, note FROM material_requests WHERE id = $1', [r.body.id]);
    assert.equal(s.requester_id, users.op1.id, 'the requester comes from the session, not the body');
    assert.equal(s.status, 'pending');
    assert.equal((await product(0)).quantity, p.quantity, 'a request does not touch stock');
    assert.equal(await movements(), before, 'not even a movement');
});

test('requesting: product that does not exist, bad body, and no prices in the response', { skip }, async () => {
    as('op1');
    assert.equal((await call('', 'POST', { items: [{ product_id: 2147483647, quantity: 1 }] })).status, 404);
    assert.equal((await call('', 'POST', { items: [] })).status, 400);
    const list = await call('');
    assert.equal(list.status, 200);
    assert.ok(list.body.requests.length >= 1);
    const text = JSON.stringify(list.body);
    assert.ok(!/price|amount/i.test(text), 'an operator does not see prices');
});

test('viewing: an operator sees only their own; storekeeper and admin see all, and the pending ones are counted', { skip }, async () => {
    const p = await product(1);
    as('op2');
    await call('', 'POST', { items: [{ product_id: p.id, quantity: 1 }] });
    assert.ok((await call('')).body.requests.every(s => s.requester.id === users.op2.id));
    as('sk');
    const all = (await call('')).body;
    assert.ok(new Set(all.requests.map(s => s.requester.id)).size >= 2);
    assert.equal(all.open, all.requests.filter(s => s.status === 'pending').length);
    assert.ok(all.requests[0].items[0].location !== undefined, 'the storekeeper sees where each piece is');
    as('adm');
    assert.equal((await call('')).status, 200);
});

test('statuses: the storekeeper marks it ready and delivered; an operator only cancels their own, and someone else\'s does not even exist', { skip }, async () => {
    as('op1');
    const { body: { id } } = await call('', 'POST', { items: [{ product_id: (await product(2)).id, quantity: 3 }] });

    as('op2');
    assert.equal((await call(`/${id}`, 'PATCH', { status: 'cancelled' })).status, 404, 'not theirs: 404');
    as('op1');
    assert.equal((await call(`/${id}`, 'PATCH', { status: 'ready' })).status, 403, 'an operator does not mark it ready');
    assert.equal((await call(`/${id}`, 'PATCH', { status: 'delivered' })).status, 403);

    as('sk');
    assert.equal((await call(`/${id}`, 'PATCH', { status: 'ready' })).status, 200);
    assert.equal((await call(`/${id}`, 'PATCH', { status: 'ready' })).status, 409, 'already ready');
    assert.equal((await call(`/${id}`, 'PATCH', { status: 'pending' })).status, 403, 'no going back');
    assert.equal((await call(`/${id}`, 'PATCH', { status: 'junk' })).status, 403);
    const { rows: [s] } = await pool.query('SELECT status, handled_by FROM material_requests WHERE id = $1', [id]);
    assert.equal(s.status, 'ready');
    assert.equal(s.handled_by, users.sk.id);
    assert.equal((await call(`/${id}`, 'PATCH', { status: 'delivered' })).status, 200);
    assert.equal((await call(`/${id}`, 'PATCH', { status: 'cancelled' })).status, 409, 'a delivered one is not cancelled');

    as('op1');
    const { body: { id: other } } = await call('', 'POST', { items: [{ product_id: (await product(2)).id, quantity: 1 }] });
    assert.equal((await call(`/${other}`, 'PATCH', { status: 'cancelled' })).status, 200, 'their own they can cancel');
    const { rows: [c] } = await pool.query('SELECT handled_by FROM material_requests WHERE id = $1', [other]);
    assert.equal(c.handled_by, null, 'cancelling your own does not count as handling it');
    assert.equal((await call('/x', 'PATCH', { status: 'cancelled' })).status, 400);
});

test('limit: more than 10 open requests per person is rejected, and two simultaneous ones do not skip it', { skip }, async () => {
    as('adm');
    const p = (await product(3)).id;
    const send = () => call('', 'POST', { items: [{ product_id: p, quantity: 1 }] });
    const results = await Promise.all(Array.from({ length: 14 }, send));
    assert.equal(results.filter(r => r.status === 201).length, 10);
    assert.equal(results.filter(r => r.status === 409).length, 4);
});
