const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// The Suppliers screen. REAL identity (`requireSession`), a fake pool that answers by the shape of the SQL.
// Here: permissions, validation and the list. What needs the real database (repeated names, equivalences,
// merge, delete) is in suppliers-db.test.cjs.

async function setup(t, role, { suppliers = [], noSupplier = { lines: 0, amount: null }, totals, card } = {}) {
    const queries = [];
    const answer = async sql => {
        if (/FROM sessions s\s+JOIN users u/.test(sql)) return { rows: [{ id: 7, name: 'Whoever', role, must_change_password: false }] };
        if (/UNION ALL/.test(sql) && /FROM suppliers p/.test(sql)) return { rows: suppliers };
        if (/supplier_text IS NULL\s*$/.test(sql.trim())) return { rows: [noSupplier] };
        if (/FROM suppliers WHERE id = \$1/.test(sql) && !/FOR UPDATE/.test(sql)) return { rows: card === null ? [] : [card ?? { id: 25, name: 'ACME', rfc: null, note: null, archived: false }] };
        if (/FROM supplier_aliases a LEFT JOIN users/.test(sql)) return { rows: [{ id: 1, alias: 'A C M E', origin: 'manual', created_at: '2026-10-15', created_by: 'Ana' }] };
        if (/AS purchases,\s+\(SELECT count/.test(sql)) return { rows: [{ purchases: 3, invoices: 0, movements: 1 }] };
        if (/min\(c\.date\), 'YYYY-MM-DD'\) AS first_date/.test(sql)) return { rows: [totals ?? { lines: 3, amount: '300.00', first_date: '2026-08-03', last_date: '2026-10-12' }] };
        if (/NULL AS supplier/.test(sql)) return { rows: [
            { id: 1, date: '2026-10-12', folio: 'A1', amount: '100.00', supplier: null },
            { id: 2, date: '2026-10-12', folio: 'A1', amount: '50.00', supplier: null },
            { id: 3, date: '2026-08-03', folio: 'B2', amount: '150.00', supplier: null },
        ] };
        if (/GROUP BY c\.description_norm/.test(sql)) return { rows: [{ description: 'DISCO', lines: 2, amount: '250.00' }] };
        if (/FROM purchases c\s+JOIN purchase_books|WITH twins/.test(sql)) return { rows: [{ total: 0, detail: [] }] };
        return { rows: [], rowCount: 0 };
    };
    const pool = {
        async query(sql, args) { queries.push({ sql, args }); return answer(sql); },
        async connect() { return { query: (sql, args) => pool.query(sql, args), release() {} }; },
    };
    const server = createApp(pool).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (route, method = 'GET', body) => {
        const r = await fetch(base + route, { method, headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { call, queries, data: () => queries.filter(c => !/FROM sessions s\s+JOIN users u/.test(c.sql)) };
}

const WRITES = [
    ['POST', '/api/suppliers', { name: 'NEW' }], ['PATCH', '/api/suppliers/1', { note: 'x' }],
    ['POST', '/api/suppliers/1/aliases', { alias: 'X' }], ['DELETE', '/api/suppliers/1/aliases/1'],
    ['POST', '/api/suppliers/adopt', { name: 'ZENTRA' }],
];
const ADMIN_ONLY = [
    ['POST', '/api/suppliers/1/merge', { into: 2 }], ['POST', '/api/suppliers/1/archive'],
    ['POST', '/api/suppliers/1/unarchive'], ['DELETE', '/api/suppliers/1'],
    ['POST', '/api/suppliers/1/contacts', { name: 'X' }], ['PUT', '/api/suppliers/1/contacts/1', { name: 'X' }],
    ['DELETE', '/api/suppliers/1/contacts/1'], ['POST', '/api/suppliers/tags', { name: 'Steel' }], ['DELETE', '/api/suppliers/tags/1'],
];

test('operator and technician bounce without querying; storekeeper and admin get in', async t => {
    for (const role of ['operator', 'technician']) {
        const e = await setup(t, role);
        for (const [method, route, body] of [['GET', '/api/suppliers'], ['GET', '/api/suppliers/detail?id=1'], ...WRITES, ...ADMIN_ONLY]) {
            assert.equal((await e.call(route, method, body)).status, 403, `${role} ${method} ${route}`);
        }
        assert.deepEqual(e.data(), [], role);
    }
    for (const role of ['storekeeper', 'admin']) {
        const e = await setup(t, role);
        assert.equal((await e.call('/api/suppliers')).status, 200, role);
        assert.equal((await e.call('/api/suppliers/detail?id=1')).status, 200, role);
    }
});

test('merge, archive and delete are admin-only: the storekeeper bounces without querying', async t => {
    const sk = await setup(t, 'storekeeper');
    for (const [method, route, body] of ADMIN_ONLY) assert.equal((await sk.call(route, method, body)).status, 403, `${method} ${route}`);
    assert.deepEqual(sk.data(), []);
});

test('invalid input is 400 and writes nothing: name, RFC, note, tags, ids', async t => {
    const e = await setup(t, 'admin');
    const bad = [
        ['POST', '/api/suppliers', {}], ['POST', '/api/suppliers', { name: '   ' }], ['POST', '/api/suppliers', { name: 'x'.repeat(121) }],
        ['POST', '/api/suppliers', { name: 'A', rfc: 'short' }], ['POST', '/api/suppliers', { name: 'A', rfc: 'XAXX010101000' }],
        ['POST', '/api/suppliers', { name: 'A', note: 'x'.repeat(1001) }], ['PATCH', '/api/suppliers/abc', { note: 'x' }],
        ['PATCH', '/api/suppliers/1', { name: '' }], ['POST', '/api/suppliers/1/aliases', {}], ['DELETE', '/api/suppliers/1/aliases/x'],
        ['POST', '/api/suppliers/1/merge', {}], ['POST', '/api/suppliers/1/merge', { into: 1 }], ['POST', '/api/suppliers/adopt', { name: '' }],
        ['POST', '/api/suppliers/adopt', { name: 'X', supplier_id: 'x' }],
        ['POST', '/api/suppliers/tags', {}], ['POST', '/api/suppliers/tags', { name: 'x'.repeat(31) }], ['DELETE', '/api/suppliers/tags/x'],
        ['PATCH', '/api/suppliers/1', { tags: 'Steel' }], ['PATCH', '/api/suppliers/1', { tags: [1] }],
        ['PATCH', '/api/suppliers/1', { tags: ['x'.repeat(31)] }], ['POST', '/api/suppliers', { name: 'A', tags: 'abcdefghi'.split('') }],
    ];
    for (const [method, route, body] of bad) assert.equal((await e.call(route, method, body)).status, 400, `${method} ${route} ${JSON.stringify(body)}`);
    assert.equal(e.data().some(c => /^\s*(INSERT|UPDATE|DELETE)/.test(c.sql)), false, 'nothing was written');
});

test('the list goes from most purchased to least, no-amount last, and does not invent "no supplier"', async t => {
    const e = await setup(t, 'storekeeper', { suppliers: [
        { id: null, name: 'ZENTRA', in_catalog: false, lines: 11, amount: '15983.00', last_date: '2026-10-01' },
        { id: 3, name: 'EMPTY', in_catalog: true, lines: 0, amount: null, last_date: null },
        { id: 25, name: 'ACME', in_catalog: true, lines: 1265, amount: '500000.00', last_date: '2026-10-13' },
        { id: 9, name: 'ALFA', in_catalog: true, lines: 0, amount: null, last_date: null },
    ] });
    const { body } = await e.call('/api/suppliers');
    assert.deepEqual(body.suppliers.map(p => p.name), ['ACME', 'ZENTRA', 'ALFA', 'EMPTY']);
    assert.equal(body.no_supplier, null, 'with zero lines there is nothing to show');
});

test('archived ones are only requested with archived=1', async t => {
    const e = await setup(t, 'storekeeper');
    await e.call('/api/suppliers');
    await e.call('/api/suppliers?archived=1');
    const lists = e.data().filter(c => /UNION ALL/.test(c.sql));
    assert.deepEqual(lists.map(c => c.args[0]), [false, true]);
});

test('a supplier that is only written gets the catalog one it resembles suggested, and they are never merged on their own', async t => {
    const e = await setup(t, 'storekeeper', { suppliers: [
        { id: 4, name: 'ZENTRA ABRASIVOS', in_catalog: true, archived: false, lines: 16, amount: '29640.00', last_date: '2026-08-07' },
        { id: 5, name: 'NOVATEK AUTOMATION', in_catalog: true, archived: true, lines: 0, amount: null, last_date: null },
        { id: null, name: 'ZENTRA', in_catalog: false, lines: 11, amount: '15983.00', last_date: '2026-03-11' },
        { id: null, name: 'Novatek Bakery', in_catalog: false, lines: 1, amount: '5005.00', last_date: '2026-04-06' },
        { id: null, name: 'NOVATEK AUTOMATION', in_catalog: false, lines: 1, amount: '50.00', last_date: '2026-04-06' },
    ] });
    const { body } = await e.call('/api/suppliers?archived=1');
    const by = n => body.suppliers.find(p => p.name === n && !p.in_catalog) ?? body.suppliers.find(p => p.name === n);
    assert.deepEqual(by('ZENTRA').suggested, { id: 4, name: 'ZENTRA ABRASIVOS' });
    assert.equal(by('Novatek Bakery').suggested, null, 'with no resemblance nothing is suggested');
    assert.equal(body.suppliers.find(p => p.name === 'NOVATEK AUTOMATION' && !p.in_catalog).suggested, null, 'an archived one is not suggested');
    assert.equal(by('ZENTRA').id, null, 'suggesting does not link');
});

test('lines with no supplier are counted apart when there are any', async t => {
    const e = await setup(t, 'admin', { noSupplier: { lines: 3, amount: '120.00' } });
    assert.deepEqual((await e.call('/api/suppliers')).body.no_supplier, { lines: 3, amount: '120.00' });
});

test('detail: by id or by text, never both nor neither, and the value goes as a parameter', async t => {
    const e = await setup(t, 'storekeeper');
    assert.equal((await e.call('/api/suppliers/detail')).status, 400);
    assert.equal((await e.call('/api/suppliers/detail?id=1&text=X')).status, 400);
    assert.equal((await e.call('/api/suppliers/detail?id=abc')).status, 400);
    assert.deepEqual(e.data(), [], 'invalid input does not reach the database');

    assert.equal((await e.call('/api/suppliers/detail?id=25')).status, 200);
    assert.ok(e.data().filter(c => /c\.supplier_id = \$1/.test(c.sql)).every(c => c.args[0] === 25));

    const e2 = await setup(t, 'storekeeper');
    const malicious = "X'; DROP TABLE purchases; --";
    await e2.call('/api/suppliers/detail?text=' + encodeURIComponent(malicious));
    const byText = e2.data().filter(c => /supplier_id IS NULL AND c\.supplier_text = \$1/.test(c.sql));
    assert.ok(byText.length > 0 && byText.every(c => c.args[0] === malicious));
});

test('detail of a catalog one: its card, its equivalences and what is linked; a purchase is a folio', async t => {
    const e = await setup(t, 'storekeeper');
    const { body } = await e.call('/api/suppliers/detail?id=25');
    assert.deepEqual(body.card, { id: 25, name: 'ACME', rfc: null, note: null, archived: false });
    assert.equal(body.aliases[0].alias, 'A C M E');
    assert.deepEqual(body.links, { purchases: 3, invoices: 0, movements: 1 });
    assert.deepEqual(body.latest, [
        { date: '2026-10-12', folio: 'A1', lines: 2, amount: '150.00' },
        { date: '2026-08-03', folio: 'B2', lines: 1, amount: '150.00' },
    ]);
    assert.equal(body.top_purchased[0].description, 'DISCO');
});

test('a hand-made supplier with no purchases does have a detail; a missing one is 404; so is a written-only one with no lines', async t => {
    const empty = { lines: 0, amount: null, first_date: null, last_date: null };
    const created = await setup(t, 'storekeeper', { totals: empty });
    const r = await created.call('/api/suppliers/detail?id=25');
    assert.equal(r.status, 200);
    assert.equal(r.body.lines, 0);
    assert.equal(r.body.amount, null, 'with no purchases it is "-", not $0.00');

    const missing = await setup(t, 'storekeeper', { card: null });
    assert.equal((await missing.call('/api/suppliers/detail?id=999')).status, 404);

    const written = await setup(t, 'storekeeper', { totals: empty });
    assert.equal((await written.call('/api/suppliers/detail?text=NOTHING')).status, 404);
});

test('purchases: filtered by catalog supplier (id) or by the written text, and not both', async t => {
    const e = await setup(t, 'storekeeper');
    assert.equal((await e.call('/api/purchases?supplier_id=abc')).status, 400);
    assert.equal((await e.call('/api/purchases?supplier_id=1&supplier_text=X')).status, 400);

    assert.equal((await e.call('/api/purchases?supplier_id=25')).status, 200);
    const byId = e.data().at(-1);
    assert.match(byId.sql, /c\.supplier_id = \$1/);
    assert.equal(byId.args[0], 25);

    assert.equal((await e.call('/api/purchases?supplier_text=ZENTRA')).status, 200);
    const byText = e.data().at(-1);
    assert.match(byText.sql, /c\.supplier_id IS NULL AND c\.supplier_text = \$1/);
    assert.equal(byText.args[0], 'ZENTRA');
});
