const fs = require('node:fs');
const path = require('node:path');

const DB_DIR = path.join(__dirname, 'db');
const LOCK_KEY = 7_300_029;         // any fixed number, for pg_advisory_lock

/** Numbered migrations in `dir`, sorted: [{ version, file }]. */
function list(dir) {
    return fs.readdirSync(dir)
        .map(file => ({ file, m: /^(\d{3})_.+\.sql$/.exec(file) }))
        .filter(x => x.m)
        .map(x => ({ version: Number(x.m[1]), file: x.file }))
        .sort((a, b) => a.version - b.version);
}

/**
 * Installs schema + seed on an empty database, then applies pending db/NNN_*.sql.
 * Returns { applied: [file...], already: n }.
 */
async function applyPending(pool, { dir = DB_DIR, log = console.log } = {}) {
    const client = await pool.connect();
    try {
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        const applied = [];

        const { rows: [state] } = await client.query(`
            SELECT to_regclass('public.users') IS NOT NULL AS has_schema,
                   to_regclass('public.schema_migrations') IS NOT NULL AS has_log`);
        if (!state.has_schema) {
            const read = f => fs.readFileSync(path.join(DB_DIR, f), 'utf8');
            try {
                await client.query('BEGIN');
                await client.query(read('schema.sql'));
                await client.query(read('seed.sql'));
                await client.query(`INSERT INTO schema_migrations (version, file, origin) VALUES (0, 'schema.sql', 'runner')`);
                await client.query('COMMIT');
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch { /* connection is gone */ }
                throw new Error(`Installing schema.sql failed: ${err.message}`, { cause: err });
            }
            applied.push('schema.sql');
            log('migrations: installed schema.sql and seed.sql');
        } else if (!state.has_log) {
            throw new Error('The database has a users table but no schema_migrations: it was not set up by this runner.');
        }

        const { rows } = await client.query('SELECT version FROM schema_migrations');
        const done = new Set(rows.map(r => r.version));
        const already = done.size - applied.length;

        for (const m of list(dir).filter(m => !done.has(m.version))) {
            // Each file carries its own BEGIN/COMMIT, so a failure leaves the database as it was.
            const sql = fs.readFileSync(path.join(dir, m.file), 'utf8');
            try {
                await client.query(sql);
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch { /* no transaction left */ }
                throw new Error(`Migration ${m.file} failed and was not applied: ${err.message}`, { cause: err });
            }
            await client.query('INSERT INTO schema_migrations (version, file) VALUES ($1, $2)', [m.version, m.file]);
            applied.push(m.file);
            log(`migrations: applied ${m.file}`);
        }
        return { applied, already };
    } finally {
        try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch { /* dead connection drops the lock anyway */ }
        client.release();
    }
}

module.exports = { applyPending, list };
