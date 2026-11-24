const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// The `technician` role (remote maintenance) and the system diagnostics.
// Uses the REAL identity (`requireSession`), not a double: that allow-list is exactly what is tested.
// The technician sees system status and the user audit log; nothing from the storeroom.

async function setup(t, role, { backup = undefined, hasBackups = true, accessLog = null } = {}) {
    const queries = [];
    const pool = {
        totalCount: 3, idleCount: 2, waitingCount: 0,
        async query(sql) {
            queries.push(sql);
            if (/FROM sessions s\s+JOIN users u/.test(sql)) return { rows: [{ id: 9, name: 'Support', role, must_change_password: false }] };
            if (/version\(\) AS pg/.test(sql)) {
                return { rows: [{ pg: 'PostgreSQL 18.4 on x86_64', bytes: '1048576', now: '2026-10-05T12:00:00Z', active_sessions: 2, active_users: 5,
                    has_registry: true, has_backups: hasBackups }] };
            }
            if (/FROM schema_migrations/.test(sql)) return { rows: [{ version: 0 }, { version: 1 }] };
            if (/FROM backups/.test(sql)) return { rows: backup ? [backup] : [] };
            return { rows: [], rowCount: 0 };
        },
        async connect() { return { query: this.query.bind(this), release() {} }; },
    };
    const server = createApp(pool, undefined, { accessLog }).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, method = 'GET', body) => {
        const r = await fetch(base + path, { method, headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { request, queries };
}

test('technician: can see who they are, the diagnostics, the audit log and the user list', async t => {
    const e = await setup(t, 'technician');
    for (const path of ['/api/session', '/api/admin/diagnostics', '/api/admin/audit-log', '/api/admin/users']) {
        assert.equal((await e.request(path)).status, 200, path);
    }
});

test('technician: NOTHING from the storeroom — no inventory, prices, purchases, movements, or writing users', async t => {
    const e = await setup(t, 'technician');
    const forbidden = [
        ['GET', '/api/products'], ['GET', '/api/products/by-code?code=1'], ['GET', '/api/products/1/purchases'], ['GET', '/api/categories'],
        ['GET', '/api/locations'], ['GET', '/api/summary'], ['GET', '/api/users'], ['GET', '/api/movements'], ['GET', '/api/requisition'],
        ['GET', '/api/purchases/books'], ['GET', '/api/purchases/summary'], ['GET', '/api/invoices'], ['GET', '/api/invoices/files/1'],
        ['POST', '/api/movements', { product_id: 1, type: 'out', quantity: 1 }], ['POST', '/api/products', { code: 'X', name: 'x' }],
        ['PATCH', '/api/products/1/control', { control_type: 'stock' }], ['POST', '/api/invoices/read-photo', {}],
        ['POST', '/api/admin/users', { name: 'Other', role: 'admin' }], ['PATCH', '/api/admin/users/1', { role: 'admin' }],
        ['POST', '/api/admin/users/1/password', {}], ['POST', '/api/admin/users/1/unlock'],
    ];
    for (const [method, path, body] of forbidden) {
        const r = await e.request(path, method, body);
        assert.equal(r.status, 403, `${method} ${path}`);
        assert.equal(r.body.error_code, 'no_permission', `${method} ${path}`);
    }
    // and it touched no data: the only thing queried was the session
    const data = e.queries.filter(s => !/FROM sessions s\s+JOIN users u/.test(s) && !/version\(\) AS pg|schema_migrations|FROM backups|user_audit_log|FROM users u/.test(s));
    assert.deepEqual(data, []);
});

test('technician cannot take a higher role: creating or changing roles is admin only', async t => {
    const e = await setup(t, 'technician');
    assert.equal((await e.request('/api/admin/users/9', 'PATCH', { role: 'admin' })).status, 403);
    assert.equal(e.queries.some(s => /UPDATE users SET role/.test(s)), false);
});

test('operator and storekeeper still cannot see the diagnostics; the admin can', async t => {
    for (const [role, expected] of [['operator', 403], ['storekeeper', 403], ['admin', 200]]) {
        const e = await setup(t, role);
        assert.equal((await e.request('/api/admin/diagnostics')).status, expected, role);
    }
});

test('"who takes it" does not offer the technician', async t => {
    const e = await setup(t, 'admin');
    await e.request('/api/users');
    assert.ok(e.queries.some(s => /FROM users\s+WHERE active.*role <> 'technician'/s.test(s)));
});

test('diagnostics: shape, no secrets, and the backup tells the truth', async t => {
    const prev = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'sk-must-not-leak';
    t.after(() => { if (prev === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = prev; });

    const recent = await setup(t, 'admin', { backup: { done_at: '2026-10-05T07:00:00Z', file: '/backups/a.dump', bytes: '2048', hours: 5 } });
    const d = (await recent.request('/api/admin/diagnostics')).body;
    assert.equal(d.backup.status, 'ok');
    assert.equal(d.backup.hours_ago, 5);
    assert.deepEqual(d.migrations, { registry: true, applied: 2, pending: d.migrations.pending });
    assert.ok(d.migrations.pending.every(a => /^\d{3}_.+\.sql$/.test(a)), 'only numbered migration files');
    assert.equal(d.database.version, 'PostgreSQL 18.4');
    assert.deepEqual(d.database.connections, { total: 3, idle: 2, waiting: 0 });
    assert.equal(d.config.ai_reader, true);
    assert.doesNotMatch(JSON.stringify(d), /sk-must-not-leak|password|token/i);

    const late = await setup(t, 'admin', { backup: { done_at: '2026-10-03T00:00:00Z', file: 'x', bytes: '1', hours: 60 } });
    assert.equal((await late.request('/api/admin/diagnostics')).body.backup.status, 'late');

    // without LUPO_BACKUPS and no DB row, backups are unconfigured; with LUPO_BACKUPS set and empty, no_record
    const prevBackups = process.env.LUPO_BACKUPS;
    delete process.env.LUPO_BACKUPS;
    t.after(() => { if (prevBackups === undefined) delete process.env.LUPO_BACKUPS; else process.env.LUPO_BACKUPS = prevBackups; });
    for (const options of [{ backup: null }, { hasBackups: false }]) {
        const e = await setup(t, 'admin', options);
        const r = (await e.request('/api/admin/diagnostics')).body.backup;
        assert.equal(r.status, 'unconfigured');
        assert.equal(r.hours_ago, null);
    }
    process.env.LUPO_BACKUPS = '/path/that/does/not/exist';
    const missing = await setup(t, 'admin', { backup: null });
    assert.equal((await missing.request('/api/admin/diagnostics')).body.backup.status, 'no_record');
});

test('a denied attempt stays in the access log WITH its author', async t => {
    const lines = [];
    const e = await setup(t, 'technician', { accessLog: l => lines.push(JSON.parse(l)) });
    assert.equal((await e.request('/api/products')).status, 403);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual([lines[0].path, lines[0].s, lines[0].u], ['/api/products', 403, 9]);
});

test('an id bigger than a PostgreSQL integer is a 400, not a 500 (administration and invoices)', async t => {
    const e = await setup(t, 'admin');
    for (const [method, path] of [['POST', '/api/admin/users/99999999999/password'], ['PATCH', '/api/admin/users/99999999999'],
        ['POST', '/api/admin/users/99999999999/unlock'], ['GET', '/api/invoices/99999999999'], ['GET', '/api/invoices/99999999999/reconciliation']]) {
        const r = await e.request(path, method, method === 'PATCH' ? { active: true } : undefined);
        assert.equal(r.status, 400, `${method} ${path}`);
    }
});
