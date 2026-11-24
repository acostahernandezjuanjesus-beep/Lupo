const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const auth = require('../auth');
const { skip, createDb } = require('../scripts/testDb.cjs');

// Catalog search (?q=) against real PostgreSQL: the whole text, ALL words in any order ("disc cut 4" must find
// "Disc D Cut ... 4 1/2"), linked codes, and LIKE wildcards written as plain text.

let db, pool, server, url, token;

before(async () => {
    if (skip) return;
    db = await createDb('search');
    pool = db.pool;
    const hash = await auth.hashPassword('search-test-pass-1');
    await pool.query(`INSERT INTO users (name, username, role, password_hash) VALUES ('Searcher', 'searcher', 'operator', $1)`, [hash]);
    await pool.query(`INSERT INTO products (code, name) VALUES ('EPP-GLOVE-L', 'Leather welding gloves large'), ('WELD-TUNG-2', 'Tungsten electrode 2% thoriated')`);
    server = createApp(pool).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    url = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'searcher', password: 'search-test-pass-1' }) });
    token = (await r.json()).token;
    assert.ok(token, 'signed in');
}, { timeout: 120_000 });

after(async () => {
    if (skip) return;
    await new Promise(r => server.close(r));
    await db.close();
});

const search = async q => {
    const r = await fetch(`${url}/api/products?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200, q);
    return (await r.json()).products.map(p => p.code);
};
const one = async sql => (await pool.query(sql)).rows[0];

test('search: the whole text still works, and the full name finds its product', { skip }, async () => {
    const p = await one(`SELECT code, name FROM products WHERE control_type <> 'unit' ORDER BY id LIMIT 1`);
    assert.ok((await search(p.name)).includes(p.code));
    assert.ok((await search(p.code)).includes(p.code));
    assert.ok((await search(p.code.toLowerCase())).includes(p.code), 'case-insensitive');
});

test('search: all words, in any order, even if not contiguous', { skip }, async () => {
    await pool.query(`UPDATE products SET name = 'Disco D Corte P Inox Y Metal 4 1/2 X0/045 F41 Weston' WHERE id = (SELECT id FROM products ORDER BY id LIMIT 1)`);
    const { code } = await one(`SELECT code FROM products ORDER BY id LIMIT 1`);
    for (const q of ['disco corte', 'corte disco', 'weston inox', 'disco corte 4', '  DISCO   corte  ', 'f41 disco metal inox']) {
        assert.ok((await search(q)).includes(code), `"${q}" must find it`);
    }
    assert.ok(!(await search('disco corte plastilina')).includes(code), 'a missing word rules it out: it is ALL words, not any');
    assert.deepEqual(await search('zzzz qqqq'), []);
});

test('search: each word can be in a different place (name, internal code or a linked code)', { skip }, async () => {
    const p = await one(`SELECT id, code FROM products ORDER BY id LIMIT 1`);
    await pool.query(`INSERT INTO product_codes (product_id, code, type, description) VALUES ($1, 'Z-20120', 'supplier', 'DISCO FIBRA ESPECIAL')`, [p.id]);
    assert.ok((await search('weston Z-20120')).includes(p.code), 'a name word + the supplier number');
    assert.ok((await search('fibra weston')).includes(p.code), 'a word from what the supplier says + a name word');
});

test('search: a barcode printed with spaces is found the same when typed without', { skip }, async () => {
    const p = await one(`SELECT id, code FROM products ORDER BY id LIMIT 1`);
    await pool.query(`INSERT INTO product_codes (product_id, code, type) VALUES ($1, '7 506351 226012', 'barcode')`, [p.id]);
    assert.ok((await search('7 506351 226012')).includes(p.code));
    assert.ok((await search('7506351226012')).includes(p.code));
});

test('search: % and _ are text, not wildcards, also inside a word', { skip }, async () => {
    assert.deepEqual(await search('%%%'), [], 'a % is not "anything" (the tungsten "2%" does have it as text, hence three)');
    assert.deepEqual(await search('disco %'), []);
    assert.deepEqual(await search('zz_ qq_'), [], 'a _ inside a word is not "any letter"');
    assert.deepEqual(await search('\\'), []);
});

test('search: six words count and the rest are ignored, without building a huge query', { skip }, async () => {
    const { code } = await one(`SELECT code FROM products ORDER BY id LIMIT 1`);
    assert.ok((await search('disco corte inox metal weston f41 extraword1 extraword2')).includes(code), 'only the first six are required');
});
