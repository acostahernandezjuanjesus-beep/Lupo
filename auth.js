// Passwords, sessions and login throttling. scrypt and randomBytes come with node:crypto: bcrypt/argon2 compile native code.

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { safeRollback } = require('./util');

const scrypt = promisify(crypto.scrypt);

// N is the cost: 2^15 takes ~100 ms, unnoticeable at login but expensive to brute-force.
const N = 32768, R = 8, P = 1, KEY_LENGTH = 32;

// scrypt needs 128 * N * r = 32 MiB here, which is exactly Node's default cap. Doubled so raising N doesn't break it.
const MAXMEM = 64 * 1024 * 1024;

// Accounts are never locked after failures (that would let anyone lock out an admin). Instead:
//  - a per-origin limit (loginLimiter.js), so whoever insists blocks themselves
//  - each consecutive failure on a username delays the reply to failures (never to successes)
//  - at WARN_THRESHOLD consecutive failures a line goes to the user audit log
const WARN_THRESHOLD = 10;
const FAIL_DELAY_BASE_MS = 250;
const FAIL_DELAY_MAX_MS = 4000;

/** How long to wait before answering a failure: 250, 500, 1000... ms up to 4 s. */
function failDelay(streak) {
    const base = Number(process.env.LUPO_FAIL_DELAY_MS ?? FAIL_DELAY_BASE_MS);   // 0 in tests
    if (!(base > 0)) return 0;
    return Math.min(base * 2 ** Math.max(0, streak - 1), FAIL_DELAY_MAX_MS);
}

// A shift is twelve hours; shorter would be the friction that sends people back to paper.
const SESSION_HOURS = 12;

// A TEMPORARY password (assigned by an admin) expires after 72 hours. Expired doesn't lock the account: assign another.
const TEMP_PASSWORD_HOURS = 72;

// `technician` is remote maintenance: only sees system status and the user audit log.
const ROLES = ['operator', 'storekeeper', 'admin', 'technician'];

/** Derives the password to `scrypt$N$r$p$salt$hash`. New salt every time. */
async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(String(password), salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAXMEM });
    return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** Constant-time comparison, so response time doesn't leak the hash byte by byte. */
async function verifyPassword(password, stored) {
    if (!stored) return false;
    const parts = String(stored).split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

    const [, n, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64');

    let computed;
    try {
        computed = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length,
            { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
    } catch {
        return false;
    }
    return computed.length === expected.length
        && crypto.timingSafeEqual(computed, expected);
}

// Minimum length of a NEW password. Existing shorter ones still work at login (`loginPassword`): they are asked to change.
const MIN_LENGTH = 12;
const MAX_LENGTH = 200;   // cut before spending 100 ms of scrypt on garbage

function isValidPassword(password) {
    return typeof password === 'string'
        && password.length >= MIN_LENGTH
        && password.length <= MAX_LENGTH
        && !password.includes('\u0000');
}

// What login accepts: any non-empty text of reasonable length, no null byte (scrypt ignores a trailing one,
// so "pass" and "pass\0" would be the same password).
function loginPassword(password) {
    return typeof password === 'string' && password.length >= 1 && password.length <= MAX_LENGTH
        && !password.includes('\u0000');
}

/** "Test Storekeeper" -> "test-storekeeper": the suggested username for a name. */
function suggestedUsername(name) {
    const base = String(name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
    return base.length >= 2 ? base : '';
}

/** Shape of a username when CREATING one (login accepts more: `isValidUsername`). */
const RE_USERNAME = /^[a-z0-9][a-z0-9._-]{1,29}$/;

/** The username typed at login: 1 to 50 characters, no control characters. */
function isValidUsername(username) {
    return typeof username === 'string' && username.length >= 1 && username.length <= 50 && !/[\u0000-\u001f\u007f]/.test(username);
}

// Short on purpose: not a security dictionary, just what people actually type to get past the form.
// Compared lowercase and without spaces.
const FORBIDDEN_PASSWORDS = new Set([
    '12345678', '123456789', '1234567890', '00000000', '11111111',
    'password', 'password1', 'qwertyui', 'qwerty123',
    'lupo', 'lupo123', 'lupo2026', 'warehouse', 'warehouse123',
    'inventory', 'administrator', 'abcd1234', 'aaaaaaaa', 'iloveyou',
]);

function isWeakPassword(password) {
    const n = String(password).trim().toLowerCase();
    if (FORBIDDEN_PASSWORDS.has(n)) return true;
    // one repeated character, any length
    if (/^(.)\1+$/.test(n)) return true;
    // digits running up or down: 12345678, 87654321
    if (/^\d+$/.test(n) && n.length >= 4) {
        // modulo 10, so "123456789012" wraps through 0
        const up = [...n].every((d, i, a) => i === 0 || +d === (+a[i - 1] + 1) % 10);
        const down = [...n].every((d, i, a) => i === 0 || +d === (+a[i - 1] + 9) % 10);
        if (up || down) return true;
    }
    return false;
}

/** Why this password is not acceptable for THIS person (weak, or contains their username, or is their name), or null. */
function passwordProblem(password, { username = '', name = '' } = {}) {
    if (!isValidPassword(password)) return `The password must be at least ${MIN_LENGTH} characters`;
    if (isWeakPassword(password)) return 'That password is too obvious, choose another one';
    const n = String(password).toLowerCase().replace(/\s+/g, '');
    const u = String(username).toLowerCase();
    if (u.length >= 3 && n.includes(u)) return 'The password cannot contain your username';
    const nm = String(name).toLowerCase().replace(/\s+/g, '');
    if (nm.length >= 4 && n === nm) return 'The password cannot be your name';
    return null;
}

// The generated TEMPORARY password: eight random syllables in four groups ("kodu-mari-selo-tafu"), ~47 bits.
// It has to be dictated and typed once, so: consonants that sound the same aloud, five vowels, no accents or caps.
const CONSONANTS = 'bdfklmnprstv';
const VOWELS = 'aeiou';

function randomPassword() {
    const syllable = () => CONSONANTS[crypto.randomInt(CONSONANTS.length)] + VOWELS[crypto.randomInt(VOWELS.length)];
    let p;
    do {
        p = Array.from({ length: 4 }, () => syllable() + syllable()).join('-');
    } while (isWeakPassword(p) || !isValidPassword(p));
    return p;
}

// The token goes to the client; only its SHA-256 goes to the database. Slow scrypt would add nothing over 256 random bits.
function newToken() {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, hash: hashToken(token) };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// A fake hash to verify against when the username doesn't exist, so timing doesn't reveal which ones do.
let fakeHash = null;
const dummyHash = () => (fakeHash ??= hashPassword(crypto.randomBytes(16).toString('hex')));

/**
 * Opens a session with username and password. No row lock is held while scrypt runs; only the failure
 * counter moves, with an atomic UPDATE. A missing/inactive user or one without a password answers like
 * a wrong password (`credentials`) and takes the same time.
 * -> { ok, token, user } or { ok: false, reason: 'credentials' | 'temp_expired' }
 */
async function openSession(pool, username, password) {
    const { rows } = await pool.query(
        `SELECT id, name, role, active, password_hash, must_change_password,
                (temp_password_until IS NOT NULL AND temp_password_until < now()) AS temp_expired
           FROM users WHERE lower(username) = lower($1)`,
        [String(username)]
    );
    const u = rows[0];

    if (!u || !u.active || !u.password_hash) {
        await verifyPassword(password, await dummyHash());
        return { ok: false, reason: 'credentials' };
    }

    if (!(await verifyPassword(password, u.password_hash))) {
        const { rows: [{ failed_attempts: streak }] } = await pool.query(
            'UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = $1 RETURNING failed_attempts', [u.id]);
        // one line at the threshold, not one per attempt
        if (streak === WARN_THRESHOLD) {
            await pool.query(
                `INSERT INTO user_audit_log (user_id, actor_id, action, detail) VALUES ($1, NULL, 'attempts', $2)`,
                [u.id, `${streak} wrong passwords in a row`]);
        }
        return { ok: false, reason: 'credentials' };
    }

    // "Expired" is only revealed after the right password, or it would leak which accounts have a temporary one.
    if (u.must_change_password && u.temp_expired) return { ok: false, reason: 'temp_expired' };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [u.id]);
        const { token, hash } = newToken();
        await client.query(
            `INSERT INTO sessions (user_id, token_hash, expires_at)
             VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
            [u.id, hash, SESSION_HOURS]
        );
        await client.query('COMMIT');
        return {
            ok: true, token,
            user: { id: u.id, name: u.name, role: u.role, must_change_password: u.must_change_password },
        };
    } catch (err) {
        await safeRollback(client);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Changes the password of whoever holds the session. Asks for the current one, closes the person's OTHER
 * sessions and clears the temporary flag. No lock during scrypt: the final UPDATE compares-and-swaps on the
 * verified hash, so two simultaneous changes can't both pass with the same "current".
 * -> { ok: true } or { ok: false, reason: 'current' | 'same' | 'problem', detail }
 */
async function changePassword(pool, userId, token, current, next) {
    const { rows: [u] } = await pool.query('SELECT id, name, username, password_hash FROM users WHERE id = $1', [userId]);
    if (!u || !u.password_hash || !(await verifyPassword(current, u.password_hash))) {
        if (u) await pool.query('UPDATE users SET failed_attempts = failed_attempts + 1 WHERE id = $1', [u.id]);
        return { ok: false, reason: 'current' };
    }
    if (current === next) return { ok: false, reason: 'same' };
    const problem = passwordProblem(next, { username: u.username, name: u.name });
    if (problem) return { ok: false, reason: 'problem', detail: problem };

    const hash = await hashPassword(next);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rowCount: changed } = await client.query(
            `UPDATE users SET password_hash = $1, must_change_password = false, password_changed_at = now(),
                    temp_password_until = NULL, failed_attempts = 0, locked_until = NULL
              WHERE id = $2 AND password_hash = $3`, [hash, u.id, u.password_hash]);
        if (changed === 0) { await safeRollback(client); return { ok: false, reason: 'current' }; }
        const { rowCount } = await client.query(
            `UPDATE sessions SET closed_at = now()
              WHERE user_id = $1 AND closed_at IS NULL AND token_hash <> $2`, [u.id, hashToken(token)]);
        await client.query(
            `INSERT INTO user_audit_log (user_id, actor_id, action, detail)
             VALUES ($1, $1, 'own_password', $2)`, [u.id, `changed by the user, ${rowCount} session(s) closed`]);
        await client.query('COMMIT');
        return { ok: true };
    } catch (err) {
        await safeRollback(client);
        throw err;
    } finally {
        client.release();
    }
}

/** The user for a live token, or null. */
async function userFromToken(pool, token) {
    if (!token) return null;
    const { rows } = await pool.query(
        `SELECT u.id, u.name, u.role, u.must_change_password
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1
            AND s.closed_at IS NULL
            AND s.expires_at > now()
            AND u.active`,
        [hashToken(token)]
    );
    return rows[0] ?? null;
}

async function closeSession(pool, token) {
    if (!token) return false;
    const { rowCount } = await pool.query(
        'UPDATE sessions SET closed_at = now() WHERE token_hash = $1 AND closed_at IS NULL',
        [hashToken(token)]
    );
    return rowCount > 0;
}

function tokenOf(req) {
    const h = req.get('authorization');
    if (!h) return null;
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1] : null;
}

/** Lets through only with a live session. Sets req.user. */
function requireSession(pool) {
    return async (req, res, next) => {
        try {
            const user = await userFromToken(pool, tokenOf(req));
            if (!user) {
                return res.status(401).json({
                    error: 'Invalid or expired session',
                    error_code: 'no_session',
                });
            }
            // so the access log also knows who a 403 belonged to
            res.locals.userId = user.id;
            // With a TEMPORARY password the only things allowed are changing it, seeing who you are, or logging out.
            // The server decides: hiding the menu doesn't hide an endpoint.
            if (user.must_change_password && !TEMP_PASSWORD_ROUTES.has(`${req.method} ${req.baseUrl}${req.path}`)) {
                return res.status(403).json({
                    error: 'Your password is temporary: change it before continuing',
                    error_code: 'must_change_password',
                });
            }
            // Technicians get an allow-list, closed once here: a new role falling into "everything that isn't
            // operator" would otherwise see what it shouldn't.
            if (user.role === 'technician' && !TECHNICIAN_ROUTES.has(`${req.method} ${req.baseUrl}${req.path}`)) {
                return res.status(403).json({
                    error: 'Your role only allows viewing the system status',
                    error_code: 'no_permission',
                });
            }
            req.user = user;
            next();
        } catch (err) {
            next(err);
        }
    };
}

const TEMP_PASSWORD_ROUTES = new Set([
    'GET /api/session', 'DELETE /api/session', 'POST /api/session/password',
]);

const TECHNICIAN_ROUTES = new Set([
    ...TEMP_PASSWORD_ROUTES,
    'GET /api/admin/diagnostics', 'GET /api/admin/audit-log', 'GET /api/admin/users',
]);

/** Additionally requires one of the roles, for what not every logged-in user may do. */
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                error: 'You do not have permission for this operation',
                error_code: 'no_permission',
            });
        }
        next();
    };
}

module.exports = {
    hashPassword, verifyPassword, isValidPassword, loginPassword, isValidUsername, isWeakPassword, passwordProblem,
    randomPassword, failDelay, tokenOf, suggestedUsername, RE_USERNAME,
    openSession, changePassword, closeSession, userFromToken,
    requireSession, requireRole,
    ROLES, WARN_THRESHOLD, SESSION_HOURS, TEMP_PASSWORD_HOURS, MIN_LENGTH,
};
