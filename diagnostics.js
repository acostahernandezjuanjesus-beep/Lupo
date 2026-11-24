// GET /api/admin/diagnostics (admin and technician): system status, never passwords, keys or business data.
// What isn't known is said so (`null`, `no_record`) rather than reported as fine.

const path = require('node:path');
const { lastBackupInfo } = require('./backups');
const { list } = require('./migrate');
const pkg = require('./package.json');
const { fail } = require('./util');

// One backup a day: after 36 h without a new one, something failed.
const BACKUP_LATE_HOURS = 36;

module.exports = pool => async (req, res) => {
    try {
        const t0 = process.hrtime.bigint();
        const { rows: [d] } = await pool.query(`
            SELECT version() AS pg, pg_database_size(current_database())::bigint AS bytes, now() AS now,
                   (SELECT count(*) FROM sessions WHERE closed_at IS NULL AND expires_at > now())::int AS active_sessions,
                   (SELECT count(*) FROM users WHERE active)::int AS active_users,
                   to_regclass('public.schema_migrations') IS NOT NULL AS has_registry,
                   to_regclass('public.backups') IS NOT NULL AS has_backups`);
        const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

        let migrations = { registry: false, applied: null, pending: null };
        if (d.has_registry) {
            const { rows } = await pool.query('SELECT version FROM schema_migrations');
            const done = new Set(rows.map(r => r.version));
            migrations = {
                registry: true,
                applied: done.size,
                pending: list(path.join(__dirname, 'db'))
                    .filter(m => !done.has(m.version)).map(m => m.file),
            };
        }

        let backup = { status: process.env.LUPO_BACKUPS ? 'no_record' : 'unconfigured', last_at: null, hours_ago: null, file: null, bytes: null };
        if (d.has_backups) {
            const { rows: [r] } = await pool.query(
                `SELECT done_at, file, bytes::text AS bytes, round((extract(epoch FROM now() - done_at) / 3600)::numeric, 1)::float AS hours
                   FROM backups ORDER BY done_at DESC LIMIT 1`);
            if (r) {
                backup = {
                    status: r.hours >= BACKUP_LATE_HOURS ? 'late' : 'ok',
                    last_at: r.done_at, hours_ago: r.hours, file: r.file, bytes: r.bytes,
                };
            }
        }
        if (backup.status === 'no_record') {
            const file = lastBackupInfo();
            if (file) {
                backup = {
                    status: file.hours >= BACKUP_LATE_HOURS ? 'late' : 'ok',
                    last_at: file.done_at, hours_ago: file.hours, file: file.file, bytes: file.bytes,
                };
            }
        }

        res.json({
            version: process.env.LUPO_VERSION || pkg.version,
            node: process.version,
            server_time: d.now,
            uptime_s: Math.round(process.uptime()),
            database: {
                version: String(d.pg).split(' ').slice(0, 2).join(' '),
                response_ms: ms,
                size_bytes: d.bytes,
                connections: { total: pool.totalCount ?? null, idle: pool.idleCount ?? null, waiting: pool.waitingCount ?? null },
            },
            migrations,
            backup,
            active_sessions: d.active_sessions,
            active_users: d.active_users,
            config: {
                ai_reader: Boolean(process.env.DEEPSEEK_API_KEY),
                proxy_hops: Number(process.env.LUPO_PROXY ?? 0),
                migrate_on_start: process.env.LUPO_MIGRATE === '1',
            },
        });
    } catch (err) {
        fail(req, res, err, 'Error reading the diagnostics');
    }
};
