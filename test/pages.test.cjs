const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// `?page=1e308` used to become an infinite OFFSET and PostgreSQL answered 22P02 ("bigint: Infinity"), a 500,
// on products, movements and invoices. Now it is a 400, like it already was on Purchases.

test('an absurd page never reaches the database as infinity: it is a 400 that says so, not a 500', async t => {
    const offsets = [];
    const pool = {
        async query(sql, args = []) {
            if (/FROM sessions s\s+JOIN users u/.test(sql)) return { rows: [{ id: 7, name: 'Whoever', role: 'admin', must_change_password: false }] };
            for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`bigint: "${a}"`);
            if (/OFFSET/.test(sql)) offsets.push(args.at(-1));
            return { rows: [{ total: 0, count: '0', n: 0, amount: null }], rowCount: 0 };
        },
        async connect() { return { query: (sql, a) => this.query(sql, a), release() {} }; },
    };
    const server = createApp(pool).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const status = async route => (await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: { Authorization: 'Bearer t' } })).status;

    for (const route of ['/api/products', '/api/movements', '/api/invoices']) {
        for (const page of ['1e308', '1e100', '99999999999999999999']) assert.equal(await status(`${route}?page=${page}`), 400, `${route}?page=${page}`);
        for (const page of ['Infinity', 'NaN', '0', '-5', 'abc', '2.9']) assert.equal(await status(`${route}?page=${page}`), 200, `${route}?page=${page}: taken as a normal page`);
    }
    assert.ok(offsets.length > 0 && offsets.every(o => Number.isSafeInteger(o)), 'the offset that reaches the database is always a safe integer');
});
