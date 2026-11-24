const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client, Pool } = require('pg');
const { applyPending, list } = require('../migrate');
const { purgeSessions } = require('../operations');

// Runs against a disposable server (LUPO_TEST_ADMIN_URL), skipped without it.

const ADMIN = process.env.LUPO_TEST_ADMIN_URL;
const skip = ADMIN ? false : 'LUPO_TEST_ADMIN_URL is not set (needs a disposable PostgreSQL)';
const DB = n => `lupo_test_${process.pid}_${n}`;
const urlFor = name => { const u = new URL(ADMIN); u.pathname = `/${name}`; return u.toString(); };
const created = [], pools = [], dirs = [];
const quiet = { log() {} };

async function admin(sql) {
    const c = new Client({ connectionString: ADMIN });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}
async function freshDb(name) {
    await admin(`CREATE DATABASE ${name}`);
    created.push(name);
    const pool = new Pool({ connectionString: urlFor(name), max: 4 });
    pools.push(pool);
    return pool;
}
function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lupo-mig-'));
    dirs.push(dir);
    return dir;
}
const exists = async (pool, t) => (await pool.query(`SELECT to_regclass('public.${t}') IS NOT NULL AS ok`)).rows[0].ok;

after(async () => {
    if (skip) return;
    await Promise.all(pools.map(p => p.end().catch(() => {})));
    for (const n of created) await admin(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`).catch(() => {});
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('list returns numbered migrations sorted and ignores other files', () => {
    const dir = tempDir();
    for (const f of ['010_b.sql', '002_a.sql', 'schema.sql', 'seed.sql', '3_bad.sql', '004_x.txt']) fs.writeFileSync(path.join(dir, f), '');
    assert.deepEqual(list(dir), [{ version: 2, file: '002_a.sql' }, { version: 10, file: '010_b.sql' }]);
});

test('an empty database gets schema and seed, recorded as version 0', { skip }, async () => {
    const pool = await freshDb(DB('a'));
    const r = await applyPending(pool, quiet);
    assert.deepEqual(r, { applied: ['schema.sql', ...list(path.join(__dirname, '..', 'db')).map(m => m.file)], already: 0 });

    const { rows } = await pool.query('SELECT version, file, origin FROM schema_migrations ORDER BY version');
    assert.deepEqual(rows[0], { version: 0, file: 'schema.sql', origin: 'runner' });

    const { rows: [n] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
               (SELECT count(*)::int FROM categories) AS categories,
               (SELECT count(*)::int FROM supplier_tags) AS tags,
               (SELECT count(*)::int FROM products) AS products,
               (SELECT count(*)::int FROM users) AS users`);
    assert.deepEqual(n, { tables: 27, categories: 31, tags: 15, products: 0, users: 0 });

    // the category sequence starts after the explicit ids
    const { rows: [c] } = await pool.query(`INSERT INTO categories (name) VALUES ('Test category') RETURNING id`);
    assert.equal(c.id, 33);
    assert.equal((await pool.query(`SELECT name_norm FROM supplier_tags WHERE name = 'Cutting tools'`)).rows[0].name_norm, 'cutting tools');

    // also proves search_path was left alone: these are unqualified, on the same pooled connections
    const { rows: [u] } = await pool.query(`INSERT INTO users (name, username) VALUES ('Support', 'support') RETURNING role`);
    assert.equal(u.role, 'operator');
    const { rows: [p] } = await pool.query(
        `INSERT INTO products (code, name) VALUES ('T-1', 'Test') RETURNING unit, control_type, restock_control`);
    assert.deepEqual(p, { unit: 'piece', control_type: 'stock', restock_control: 'calculated' });
});

test('the second run is a no-op', { skip }, async () => {
    const pool = await freshDb(DB('b'));
    const first = await applyPending(pool, quiet);
    assert.deepEqual(await applyPending(pool, quiet), { applied: [], already: first.applied.length });
});

test('two runs at once install the schema only once (advisory lock)', { skip }, async () => {
    const pool = await freshDb(DB('c'));
    const [x, y] = await Promise.all([applyPending(pool, quiet), applyPending(pool, quiet)]);
    assert.deepEqual([...x.applied, ...y.applied].filter(f => f === 'schema.sql'), ['schema.sql']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM categories')).rows[0].n, 31);
});

test('a new numbered migration is applied once and recorded', { skip }, async () => {
    const pool = await freshDb(DB('d'));
    const dir = tempDir();
    await applyPending(pool, { dir, ...quiet });

    fs.writeFileSync(path.join(dir, '043_widgets.sql'), 'BEGIN; CREATE TABLE widgets (x int); COMMIT;');
    assert.deepEqual((await applyPending(pool, { dir, ...quiet })).applied, ['043_widgets.sql']);
    assert.equal(await exists(pool, 'widgets'), true);
    const { rows } = await pool.query('SELECT file, origin FROM schema_migrations WHERE version = 43');
    assert.deepEqual(rows, [{ file: '043_widgets.sql', origin: 'runner' }]);

    assert.deepEqual((await applyPending(pool, { dir, ...quiet })).applied, []);
});

test('a failing migration stops with its name, is not recorded and leaves nothing half-done', { skip }, async () => {
    const pool = await freshDb(DB('e'));
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, '100_good.sql'), 'BEGIN; CREATE TABLE test_a (x int); COMMIT;');
    fs.writeFileSync(path.join(dir, '101_bad.sql'), 'BEGIN; CREATE TABLE test_b (x int); SELECT 1/0; COMMIT;');
    await assert.rejects(applyPending(pool, { dir, ...quiet }), /101_bad\.sql failed/);
    assert.equal(await exists(pool, 'test_a'), true);
    assert.equal(await exists(pool, 'test_b'), false, 'the bad one rolled back');
    assert.deepEqual((await pool.query('SELECT version FROM schema_migrations WHERE version > 0 ORDER BY 1')).rows.map(r => r.version), [100]);

    // once fixed it goes in; the good one is not repeated
    fs.writeFileSync(path.join(dir, '101_bad.sql'), 'BEGIN; CREATE TABLE test_b (x int); COMMIT;');
    assert.deepEqual((await applyPending(pool, { dir, ...quiet })).applied, ['101_bad.sql']);
});

test('a database with tables but no migration log is refused, not guessed at', { skip }, async () => {
    const pool = await freshDb(DB('f'));
    await pool.query('CREATE TABLE users (id int)');
    await assert.rejects(applyPending(pool, quiet), /no schema_migrations/);
    assert.equal(await exists(pool, 'products'), false);
});

test('purgeSessions deletes what expired or closed over a week ago and keeps the rest', { skip }, async () => {
    const pool = await freshDb(DB('g'));
    await applyPending(pool, quiet);
    const { rows: [u] } = await pool.query(`INSERT INTO users (name, username) VALUES ('Ana', 'ana') RETURNING id`);
    const session = (hash, createdAgo, expiresAgo, closedAgo) => pool.query(
        `INSERT INTO sessions (user_id, token_hash, created_at, expires_at, closed_at)
         VALUES ($1, $2, now() - $3::interval, now() - $4::interval, now() - $5::interval)`,
        [u.id, hash, createdAgo, expiresAgo, closedAgo ?? null]);
    await session('expired_8_days_ago', '20 days', '8 days');
    await session('closed_9_days_ago', '20 days', '-1 day', '9 days');
    await session('expired_yesterday', '3 days', '1 day');
    await session('live', '1 hour', '-11 hours');
    assert.equal(await purgeSessions(pool), 2);
    const { rows } = await pool.query('SELECT token_hash FROM sessions ORDER BY token_hash');
    assert.deepEqual(rows.map(r => r.token_hash), ['expired_yesterday', 'live']);
});
