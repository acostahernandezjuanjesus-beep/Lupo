// A disposable database with the full schema, for tests that need real PostgreSQL behaviour.
// Lives in scripts/ because `node --test` runs every file in test/.
//
// Needs a throwaway server: LUPO_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres.
// It only ever creates and drops its own `lupo_test_*` databases.

const { Client, Pool } = require('pg');
const { applyPending } = require('../migrate');

const ADMIN = process.env.LUPO_TEST_ADMIN_URL;
const skip = ADMIN ? false : 'LUPO_TEST_ADMIN_URL is not set (needs a disposable PostgreSQL)';
const urlFor = name => { const u = new URL(ADMIN); u.pathname = `/${name}`; return u.toString(); };

async function admin(sql) {
    const c = new Client({ connectionString: ADMIN });
    await c.connect();
    try { await c.query(sql); } finally { await c.end(); }
}

/** Creates a database with schema + seed applied. Returns `{ pool, close }`. */
async function createDb(suffix) {
    const name = `lupo_test_${process.pid}_${suffix}`;
    await admin(`CREATE DATABASE ${name}`);
    const pool = new Pool({ connectionString: urlFor(name), max: 4 });
    const close = async () => {
        await pool.end().catch(() => {});
        await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    };
    try {
        await applyPending(pool, { log: () => {} });
    } catch (err) {
        await close();
        throw err;
    }
    return { pool, close };
}

module.exports = { skip, createDb };
