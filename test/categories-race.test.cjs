const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const { skip, createDb } = require('../scripts/testDb.cjs');

// Two people create the same category at once (the counter PC and a phone), with different capitalisation.
// The database UNIQUE only sees the exact text and INSERT ... WHERE NOT EXISTS isn't atomic across
// transactions: without the lock in POST /api/categories, 4 simultaneous requests for "Welding" / "WELDING"
// left more than one row in 17 of 20 rounds.
//
// Runs against a real PostgreSQL: needs a DISPOSABLE server (LUPO_TEST_ADMIN_URL).

let db, server, url;

before(async () => {
    if (skip) return;
    db = await createDb('categories');
    const identity = {
        requireSession: () => (req, res, next) => { req.user = { id: 1, role: 'storekeeper' }; next(); },
        requireRole: (...roles) => (req, res, next) =>
            roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Insufficient role' }),
    };
    server = createApp(db.pool, identity).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 60_000 });

after(async () => {
    if (skip) return;
    await new Promise(resolve => server.close(resolve));
    await db.close();
});

const create = name => fetch(`${url}/api/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });

test('simultaneous requests with different capitalisation: a single row, one 201 and the rest 409', { skip }, async () => {
    for (let round = 0; round < 15; round++) {
        const base = `Soldering${round}`;
        const responses = await Promise.all([base, base.toUpperCase(), base.toLowerCase(), base.toUpperCase(), base].map(create));
        const statuses = responses.map(r => r.status).sort();
        assert.deepEqual(statuses, [201, 409, 409, 409, 409], `round ${round}: ${statuses}`);
        const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM categories WHERE lower(name) = lower($1)', [base]);
        assert.equal(rows[0].n, 1, `round ${round}: more than one row`);
    }
});

test('the lock does not leave the connection taken: after a 409 and a 400, creating keeps working', { skip }, async () => {
    assert.equal((await create('Unique')).status, 201);
    assert.equal((await create('unique')).status, 409);
    assert.equal((await create('   ')).status, 400);
    assert.equal((await create('Another')).status, 201);
    // if any connection had stayed in an open transaction, the pool would run out here
    const all = await Promise.all(Array.from({ length: 25 }, (_, i) => create(`Batch ${i}`)));
    assert.ok(all.every(r => r.status === 201));
});
