// User administration. Everything here needs an `admin` session (technicians may read).
// Business rule worth isolating: never be left without an active admin.

const express = require('express');
const auth = require('./auth');

const { ROLES, RE_USERNAME, suggestedUsername } = auth;
const { toPositiveInt, safeRollback, fail } = require('./util');
const path = require('node:path');
const { lastBackup, folder } = require('./backups');

/**
 * Decides the TEMPORARY password to use: the one the admin typed, or a generated one. Either way the
 * person changes it on first login. -> { value } or { error }
 */
function checkPassword(password, person = {}) {
    if (password === undefined || password === null || password === '') {
        return { value: auth.randomPassword() };
    }
    const problem = auth.passwordProblem(password, person);
    if (problem) return { error: problem };
    return { value: password };
}

async function record(client, userId, actorId, action, detail = null) {
    await client.query(
        `INSERT INTO user_audit_log (user_id, actor_id, action, detail)
         VALUES ($1, $2, $3, $4)`,
        [userId, actorId, action, detail]
    );
}

// FOR UPDATE matters: without it two admins demoting each other at once both pass the check and leave no admin.
async function activeAdmins(client) {
    const { rows } = await client.query(
        `SELECT id FROM users WHERE role = 'admin' AND active FOR UPDATE`
    );
    return rows.map(r => r.id);
}

module.exports = function createAdminRoutes(pool) {
    const router = express.Router();

    // Reading is for admin and technician (auth.js limits the technician to three GET routes); writing is admin only.
    const read = auth.requireRole('admin', 'technician'), write = auth.requireRole('admin');
    router.use(auth.requireSession(pool), (req, res, next) => (req.method === 'GET' ? read : write)(req, res, next));

    router.get('/diagnostics', require('./diagnostics')(pool));

    // The newest backup. It holds the WHOLE database (password hashes included): admin only, and every
    // download is logged BEFORE it is sent; if it can't be logged, it isn't served.
    router.get('/backup', auth.requireRole('admin'), async (req, res) => {
        const dir = folder(), name = lastBackup(dir);
        if (!name) return res.status(404).json({ error: 'There is no backup available' });
        try {
            await record(pool, req.user.id, req.user.id, 'backup', name);
            res.set('Cache-Control', 'no-store');
            res.download(path.join(dir, name), name, err => {
                if (err && !res.headersSent) fail(req, res, err, 'Could not read the backup');
            });
        } catch (err) {
            fail(req, res, err, 'Could not prepare the backup');
        }
    });

    router.get('/users', async (req, res) => {
        try {
            const { rows } = await pool.query(
                `SELECT u.id, u.name, u.username, u.role, u.active,
                        (u.password_hash IS NOT NULL)           AS has_password,
                        -- whether the password is still the admin's temporary one (never the password itself)
                        u.must_change_password,
                        u.password_changed_at,
                        u.temp_password_until,
                        (u.must_change_password AND u.temp_password_until < now()) AS temp_expired,
                        (u.locked_until > now())                AS locked,
                        u.locked_until,
                        u.created_at,
                        (SELECT count(*) FROM movements m
                          WHERE m.user_id = u.id)::int           AS movements,
                        (SELECT count(*) FROM sessions s
                          WHERE s.user_id = u.id
                            AND s.closed_at IS NULL
                            AND s.expires_at > now())::int       AS sessions
                   FROM users u
                  ORDER BY u.active DESC, u.name`
            );
            res.json(rows);
        } catch (err) {
            fail(req, res, err, 'Error reading users');
        }
    });

    router.post('/users', async (req, res) => {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        const role = req.body.role ?? 'operator';
        const { password } = req.body;

        if (!name) return res.status(400).json({ error: 'The name is required' });
        if (!ROLES.includes(role)) {
            return res.status(400).json({ error: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
        }
        // lowercase, no spaces; derived from the name when not given
        const username = (typeof req.body.username === 'string' && req.body.username.trim() !== ''
            ? req.body.username.trim() : suggestedUsername(name)).toLowerCase();
        if (!RE_USERNAME.test(username)) {
            return res.status(400).json({ error: 'The username must be 2 to 30 characters: unaccented letters, digits, dot, hyphen or underscore' });
        }

        // The password is TEMPORARY either way: the person changes it on first login.
        const chosen = checkPassword(password, { username, name });
        if (chosen.error) return res.status(400).json({ error: chosen.error });
        const finalPassword = chosen.value;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const hash = await auth.hashPassword(finalPassword);
            const { rows } = await client.query(
                `INSERT INTO users (name, username, role, password_hash, must_change_password, temp_password_until)
                 VALUES ($1, $2, $3, $4, true, now() + ($5 || ' hours')::interval)
                 RETURNING id, name, username, role, active, temp_password_until`,
                [name, username, role, hash, auth.TEMP_PASSWORD_HOURS]
            );
            await record(client, rows[0].id, req.user.id, 'create', `role ${role}, username ${username}`);
            await client.query('COMMIT');

            // the password travels once, here
            res.status(201).json({ user: rows[0], password: finalPassword });
        } catch (err) {
            await safeRollback(client);
            if (err.code === '23505') return res.status(409).json({ error: `The username "${username}" already exists`, error_code: 'username_taken' });
            fail(req, res, err, 'Error creating the user');
        } finally {
            client.release();
        }
    });

    router.patch('/users/:id', async (req, res) => {
        const id = toPositiveInt(req.params.id);
        if (id === null) return res.status(400).json({ error: 'Invalid id' });

        const { role, active } = req.body;
        if (role === undefined && active === undefined) {
            return res.status(400).json({ error: 'Nothing to change' });
        }
        if (role !== undefined && !ROLES.includes(role)) {
            return res.status(400).json({ error: `Invalid role. Must be one of: ${ROLES.join(', ')}` });
        }
        if (active !== undefined && typeof active !== 'boolean') {
            return res.status(400).json({ error: 'active must be true or false' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const { rows: before } = await client.query(
                'SELECT id, name, role, active FROM users WHERE id = $1 FOR UPDATE', [id]
            );
            if (before.length === 0) {
                await safeRollback(client);
                return res.status(404).json({ error: 'That user does not exist' });
            }
            const u = before[0];

            // Never leave the system without an active admin: nobody could get in to fix it.
            const stopsBeingAdmin =
                (role !== undefined && u.role === 'admin' && role !== 'admin') ||
                (active === false && u.role === 'admin' && u.active);

            if (stopsBeingAdmin) {
                const admins = await activeAdmins(client);
                if (admins.length <= 1) {
                    await safeRollback(client);
                    return res.status(409).json({
                        error: "This is the only active admin. Name another one before removing the role.",
                        error_code: 'last_admin',
                    });
                }
            }

            if (role !== undefined && role !== u.role) {
                await client.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
                await record(client, id, req.user.id, 'role', `${u.role} → ${role}`);
            }

            if (active !== undefined && active !== u.active) {
                await client.query('UPDATE users SET active = $1 WHERE id = $2', [active, id]);
                if (!active) {
                    // deactivating must take effect now, not when the token expires
                    const { rowCount } = await client.query(
                        `UPDATE sessions SET closed_at = now()
                          WHERE user_id = $1 AND closed_at IS NULL`, [id]
                    );
                    await record(client, id, req.user.id, 'deactivate', `${rowCount} session(s) closed`);
                } else {
                    await record(client, id, req.user.id, 'reactivate');
                }
            }

            const { rows } = await client.query(
                'SELECT id, name, role, active FROM users WHERE id = $1', [id]
            );
            await client.query('COMMIT');
            res.json(rows[0]);
        } catch (err) {
            await safeRollback(client);
            fail(req, res, err, 'Error updating the user');
        } finally {
            client.release();
        }
    });

    router.post('/users/:id/password', async (req, res) => {
        const id = toPositiveInt(req.params.id);
        if (id === null) return res.status(400).json({ error: 'Invalid id' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const { rows: u } = await client.query(
                'SELECT id, name, username FROM users WHERE id = $1 FOR UPDATE', [id]
            );
            if (u.length === 0) {
                await safeRollback(client);
                return res.status(404).json({ error: 'That user does not exist' });
            }
            const chosen = checkPassword(req.body.password, { username: u[0].username, name: u[0].name });
            if (chosen.error) {
                await safeRollback(client);
                return res.status(400).json({ error: chosen.error });
            }
            const finalPassword = chosen.value;

            const hash = await auth.hashPassword(finalPassword);
            await client.query(
                // temporary again; password_changed_at back to NULL so the admin sees it hasn't been changed yet
                `UPDATE users
                    SET password_hash = $1, failed_attempts = 0, locked_until = NULL,
                        must_change_password = true, password_changed_at = NULL,
                        temp_password_until = now() + ($3 || ' hours')::interval
                  WHERE id = $2`,
                [hash, id, auth.TEMP_PASSWORD_HOURS]
            );

            // If it's being reassigned because it leaked, old sessions must not survive.
            const { rowCount } = await client.query(
                `UPDATE sessions SET closed_at = now()
                  WHERE user_id = $1 AND closed_at IS NULL`, [id]
            );

            await record(client, id, req.user.id, 'password',
                req.body.password ? `set by the admin, ${rowCount} session(s) closed`
                    : `generated, ${rowCount} session(s) closed`);

            await client.query('COMMIT');
            res.json({ user: { id, name: u[0].name, username: u[0].username }, password: finalPassword });
        } catch (err) {
            await safeRollback(client);
            fail(req, res, err, 'Error reassigning the password');
        } finally {
            client.release();
        }
    });

    router.post('/users/:id/unlock', async (req, res) => {
        const id = toPositiveInt(req.params.id);
        if (id === null) return res.status(400).json({ error: 'Invalid id' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(
                `UPDATE users SET failed_attempts = 0, locked_until = NULL
                  WHERE id = $1 RETURNING id, name`, [id]
            );
            if (rows.length === 0) {
                await safeRollback(client);
                return res.status(404).json({ error: 'That user does not exist' });
            }
            await record(client, id, req.user.id, 'unlock');
            await client.query('COMMIT');
            res.json(rows[0]);
        } catch (err) {
            await safeRollback(client);
            fail(req, res, err, 'Error unlocking');
        } finally {
            client.release();
        }
    });

    router.get('/audit-log', async (req, res) => {
        const userId = req.query.user_id ? toPositiveInt(req.query.user_id) : null;
        if (req.query.user_id && userId === null) {
            return res.status(400).json({ error: 'Invalid user_id' });
        }
        try {
            const { rows } = await pool.query(
                `SELECT b.id, b.action, b.detail, b.date,
                        b.user_id, u.name AS user_name,
                        b.actor_id, a.name AS actor
                   FROM user_audit_log b
                   JOIN users u ON u.id = b.user_id
                   LEFT JOIN users a ON a.id = b.actor_id
                  ${userId ? 'WHERE b.user_id = $1' : ''}
                  ORDER BY b.date DESC, b.id DESC
                  LIMIT 200`,
                userId ? [userId] : []
            );
            res.json(rows);
        } catch (err) {
            fail(req, res, err, 'Error reading the audit log');
        }
    });

    return router;
};
