const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createApp } = require('../index');
const { editProduct, readChanges } = require('../productEdit');
const { Rejection } = require('../util');
const { skip, createDb } = require('../scripts/testDb.cjs');

// Editing a product's details: name, category, location, brand, group, price and, admin only, the code.
// What matters: quantity, unit and control cannot be touched here, the code is admin-only, and every change
// is logged with who made it and from what to what.

const ERROR = (fn, message, status = 400) => assert.throws(fn, e => e instanceof Rejection && e.status === status && message.test(e.message));

test('readChanges: cleans, normalizes and only returns what came', () => {
    assert.deepEqual(readChanges({ name: '  Drill bit 1/4  ', location: '', brand: ' DeWalt ', group_name: null, price: '12.5' }, { isAdmin: false }),
        { name: 'Drill bit 1/4', location: null, brand: 'DeWalt', group_name: null, price: '12.50' });
    assert.deepEqual(readChanges({ price: null }, { isAdmin: false }), { price: null }, 'clearing the price is valid: no price on record');
    assert.deepEqual(readChanges({ code: ' brc-001 ', category_id: '7' }, { isAdmin: true }), { code: 'BRC-001', category_id: 7 });
});

test('readChanges: quantity, unit, control and levels are not edited here, and it says so', () => {
    for (const key of ['quantity', 'unit', 'control_type', 'minimum', 'target_level', 'count_pending', 'id', 'user_id']) {
        ERROR(() => readChanges({ name: 'X', [key]: 1 }, { isAdmin: true }), new RegExp(key));
    }
    ERROR(() => readChanges({}, { isAdmin: true }), /at least one field/);
    ERROR(() => readChanges(null, { isAdmin: true }), /at least one field/);
    ERROR(() => readChanges([1], { isAdmin: true }), /at least one field/);
});

test('readChanges: the code is admin-only; name and code are not left empty; the category is not removed', () => {
    ERROR(() => readChanges({ code: 'X' }, { isAdmin: false }), /admin/, 403);
    ERROR(() => readChanges({ code: '  ' }, { isAdmin: true }), /code/);
    ERROR(() => readChanges({ name: '' }, { isAdmin: false }), /name/);
    ERROR(() => readChanges({ name: 5 }, { isAdmin: false }), /name/);
    ERROR(() => readChanges({ category_id: null }, { isAdmin: false }), /category/);
    ERROR(() => readChanges({ category_id: 'x' }, { isAdmin: false }), /category/);
});

test('readChanges: length caps, and price with cents only: no thousandths, no negatives', () => {
    ERROR(() => readChanges({ name: 'x'.repeat(201) }, { isAdmin: false }), /200/);
    ERROR(() => readChanges({ brand: 'x'.repeat(61) }, { isAdmin: false }), /60/);
    ERROR(() => readChanges({ group_name: 'x'.repeat(41) }, { isAdmin: false }), /40/);
    ERROR(() => readChanges({ location: 'x'.repeat(101) }, { isAdmin: false }), /100/);
    ERROR(() => readChanges({ code: 'x'.repeat(51) }, { isAdmin: true }), /50/);
    ERROR(() => readChanges({ price: '0.258' }, { isAdmin: false }), /2 decimals/);
    ERROR(() => readChanges({ price: -1 }, { isAdmin: false }), /price/);
    ERROR(() => readChanges({ price: 'abc' }, { isAdmin: false }), /price/);
    ERROR(() => readChanges({ brand: 5 }, { isAdmin: false }), /brand/);
});

test('the route: operator and technician bounce without querying; storekeeper and admin get in', async t => {
    for (const [role, expected] of [['operator', 403], ['technician', 403], ['storekeeper', 200], ['admin', 200]]) {
        const queries = [];
        const pool = {
            async query(sql) {
                queries.push(sql);
                if (/FROM sessions s\s+JOIN users u/.test(sql)) return { rows: [{ id: 7, name: 'Whoever', role, must_change_password: false }] };
                if (/FROM products p LEFT JOIN categories c ON c\.id = p\.category_id WHERE p\.id = \$1 FOR UPDATE/.test(sql)) {
                    return { rows: [{ id: 1, code: 'A', name: 'Same', category_id: 2, category: 'X', location: null, brand: null, group_name: null, price: null }] };
                }
                if (/WHERE p\.id = \$1/.test(sql)) return { rows: [{ id: 1, code: 'A', name: 'Same' }] };
                return { rows: [], rowCount: 0 };
            },
            async connect() { return { query: (sql, a) => this.query(sql, a), release() {} }; },
        };
        const server = createApp(pool).listen(0, '127.0.0.1');
        await new Promise(r => server.once('listening', r));
        t.after(() => new Promise(r => server.close(r)));
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/products/1`, {
            method: 'PATCH', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Same' }),
        });
        assert.equal(r.status, expected, role);
        if (expected === 403) assert.equal(queries.filter(s => !/FROM sessions s\s+JOIN users u/.test(s)).length, 0, `${role} does not reach the database`);
    }
});

// ---------- against real PostgreSQL ----------

let db, pool, server, url, role = 'admin';

before(async () => {
    if (skip) return;
    db = await createDb('product_edit');
    pool = db.pool;
    await pool.query(`INSERT INTO users (id, name, username, role) VALUES (1, 'Tester', 'tester', 'admin')`);
    const { rows: [cat] } = await pool.query('SELECT id FROM categories ORDER BY id LIMIT 1');
    await pool.query(
        `INSERT INTO products (code, name, quantity, unit, category_id) VALUES ('PE-A', 'Test drill bit', 5, 'piece', $1), ('PE-B', 'Test saw blade', 3, 'piece', $1)`, [cat.id]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1, name: 'Test', role }; next(); });
    app.patch('/api/products/:id', editProduct(pool, async (q, id) => (await q.query(
        `SELECT p.id, p.code, p.name, p.quantity::text AS quantity, p.unit, p.location, p.brand, p.group_name, p.price::text AS price, p.category_id, c.name AS category
           FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = $1`, [id])).rows[0]));
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    url = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120_000 });

after(async () => {
    if (skip) return;
    await new Promise(r => server.close(r));
    await db.close();
});

const edit = async (id, body) => {
    const r = await fetch(`${url}/api/products/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const q = (sql, args) => pool.query(sql, args).then(r => r.rows);
const two = async () => (await q(`SELECT id, code, name, quantity::text AS quantity, unit, category_id FROM products ORDER BY id LIMIT 2`));
const auditLog = id => q('SELECT field, before, after, user_id FROM product_changes WHERE product_id = $1 ORDER BY id', [id]);

test('edit: name, location, brand, group and price change and leave their trace with who; the balance is untouched', { skip }, async () => {
    const [p] = await two();
    role = 'storekeeper';
    const r = await edit(p.id, { name: 'Corrected name', location: 'SHELF 9', brand: 'Brand X', group_name: 'GRP-1', price: '45.5' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.changed.sort(), ['brand', 'group_name', 'location', 'name', 'price']);
    assert.equal(r.body.product.name, 'Corrected name');
    assert.equal(r.body.product.price, '45.50');
    assert.equal(r.body.product.quantity, p.quantity, 'stock did not change');
    assert.equal(r.body.product.unit, p.unit);
    const b = await auditLog(p.id);
    assert.deepEqual(b.find(x => x.field === 'name'), { field: 'name', before: p.name, after: 'Corrected name', user_id: 1 });
    assert.equal(b.find(x => x.field === 'price').after, '45.50');
});

test('edit: sending the same is not a change and does not dirty the log; clearing a field leaves it null', { skip }, async () => {
    const [p] = await two();
    role = 'storekeeper';
    await edit(p.id, { brand: 'Brand X' });
    const before = (await auditLog(p.id)).length;
    const same = await edit(p.id, { brand: 'Brand X', name: (await q('SELECT name FROM products WHERE id = $1', [p.id]))[0].name });
    assert.equal(same.status, 200);
    assert.equal(same.body.unchanged, true);
    assert.equal((await auditLog(p.id)).length, before);

    await edit(p.id, { price: '10' });
    const clear = await edit(p.id, { brand: '', price: null });
    assert.equal(clear.body.product.brand, null);
    assert.equal(clear.body.product.price, null);
    assert.deepEqual((await auditLog(p.id)).filter(x => x.field === 'price').at(-1), { field: 'price', before: '10.00', after: null, user_id: 1 });
});

test('edit: changing category stores the NAME before and after; one that does not exist is 400', { skip }, async () => {
    const [p] = await two();
    role = 'storekeeper';
    const [other] = await q('SELECT id, name FROM categories WHERE id <> $1 ORDER BY id LIMIT 1', [p.category_id ?? 0]);
    const before = (await q('SELECT name FROM categories WHERE id = $1', [p.category_id]))[0]?.name ?? null;
    const r = await edit(p.id, { category_id: other.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.product.category, other.name);
    assert.deepEqual((await auditLog(p.id)).find(x => x.field === 'category'), { field: 'category', before, after: other.name, user_id: 1 });
    assert.equal((await edit(p.id, { category_id: 999999 })).status, 400);
    assert.equal((await q('SELECT category_id FROM products WHERE id = $1', [p.id]))[0].category_id, other.id, 'nothing changed');
});

test("edit: the code is admin-only, unique, and cannot be another product's barcode", { skip }, async () => {
    const [a, b] = await two();
    role = 'storekeeper';
    assert.equal((await edit(a.id, { code: 'NEW-1' })).status, 403);
    assert.equal((await q('SELECT code FROM products WHERE id = $1', [a.id]))[0].code, a.code);

    role = 'admin';
    const ok = await edit(a.id, { code: ' new-1 ' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.product.code, 'NEW-1');
    assert.deepEqual((await auditLog(a.id)).find(x => x.field === 'code'), { field: 'code', before: a.code, after: 'NEW-1', user_id: 1 });

    const repeated = await edit(b.id, { code: 'NEW-1' });
    assert.equal(repeated.status, 409);
    await q(`INSERT INTO product_codes (product_id, code, type) VALUES ($1, '7501234567890', 'barcode')`, [a.id]);
    const barcode = await edit(b.id, { code: '7501234567890' });
    assert.equal(barcode.status, 409);
    assert.match(barcode.body.error, /already linked/);
    assert.equal((await q('SELECT code FROM products WHERE id = $1', [b.id]))[0].code, b.code, 'nothing changed');
});

test('edit: quantity, unit and control are rejected saying which, and a missing product is 404', { skip }, async () => {
    const [p] = await two();
    role = 'admin';
    for (const key of ['quantity', 'unit', 'control_type']) {
        const r = await edit(p.id, { name: 'x', [key]: 5 });
        assert.equal(r.status, 400, key);
        assert.match(r.body.error, new RegExp(key));
    }
    const intact = (await two())[0];
    assert.equal(intact.quantity, p.quantity);
    assert.equal(intact.unit, p.unit);
    assert.equal((await edit(999999, { name: 'x' })).status, 404);
    assert.equal((await edit('abc', { name: 'x' })).status, 400);
});
