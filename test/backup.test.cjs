const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../index');
const { lastBackup } = require('../backups');

// Downloading the latest backup is admin only (it holds the whole database) and every download is logged.
// Uses the REAL identity (`requireSession`), not a double.

function folder(t, names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lupo-backups-'));
    for (const n of names) fs.writeFileSync(path.join(dir, n), `contents of ${n}`);
    process.env.LUPO_BACKUPS = dir;
    t.after(() => { delete process.env.LUPO_BACKUPS; fs.rmSync(dir, { recursive: true, force: true }); });
    return dir;
}

async function setup(t, role, { fails = false } = {}) {
    const queries = [];
    const pool = {
        async query(sql, params) {
            queries.push({ sql, params });
            if (/FROM sessions s\s+JOIN users u/.test(sql)) return { rows: [{ id: 9, name: 'Whoever', role, must_change_password: false }] };
            if (/INSERT INTO user_audit_log/.test(sql) && fails) throw new Error('audit log down');
            return { rows: [], rowCount: 0 };
        },
    };
    const server = createApp(pool).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const download = () => fetch(`http://127.0.0.1:${server.address().port}/api/admin/backup`, { headers: { Authorization: 'Bearer t' } });
    return { download, logged: () => queries.filter(c => /INSERT INTO user_audit_log/.test(c.sql)) };
}

test('lastBackup: the newest by name, and only daily-backup names', t => {
    const dir = folder(t, [
        'inventory-2026-10-13_0300.dump', 'inventory-2026-10-14_0300.dump',
        'before-upgrade-2026-10-15_090000.dump', 'inventory-2026-10-15_0300.dump.tmp', 'notes.txt',
    ]);
    assert.equal(lastBackup(dir), 'inventory-2026-10-14_0300.dump');
    assert.equal(lastBackup(path.join(dir, 'does-not-exist')), null);
});

test('the admin downloads the latest backup and it is logged under their name', async t => {
    folder(t, ['inventory-2026-10-13_0300.dump', 'inventory-2026-10-14_0300.dump']);
    const e = await setup(t, 'admin');
    const r = await e.download();
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="inventory-2026-10-14_0300\.dump"/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(await r.text(), 'contents of inventory-2026-10-14_0300.dump');
    const [entry] = e.logged();
    assert.deepEqual(entry.params, [9, 9, 'backup', 'inventory-2026-10-14_0300.dump']);
});

test('operator, storekeeper and technician bounce without touching the folder or the audit log', async t => {
    folder(t, ['inventory-2026-10-14_0300.dump']);
    for (const role of ['operator', 'storekeeper', 'technician']) {
        const e = await setup(t, role);
        assert.equal((await e.download()).status, 403, role);
        assert.deepEqual(e.logged(), [], role);
    }
});

test('no backups in the folder: a 404 that says so, nothing logged', async t => {
    folder(t, ['notes.txt']);
    const e = await setup(t, 'admin');
    const r = await e.download();
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /no backup available/);
    assert.deepEqual(e.logged(), []);
});

test('if the audit log cannot be written, the file is not delivered', async t => {
    folder(t, ['inventory-2026-10-14_0300.dump']);
    const e = await setup(t, 'admin', { fails: true });
    const r = await e.download();
    assert.equal(r.status, 500);
    assert.doesNotMatch(await r.text(), /contents of/);
});
