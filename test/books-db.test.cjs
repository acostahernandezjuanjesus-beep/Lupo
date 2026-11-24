const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const createBooksRouter = require('../books');
const { xlsx, F, sheetOf } = require('./xlsxFixture.cjs');

// Import a book and UNDO it against a real PostgreSQL: what matters is what is left in the database.
// Needs a disposable server (LUPO_TEST_ADMIN_URL), see scripts/testDb.cjs. Skipped without it.

const { skip, createDb } = require('../scripts/testDb.cjs');

let testDb, pool, server, base, role = 'admin', productId;

before(async () => {
    if (skip) return;
    testDb = await createDb('books');
    pool = testDb.pool;
    await pool.query("INSERT INTO users (id, name, role, username) VALUES (1, 'Test', 'admin', 'tester')");
    productId = (await pool.query("INSERT INTO products (code, name) VALUES ('T-1', 'Test product') RETURNING id")).rows[0].id;
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 1, name: 'Test', role }; next(); });
    app.use('/api/purchases/import', createBooksRouter(pool));
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120_000 });

after(async () => {
    if (skip) return;
    await new Promise(r => server.close(r));
    await testDb.close();
});

const q = (sql, args) => pool.query(sql, args).then(r => r.rows);
const request = async (route, method = 'GET', body) => {
    const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
};

const fileName = month => `Monthly purchases (${month}).xlsx`;
const lines = (month, extra = []) => [
    [F(2026, month, 7), `${month}01`, `LIJA DE PRUEBA ${month} MEDIANA`, 50, 17.22, 861, 861, 998.76, 'AB', 'TEST SUPPLIER', null],
    [null, null, `LIJA DE PRUEBA ${month} FINA`, 50, 15.66, 783],
    [F(2026, month, 8), `${month}02`, `THINNER DE PRUEBA ${month}`, 20, 41.38, 827.6, 827.6, 960.02, 'AB', 'OTHER SUPPLIER', null],
    ...extra,
];
const body = (name, month, extra = [], more = {}) => ({ file: name, content: xlsx([sheetOf('Week', lines(month, extra))]).toString('base64'), ...more });
const importBook = (name, month, extra, more) => request('/api/purchases/import/confirm', 'POST', body(name, month, extra, more));
const MONTH = { 9: 'SEPTIEMBRE26', 10: 'OCTUBRE26', 11: 'NOVIEMBRE26', 12: 'DICIEMBRE26' };

test('import marks each line and each link with its import; the history shows it', { skip }, async () => {
    const r = await importBook(fileName(MONTH[9]), 9, [], { links: [{ description: 'LIJA DE PRUEBA 9 FINA', product_id: productId }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const [imp] = await q('SELECT id, new_count, links_created FROM book_imports ORDER BY id DESC LIMIT 1');
    assert.equal(imp.new_count, 3); assert.equal(imp.links_created, 1, 'the link count is fixed at the end');
    assert.equal((await q('SELECT count(*)::int AS n FROM purchases WHERE import_id = $1', [imp.id]))[0].n, 3);
    assert.equal((await q('SELECT count(*)::int AS n FROM product_aliases WHERE import_id = $1', [imp.id]))[0].n, 1);

    const h = (await request('/api/purchases/import/history')).body[0];
    assert.equal(h.id, imp.id); assert.equal(h.lines, 3); assert.equal(h.amount, '2471.60');
    assert.equal(h.undo_blocked_reason, null); assert.equal(h.undone_at, null);
});

test('undo: deletes its lines, links and the book it created; leaves a trace; admin only; the book can be imported again', { skip }, async () => {
    await importBook(fileName(MONTH[10]), 10, [], { links: [{ description: 'LIJA DE PRUEBA 10 FINA', product_id: productId }] });
    const [imp] = await q('SELECT id, book_id FROM book_imports ORDER BY id DESC LIMIT 1');

    role = 'storekeeper';
    try { assert.equal((await request(`/api/purchases/import/${imp.id}/undo`, 'POST')).status, 403, 'the storekeeper cannot undo'); } finally { role = 'admin'; }
    assert.equal((await q('SELECT count(*)::int AS n FROM purchases WHERE import_id = $1', [imp.id]))[0].n, 3, 'the 403 touched nothing');

    const r = await request(`/api/purchases/import/${imp.id}/undo`, 'POST');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.lines, r.body.links, r.body.book_deleted, r.body.amount], [3, 1, true, '2471.60']);
    assert.equal((await q('SELECT count(*)::int AS n FROM purchases WHERE import_id = $1', [imp.id]))[0].n, 0);
    assert.equal((await q('SELECT count(*)::int AS n FROM product_aliases WHERE import_id = $1', [imp.id]))[0].n, 0);
    assert.equal((await q('SELECT count(*)::int AS n FROM purchase_books WHERE id = $1', [imp.book_id]))[0].n, 0, 'the book was left empty, so it goes too');
    const [trace] = await q('SELECT undone_at, undone_by, book_id, file FROM book_imports WHERE id = $1', [imp.id]);
    assert.ok(trace.undone_at); assert.equal(trace.undone_by, 1); assert.equal(trace.book_id, null); assert.equal(trace.file, fileName(MONTH[10]));

    assert.equal((await request(`/api/purchases/import/${imp.id}/undo`, 'POST')).status, 409, 'cannot be undone twice');
    assert.equal((await request('/api/purchases/import/999999/undo', 'POST')).status, 404);
    assert.equal((await request('/api/purchases/import/x/undo', 'POST')).status, 400);

    const again = await importBook(fileName(MONTH[10]), 10);
    assert.equal(again.status, 201); assert.equal(again.body.inserted, 3, 'after undoing, the same book comes in whole again');
});

test('undoing an import does NOT touch what the other imports of the same book brought, and the book stays', { skip }, async () => {
    const first = await importBook(fileName(MONTH[11]), 11);
    assert.equal(first.status, 201);
    const second = await importBook(fileName(MONTH[11]), 11, [[F(2026, 11, 9), '1103', 'ROLLO EXTRA NOVIEMBRE', 1, 100, 100, 100, 116, 'AB', 'TEST SUPPLIER', null]]);
    assert.equal(second.body.inserted, 1, 'only the new line');
    const [imp] = await q('SELECT id, book_id FROM book_imports ORDER BY id DESC LIMIT 1');

    const r = await request(`/api/purchases/import/${imp.id}/undo`, 'POST');
    assert.equal(r.body.lines, 1); assert.equal(r.body.book_deleted, false);
    assert.equal((await q('SELECT count(*)::int AS n FROM purchases WHERE book_id = $1', [imp.book_id]))[0].n, 3, 'the first import lines are still there');
});

test('an import from before undo existed (unmarked lines) cannot be undone, and the history says why', { skip }, async () => {
    const [{ id }] = await q(`INSERT INTO book_imports (book_id, file, sha256, user_id, new_count, existing_count, description_differs, links_created)
                              VALUES (NULL, 'old (JUNIO25).xlsx', $1, 1, 5, 0, 0, 0) RETURNING id`, ['a'.repeat(64)]);
    const r = await request(`/api/purchases/import/${id}/undo`, 'POST');
    assert.equal(r.status, 409); assert.match(r.body.error, /predates undo/);
    const h = (await request('/api/purchases/import/history')).body.find(x => x.id === id);
    assert.match(h.undo_blocked_reason, /predates/);
});

test('lines already linked to an inventory movement are not deleted: 409 and nothing changes', { skip }, async () => {
    const [mov] = await q("INSERT INTO movements (product_id, type, quantity, user_id) VALUES ($1, 'in', 1, 1) RETURNING id", [productId]);
    await importBook(fileName(MONTH[12]), 12);
    const [imp] = await q('SELECT id FROM book_imports ORDER BY id DESC LIMIT 1');
    await q('UPDATE purchases SET movement_id = $2 WHERE id = (SELECT min(id) FROM purchases WHERE import_id = $1)', [imp.id, mov.id]);
    const r = await request(`/api/purchases/import/${imp.id}/undo`, 'POST');
    assert.equal(r.status, 409); assert.match(r.body.error, /movement/);
    assert.equal((await q('SELECT count(*)::int AS n FROM purchases WHERE import_id = $1', [imp.id]))[0].n, 3);
    assert.equal((await q('SELECT undone_at FROM book_imports WHERE id = $1', [imp.id]))[0].undone_at, null);
});

test('an import that changes nothing leaves no row and no mark', { skip }, async () => {
    const before = (await q('SELECT count(*)::int AS n FROM book_imports'))[0].n;
    const r = await importBook(fileName(MONTH[9]), 9);
    assert.equal(r.status, 200); assert.equal(r.body.inserted, 0);
    assert.equal((await q('SELECT count(*)::int AS n FROM book_imports'))[0].n, before);
});
