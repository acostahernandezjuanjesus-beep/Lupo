const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// DELETE /api/invoices/:id: remove an invoice, leaving a trace.

async function setup(t, { invoice = { id: 4, uuid: 'U', issuer_name: 'X', issuer_rfc: 'AAA010101AAA', series: 'A', folio: '1', invoice_date: null, total: '10.00' },
    n = { lines: 2, stock_ins: 0, files: 1 } } = {}) {
    const sqls = [];
    const pool = {
        async query(sql, args = []) {
            sqls.push({ sql, args });
            if (/FROM invoices WHERE id = \$1 FOR UPDATE/.test(sql)) return { rows: invoice ? [invoice] : [] };
            if (/FROM invoice_lines WHERE invoice_id = \$1/.test(sql) && /count\(\*\)/.test(sql)) return { rows: [n] };
            return { rows: [], rowCount: 1 };
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
    const remove = async (route, headers = {}) => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/api/invoices${route}`, { method: 'DELETE', headers });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { remove, sqls };
}

test('delete invoice: no session 401, operator 403, bad id 400, missing 404, and nothing is written', async t => {
    const e = await setup(t);
    assert.equal((await e.remove('/4', { 'x-role': 'none' })).status, 401);
    assert.equal((await e.remove('/4', { 'x-role': 'operator' })).status, 403);
    assert.equal((await e.remove('/x')).status, 400);
    assert.equal((await e.remove('/0')).status, 400);
    const none = await setup(t, { invoice: null });
    assert.equal((await none.remove('/9')).status, 404);
    for (const x of [e, none]) assert.ok(!x.sqls.some(q => /DELETE FROM invoices|INSERT INTO deleted_invoices/.test(q.sql)), 'no rejection wrote anything');
});

test('delete invoice: leaves the snapshot with the SESSION author, then deletes', async t => {
    const e = await setup(t);
    const r = await e.remove('/4', { 'x-role': 'storekeeper' });
    assert.equal(r.status, 204);
    const order = e.sqls.map(q => q.sql.trim().split(/\s+/).slice(0, 3).join(' '));
    const iTrace = order.findIndex(x => /INSERT INTO deleted_invoices/.test(x)), iDelete = order.findIndex(x => /DELETE FROM invoices/.test(x));
    assert.ok(iTrace >= 0 && iDelete > iTrace, 'the trace is written BEFORE deleting');
    const ins = e.sqls.find(q => /INSERT INTO deleted_invoices/.test(q.sql));
    assert.equal(ins.args[10], 7, 'deleted_by comes from the session'); assert.equal(ins.args[8], 2); assert.equal(ins.args[9], 1);
    assert.ok(e.sqls.some(q => q.sql === 'COMMIT'));
});

test('delete invoice: if it already generated stock-ins, 409 and nothing is touched', async t => {
    const e = await setup(t, { n: { lines: 3, stock_ins: 2, files: 1 } });
    const r = await e.remove('/4');
    assert.equal(r.status, 409); assert.equal(r.body.error_code, 'has_stock_ins'); assert.equal(r.body.stock_ins, 2);
    assert.match(r.body.error, /adjustment/);
    assert.ok(!e.sqls.some(q => /DELETE FROM invoices|INSERT INTO deleted_invoices/.test(q.sql)));
    assert.ok(e.sqls.some(q => q.sql === 'ROLLBACK'));
});
