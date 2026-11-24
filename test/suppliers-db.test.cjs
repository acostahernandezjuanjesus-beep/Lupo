const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const createSuppliersRoutes = require('../suppliers');
const { resolveSupplier } = createSuppliersRoutes;

// The supplier card against real PostgreSQL: repeated names, equivalences, rename, merge, archive and delete.
// A fake cannot test this: what matters is what the database allows and what it does not.
//
// Needs a DISPOSABLE server (LUPO_TEST_ADMIN_URL): see scripts/testDb.cjs. Skipped without it.

const { skip, createDb } = require('../scripts/testDb.cjs');

let db, pool, server, base, role = 'admin';

before(async () => {
    if (skip) return;
    db = await createDb('suppliers');
    pool = db.pool;
    await pool.query(`INSERT INTO users (id, name, username, role) VALUES (1, 'Tester', 'tester', 'admin')`);
    await pool.query(`INSERT INTO products (code, name) VALUES ('SUP-P1', 'Supplier test product')`);

    // Identity is not what is tested here (the other files do that): a fixed user, with whatever role is needed.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { id: 1, name: 'Test', role }; next(); });
    app.use('/api/suppliers', createSuppliersRoutes(pool));
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120_000 });

after(async () => {
    if (skip) return;
    await new Promise(r => server.close(r));
    await db.close();
});

const call = async (route, method = 'GET', body) => {
    const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const create = async (name, extra = {}) => (await call('/api/suppliers', 'POST', { name, ...extra })).body;
const q = (sql, args) => pool.query(sql, args).then(r => r.rows);

let book = null;
async function line(supplierText, { supplierId = null, description = 'DISCO', amount = 100 } = {}) {
    book ??= (await q(`INSERT INTO purchase_books (file, period) VALUES ('test.xlsx', '2026-08') RETURNING id`))[0].id;
    const [{ id }] = await q(
        `INSERT INTO purchases (book_id, sheet, sheet_order, cell, row_num, type, date_status, description, quantity, unit_price, supplier_text, supplier_id, date)
         VALUES ($1, 'H', 1, 'A1', (SELECT coalesce(max(row_num), 0) + 1 FROM purchases), 'purchase', 'explicit date', $2, 1, $3, $4, $5, '2026-08-05') RETURNING id`,
        [book, description, amount, supplierText, supplierId]);
    return id;
}
const supplierOf = async id => (await q('SELECT supplier_id FROM purchases WHERE id = $1', [id]))[0].supplier_id;

test('create: a supplier not yet in any book, with its RFC; the RFC is stored uppercase', { skip }, async () => {
    const r = await call('/api/suppliers', 'POST', { name: '  New Hardware  ', rfc: 'abc010203xy1', note: 'Recommended by a coworker' });
    assert.equal(r.status, 201);
    assert.equal(r.body.name, 'New Hardware');
    assert.equal(r.body.rfc, 'ABC010203XY1');
    const d = (await call(`/api/suppliers/detail?id=${r.body.id}`)).body;
    assert.equal(d.lines, 0);
    assert.equal(d.amount, null, 'with no purchases it is "-", not $0.00');
    assert.deepEqual(d.links, { purchases: 0, invoices: 0, movements: 0 });
});

test('create: a repeated name (ignoring case and spacing) or a repeated RFC is 409 and says whose', { skip }, async () => {
    const a = await create('Bolt   One', { rfc: 'TUN010101AB1' });
    for (const name of ['bolt one', 'BOLT ONE  ']) {
        const r = await call('/api/suppliers', 'POST', { name });
        assert.equal(r.status, 409, name);
        assert.equal(r.body.supplier.id, a.id);
    }
    const sameRfc = await call('/api/suppliers', 'POST', { name: 'Something Else', rfc: 'TUN010101AB1' });
    assert.equal(sameRfc.status, 409);
});

test('create: links what already existed with that name (book lines) without rewriting them', { skip }, async () => {
    const loose = await line('Northern Steel');
    const r = await create('NORTHERN STEEL');
    assert.equal(r.linked.purchases, 1);
    assert.equal(await supplierOf(loose), r.id);
    assert.equal((await q('SELECT supplier_text FROM purchases WHERE id = $1', [loose]))[0].supplier_text, 'Northern Steel', 'the book text is not touched');
});

test('equivalences: "also called" links what was written, and a name cannot point to two suppliers', { skip }, async () => {
    const zentra = await create('Zentra Test Abrasives');
    const written = await line('ZENTRA');
    const r = await call(`/api/suppliers/${zentra.id}/aliases`, 'POST', { alias: 'zentra' });
    assert.equal(r.status, 201);
    assert.equal(r.body.linked.purchases, 1);
    assert.equal(await supplierOf(written), zentra.id);

    const other = await create('Other House');
    const clash = await call(`/api/suppliers/${other.id}/aliases`, 'POST', { alias: 'ZENTRA' });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.supplier.id, zentra.id);
    assert.equal((await call(`/api/suppliers/${zentra.id}/aliases`, 'POST', { alias: 'ZENTRA TEST ABRASIVES' })).status, 409, 'its own name is not an equivalence');
    assert.equal((await call('/api/suppliers', 'POST', { name: 'Zentra' })).status, 409, 'nor can a new supplier be named like an equivalence');
});

test('equivalences: resolveSupplier finds by name, by equivalence and by RFC; with nothing, null', { skip }, async () => {
    const p = await create('Pacific Gases', { rfc: 'GPA010101AA1' });
    await call(`/api/suppliers/${p.id}/aliases`, 'POST', { alias: 'Pacific Gasses' });
    assert.equal(await resolveSupplier(pool, { name: 'PACIFIC GASES' }), p.id);
    assert.equal(await resolveSupplier(pool, { name: 'pacific   gasses' }), p.id);
    assert.equal(await resolveSupplier(pool, { rfc: 'gpa010101aa1', name: 'any other name' }), p.id, 'the RFC rules');
    assert.equal(await resolveSupplier(pool, { name: 'Nobody' }), null);
});

test('equivalences: removing one does not unlink what is already linked', { skip }, async () => {
    const p = await create('Paints One');
    const written = await line('Pnt. One');
    const { body: alias } = await call(`/api/suppliers/${p.id}/aliases`, 'POST', { alias: 'Pnt. One' });
    assert.equal(await supplierOf(written), p.id);
    assert.equal((await call(`/api/suppliers/${p.id}/aliases/${alias.id}`, 'DELETE')).status, 200);
    assert.equal(await supplierOf(written), p.id);
    assert.equal((await call(`/api/suppliers/${p.id}/aliases/${alias.id}`, 'DELETE')).status, 404);
});

test('adopt: "it is the same" writes the equivalence (the next book links already) and linking a name that does not exist is 404', { skip }, async () => {
    const dest = await create('Test Fasteners Plant');
    const written = await line('ACMEFAST');
    const r = await call('/api/suppliers/adopt', 'POST', { name: 'ACMEFAST', supplier_id: dest.id });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.id, r.body.linked, r.body.created], [dest.id, 1, false]);
    assert.equal(await supplierOf(written), dest.id);
    assert.equal(await resolveSupplier(pool, { name: 'acmefast' }), dest.id, 'remembered');
    assert.equal((await call('/api/suppliers/adopt', 'POST', { name: 'IN NO BOOK AT ALL' })).status, 404);
    assert.equal((await call('/api/suppliers/adopt', 'POST', { name: 'ACMEFAST', supplier_id: 999999 })).status, 404);
});

test('adopt: as a new supplier it creates and links it', { skip }, async () => {
    const written = await line('Dalton Supply North');
    const r = await call('/api/suppliers/adopt', 'POST', { name: 'Dalton Supply North' });
    assert.equal(r.status, 201);
    assert.equal(r.body.created, true);
    assert.equal(await supplierOf(written), r.body.id);
});

test('edit: renaming leaves the old name as an equivalence; lines stay linked and keep their text', { skip }, async () => {
    const p = await create('Zentra Test Misspelled');
    const r1 = await line('Zentra Test Misspelled', { supplierId: p.id });
    const ed = await call(`/api/suppliers/${p.id}`, 'PATCH', { name: 'Zentra Test Right' });
    assert.equal(ed.status, 200);
    assert.equal(ed.body.name, 'Zentra Test Right');
    const d = (await call(`/api/suppliers/detail?id=${p.id}`)).body;
    assert.deepEqual(d.aliases.map(a => [a.alias, a.origin]), [['Zentra Test Misspelled', 'rename']]);
    assert.equal(await supplierOf(r1), p.id);
    assert.equal(await resolveSupplier(pool, { name: 'zentra test misspelled' }), p.id, 'a book with the old name still links');

    const clash = await call(`/api/suppliers/${p.id}`, 'PATCH', { name: 'NORTHERN STEEL' });
    assert.equal(clash.status, 409);
    assert.equal((await call(`/api/suppliers/${p.id}`, 'PATCH', { name: 'zentra test misspelled' })).status, 200, 'going back to its old name is valid');
});

test('edit: only changing case does not create an equivalence (an accent does), and note and RFC are saved', { skip }, async () => {
    const p = await create('Cerrajería Lopez');
    const upper = await call(`/api/suppliers/${p.id}`, 'PATCH', { name: 'CERRAJERÍA LOPEZ' });
    assert.equal(upper.status, 200);
    assert.equal((await call(`/api/suppliers/detail?id=${p.id}`)).body.aliases.length, 0, 'same name, another way of writing it');
    const r = await call(`/api/suppliers/${p.id}`, 'PATCH', { name: 'Cerrajería López', note: 'Pickup at the counter', rfc: 'cel010101aa1' });
    assert.equal(r.status, 200);
    const d = (await call(`/api/suppliers/detail?id=${p.id}`)).body;
    assert.equal(d.card.note, 'Pickup at the counter');
    assert.equal(d.card.rfc, 'CEL010101AA1');
    assert.equal(d.aliases.length, 1, 'López is not Lopez: it is another name and the previous one is remembered');
    assert.equal((await call(`/api/suppliers/${p.id}`, 'PATCH', { rfc: null })).status, 200);
    assert.equal((await call(`/api/suppliers/detail?id=${p.id}`)).body.card.rfc, null);
});

test('RFC: setting a supplier\'s RFC links the invoices from that issuer that had no supplier', { skip }, async () => {
    const [{ id: user }] = await q(`SELECT id FROM users LIMIT 1`);
    const [{ id: invoice }] = await q(
        `INSERT INTO invoices (source, issuer_rfc, issuer_name, captured_by, total, folio) VALUES ('manual', 'RFA010101AA1', 'Long Legal Name SA', $1, 100, 'F1') RETURNING id`, [user]);
    const p = await create('Short name');
    assert.equal((await q('SELECT supplier_id FROM invoices WHERE id = $1', [invoice]))[0].supplier_id, null);
    await call(`/api/suppliers/${p.id}`, 'PATCH', { rfc: 'RFA010101AA1' });
    assert.equal((await q('SELECT supplier_id FROM invoices WHERE id = $1', [invoice]))[0].supplier_id, p.id);
});

test('merge: everything from the one that disappears goes to the one that stays, and its name becomes an equivalence', { skip }, async () => {
    const [{ id: user }] = await q(`SELECT id FROM users LIMIT 1`);
    const source = await create('Duplicate One', { rfc: 'DUP010101AA1' });
    const target = await create('Main One');
    await call(`/api/suppliers/${source.id}/aliases`, 'POST', { alias: 'Dup. 1' });
    const sourceLine = await line('Duplicate One', { supplierId: source.id });
    const [{ id: product }] = await q(`SELECT id FROM products LIMIT 1`);
    const [{ id: movement }] = await q(
        `INSERT INTO movements (product_id, type, quantity, user_id, supplier_id, origin) VALUES ($1, 'in', 1, $2, $3, 'operational') RETURNING id`, [product, user, source.id]);

    const r = await call(`/api/suppliers/${source.id}/merge`, 'POST', { into: target.id });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.moved, { purchases: 1, invoices: 0, movements: 1 });
    assert.equal(await supplierOf(sourceLine), target.id);
    assert.equal((await q('SELECT supplier_id FROM movements WHERE id = $1', [movement]))[0].supplier_id, target.id, 'who supplied a stock-in is not lost');
    assert.equal((await q('SELECT count(*)::int AS n FROM suppliers WHERE id = $1', [source.id]))[0].n, 0);
    const d = (await call(`/api/suppliers/detail?id=${target.id}`)).body;
    assert.deepEqual(d.aliases.map(a => a.alias).sort(), ['Dup. 1', 'Duplicate One']);
    assert.equal(d.card.rfc, 'DUP010101AA1', 'inherits the RFC if it had none');
    assert.equal(await resolveSupplier(pool, { name: 'dup. 1' }), target.id);

    assert.equal((await call(`/api/suppliers/${target.id}/merge`, 'POST', { into: target.id })).status, 400);
    assert.equal((await call(`/api/suppliers/${target.id}/merge`, 'POST', { into: 999999 })).status, 404);
});

test('archive: stops showing in the list unless archived are requested, and keeps its history; it can be restored', { skip }, async () => {
    const p = await create('Old Supplier');
    const oldLine = await line('Old Supplier', { supplierId: p.id });
    assert.equal((await call(`/api/suppliers/${p.id}/archive`, 'POST')).status, 200);
    const names = async url => (await call(url)).body.suppliers.filter(x => x.in_catalog).map(x => x.name);
    assert.equal((await names('/api/suppliers')).includes('Old Supplier'), false);
    assert.equal((await names('/api/suppliers?archived=1')).includes('Old Supplier'), true);
    assert.equal(await supplierOf(oldLine), p.id, 'its history stays linked');
    assert.equal((await call(`/api/suppliers/${p.id}/unarchive`, 'POST')).status, 200);
    assert.equal((await names('/api/suppliers')).includes('Old Supplier'), true);
});

test('delete: with history it is 409 and says what is linked; with nothing it is deleted with its equivalences', { skip }, async () => {
    const withHistory = await create('With History');
    await line('With History', { supplierId: withHistory.id });
    const no = await call(`/api/suppliers/${withHistory.id}`, 'DELETE');
    assert.equal(no.status, 409);
    assert.equal(no.body.links.purchases, 1);
    assert.equal((await q('SELECT count(*)::int AS n FROM suppliers WHERE id = $1', [withHistory.id]))[0].n, 1);

    const alone = await create('Nothing Here');
    await call(`/api/suppliers/${alone.id}/aliases`, 'POST', { alias: 'Nothing H.' });
    assert.equal((await call(`/api/suppliers/${alone.id}`, 'DELETE')).status, 200);
    assert.equal((await q('SELECT count(*)::int AS n FROM supplier_aliases WHERE supplier_id = $1', [alone.id]))[0].n, 0);
    assert.equal((await call(`/api/suppliers/${alone.id}`, 'DELETE')).status, 404);
});

test('the storekeeper creates and edits, but merge, archive and delete stay admin-only', { skip }, async () => {
    role = 'storekeeper';
    try {
        const p = await create('Made by Storekeeper');
        assert.ok(p.id);
        assert.equal((await call(`/api/suppliers/${p.id}`, 'PATCH', { note: 'ok' })).status, 200);
        for (const [method, route, body] of [['POST', `/api/suppliers/${p.id}/archive`], ['DELETE', `/api/suppliers/${p.id}`], ['POST', `/api/suppliers/${p.id}/merge`, { into: 1 }]]) {
            assert.equal((await call(route, method, body)).status, 403, `${method} ${route}`);
        }
    } finally { role = 'admin'; }
});

test('contacts: several per supplier, added, edited and removed; they validate; move on merge and go on delete', { skip }, async () => {
    const p = await create('With Contacts');
    const route = `/api/suppliers/${p.id}/contacts`;
    const a = await call(route, 'POST', { name: ' Sales ', phone: '555 123 4567', email: 'sales@x.test', address: 'Main St 1, Springfield' });
    const b = await call(route, 'POST', { phone: '555 999 0000' });
    assert.equal(a.status, 201);
    assert.equal(a.body.name, 'Sales');
    assert.deepEqual(a.body.phones, ['555 123 4567'], 'a single phone is a list of one');
    assert.equal(b.status, 201);
    assert.equal(b.body.email, null);

    for (const bad of [{}, { name: '  ' }, { email: 'no-at-sign' }, { phone: 'x'.repeat(41) }, { name: 5 }, { phones: '555' }, { phones: [555] },
        { phones: ['1', '2', '3', '4', '5', '6'] }, { phones: ['  ', ''] }]) {
        assert.equal((await call(route, 'POST', bad)).status, 400, JSON.stringify(bad));
    }

    const edit = await call(`${route}/${b.body.id}`, 'PUT', { name: 'Collections', phone: '', email: 'collections@x.test' });
    assert.equal(edit.status, 200);
    assert.deepEqual([edit.body.name, edit.body.phones, edit.body.email], ['Collections', [], 'collections@x.test']);
    // Several phones in a contact: clean, no empty or repeated ones, in the order they were written.
    const several = await call(`${route}/${b.body.id}`, 'PUT', { name: 'Collections', phones: [' 555 111 2222 ', '', '555  333 4444', '555 111 2222'] });
    assert.deepEqual(several.body.phones, ['555 111 2222', '555 333 4444']);
    assert.equal((await call(route, 'POST', { phones: ['800 000 0000'] })).status, 201, 'only phones is also a contact');
    assert.equal((await call(`${route}/${b.body.id}`, 'PUT', {})).status, 400, 'it cannot be left empty');
    assert.equal((await call(`/api/suppliers/999999/contacts/${a.body.id}`, 'PUT', { name: 'X' })).status, 404, 'only if it belongs to that supplier');

    const d = (await call(`/api/suppliers/detail?id=${p.id}`)).body;
    assert.deepEqual(d.contacts.map(c => c.name), ['Sales', 'Collections', null]);
    assert.deepEqual(d.contacts[1].phones, ['555 111 2222', '555 333 4444']);
    role = 'storekeeper';
    try { assert.deepEqual((await call(`/api/suppliers/detail?id=${p.id}`)).body.contacts, [], 'the storekeeper does not see contacts'); } finally { role = 'admin'; }

    assert.equal((await call(`${route}/${b.body.id}`, 'DELETE')).status, 200);
    assert.equal((await call(`${route}/${b.body.id}`, 'DELETE')).status, 404);

    const target = await create('Keeps The Contacts');
    assert.equal((await call(`/api/suppliers/${p.id}/merge`, 'POST', { into: target.id })).status, 200);
    const after = (await call(`/api/suppliers/detail?id=${target.id}`)).body;
    assert.deepEqual(after.contacts.map(c => c.name), ['Sales', null]);

    assert.equal((await call(`/api/suppliers/${target.id}`, 'DELETE')).status, 200);
    assert.equal((await q('SELECT count(*)::int AS n FROM supplier_contacts WHERE supplier_id = $1', [target.id]))[0].n, 0);
});

test('two people creating the same name at once: one wins and the other gets 409, never two cards', { skip }, async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => call('/api/suppliers', 'POST', { name: 'Race Inc' })));
    assert.deepEqual(rs.map(r => r.status).sort(), [201, 409, 409, 409, 409, 409]);
    assert.equal((await q(`SELECT count(*)::int AS n FROM suppliers WHERE normalize_supplier(name) = 'race inc'`))[0].n, 1);
});

test('tags: stored clean and without repeats, written the same everywhere, shown in the list and moved on merge', { skip }, async () => {
    const a = await create('Tagged One', { tags: ['  Steel ', 'steel', 'Thin   sheet', ''] });
    assert.deepEqual(a.tags, ['Steel', 'Thin sheet']);
    const b = await create('Tagged Two');
    assert.deepEqual(b.tags, []);
    // "Steel" already exists: another way of writing it does not create a second tag.
    const r = await call(`/api/suppliers/${b.id}`, 'PATCH', { tags: ['STEEL', 'Valves'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tags, ['Steel', 'Valves']);
    // Changing something else does not touch them.
    assert.deepEqual((await call(`/api/suppliers/${b.id}`, 'PATCH', { note: 'x' })).body.tags, ['Steel', 'Valves']);
    const list = (await call('/api/suppliers')).body.suppliers;
    assert.deepEqual(list.find(p => p.id === b.id).tags, ['Steel', 'Valves']);
    assert.deepEqual((await call(`/api/suppliers/detail?id=${a.id}`)).body.card.tags, ['Steel', 'Thin sheet']);

    assert.equal((await call(`/api/suppliers/${b.id}/merge`, 'POST', { into: a.id })).status, 200);
    assert.deepEqual((await q('SELECT tags FROM suppliers WHERE id = $1', [a.id]))[0].tags, ['Steel', 'Thin sheet', 'Valves']);
    assert.equal((await call(`/api/suppliers/${a.id}`, 'PATCH', { tags: [] })).body.tags.length, 0);
});

test('preset tags: they exist without anyone bringing them, the admin adds and removes them, and they rule how a tag is written', { skip }, async () => {
    const presets = async () => (await call('/api/suppliers')).body.preset_tags;
    const initial = await presets();
    assert.equal(initial.length, 15);
    assert.ok(initial.some(e => e.name === 'Cutting tools'));
    assert.equal((await q(`SELECT count(*)::int AS n FROM suppliers WHERE 'Cutting tools' = ANY(tags)`))[0].n, 0, 'it is not put on anyone');

    const created = await call('/api/suppliers/tags', 'POST', { name: '  Rubber  and seals ' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Rubber and seals');
    assert.equal((await call('/api/suppliers/tags', 'POST', { name: 'RUBBER AND SEALS' })).status, 409);

    // Writing it another way on a supplier stores the one from the list.
    const p = await create('Presets Inc', { tags: ['rubber and seals', 'MEASUREMENT'] });
    assert.deepEqual(p.tags, ['Rubber and seals', 'Measurement']);

    // Removing it from the list does not remove it from whoever already has it.
    assert.equal((await call(`/api/suppliers/tags/${created.body.id}`, 'DELETE')).status, 200);
    assert.equal((await call(`/api/suppliers/tags/${created.body.id}`, 'DELETE')).status, 404);
    assert.equal((await presets()).some(e => e.name === 'Rubber and seals'), false);
    assert.deepEqual((await q('SELECT tags FROM suppliers WHERE id = $1', [p.id]))[0].tags, ['Rubber and seals', 'Measurement']);

    role = 'storekeeper';
    try { assert.equal((await call('/api/suppliers/tags', 'POST', { name: 'Another' })).status, 403); } finally { role = 'admin'; }
});
