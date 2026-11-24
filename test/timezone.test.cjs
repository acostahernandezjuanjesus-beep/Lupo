const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Each connection's time zone: the dashboard's "today" comes from `now()` in the database, and a managed
// database (RDS) defaults to UTC. Without pinning the zone per connection, the storeroom's day would start
// at 18:00 Mexico City time and the dashboard would empty every afternoon.
//
// Needs a DISPOSABLE server (LUPO_TEST_ADMIN_URL). In CI it runs against the official PostgreSQL image,
// which starts in UTC, so there the test tells before from after.

const ADMIN = process.env.LUPO_TEST_ADMIN_URL;
const skip = ADMIN ? false : 'LUPO_TEST_ADMIN_URL is not set (a disposable PostgreSQL is needed)';
const root = path.join(__dirname, '..');

// db.js reads the environment when loaded: test it in a separate process with whatever environment is wanted.
function query(env) {
    const out = execFileSync(process.execPath, ['-e', `
        const pool = require('./db');
        pool.query("SELECT current_setting('TimeZone') AS zone, current_setting('statement_timeout') AS cap, date_trunc('day', timestamptz '2026-10-05 20:00-06')::text AS day")
            .then(r => { console.log(JSON.stringify(r.rows[0])); return pool.end(); });
    `], { cwd: root, env: { PATH: process.env.PATH, DATABASE_URL: ADMIN, ...env }, encoding: 'utf8' });
    return JSON.parse(out.trim().split('\n').pop());
}

test('the storeroom day starts at midnight Mexico City time, whatever the server zone', { skip }, () => {
    const r = query({ TZ: 'America/Mexico_City' });
    assert.equal(r.zone, 'America/Mexico_City');
    // 20:00 on 5 Oct in Mexico City: the day started at 00:00 on 5 Oct (UTC-6), not at 18:00
    assert.equal(r.day, '2026-10-05 00:00:00-06');
});

test('without TZ in the environment, America/Mexico_City is used', { skip }, () => {
    assert.equal(query({}).zone, 'America/Mexico_City');
});

test('a TZ with extra options does not slip through to the server', { skip }, () => {
    const r = query({ TZ: 'UTC -c statement_timeout=1' });
    assert.equal(r.zone, 'America/Mexico_City');
    assert.equal(r.cap, '30s');
});
