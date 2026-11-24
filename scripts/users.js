#!/usr/bin/env node
// CLI to manage users and passwords. Passwords are hashed with scrypt before they touch the database.
// This is the bootstrap path (the first admin can't come from a screen that needs an admin) and the rescue path.
//
//   node scripts/users.js list
//   node scripts/users.js create "Jane Doe" operator [--username jane.doe]
//   node scripts/users.js password 3 --generate
//   node scripts/users.js password 3 "the-one-you-want"
//   node scripts/users.js role 3 admin
//   node scripts/users.js unlock 3
//   node scripts/users.js deactivate 3
//   node scripts/users.js reactivate 3
//   node scripts/users.js close-sessions 3
//
// The password is shown ONCE, when assigned; it is not stored anywhere.

const pool = require('../db');
const auth = require('../auth');

const { ROLES, RE_USERNAME, suggestedUsername } = auth;

// Changes made here go to the audit log too, with a NULL actor: "from the terminal, no session".
async function record(userId, action, detail = null) {
    await pool.query(
        `INSERT INTO user_audit_log (user_id, actor_id, action, detail)
         VALUES ($1, NULL, $2, $3)`,
        [userId, action, detail]);
}

const randomPassword = auth.randomPassword;

async function list() {
    const { rows } = await pool.query(
        `SELECT u.id, u.name, u.username, u.role, u.active,
                (u.password_hash IS NOT NULL) AS has_password,
                u.failed_attempts,
                u.locked_until > now() AS locked,
                (SELECT count(*) FROM sessions s
                  WHERE s.user_id = u.id AND s.closed_at IS NULL
                    AND s.expires_at > now()) AS sessions,
                (SELECT count(*) FROM movements m WHERE m.user_id = u.id) AS movements
           FROM users u ORDER BY u.id`);

    if (rows.length === 0) return console.log('No users.');
    console.log('\n id  username              name                  role         active  pass  lock  ses  movs');
    console.log('---  --------------------  --------------------  -----------  ------  ----  ----  ---  ----');
    for (const u of rows) {
        console.log(
            String(u.id).padStart(3) + '  ' +
            u.username.slice(0, 20).padEnd(20) + '  ' +
            u.name.slice(0, 20).padEnd(20) + '  ' +
            u.role.padEnd(11) + '  ' +
            (u.active ? ' yes  ' : '  no  ') + '  ' +
            (u.has_password ? ' yes' : '  NO') + '  ' +
            (u.locked ? ' YES' : '  no') + '  ' +
            String(u.sessions).padStart(3) + '  ' +
            String(u.movements).padStart(4)
        );
    }
    const noPass = rows.filter(u => u.active && !u.has_password);
    if (noPass.length) {
        console.log(`\n!  ${noPass.length} active user(s) without a password: they can't sign in.`);
        console.log('   Assign one with:');
        noPass.forEach(u => console.log(`     node scripts/users.js password ${u.id} --generate`));
    }
}

async function create(name, role = 'operator', username = undefined) {
    if (!name || !name.trim()) throw new Error('The name is missing');
    if (!ROLES.includes(role)) throw new Error(`Invalid role. Must be one of: ${ROLES.join(', ')}`);
    // lowercase, no spaces; derived from the name when not given
    const login = (username ?? suggestedUsername(name)).toLowerCase();
    if (!RE_USERNAME.test(login)) {
        throw new Error('The username must be 2 to 30 characters: unaccented letters, digits, dot, hyphen or underscore');
    }

    let rows;
    try {
        ({ rows } = await pool.query(
            'INSERT INTO users (name, username, role) VALUES ($1, $2, $3) RETURNING id, name, username, role',
            [name.trim(), login, role]));
    } catch (e) {
        if (e.code === '23505') throw new Error(`The username "${login}" already exists`, { cause: e });
        throw e;
    }

    const u = rows[0];
    await record(u.id, 'create', `role ${u.role}, username ${u.username} (from the terminal)`);
    console.log(`OK User ${u.id}: ${u.name} (${u.role}), signs in as "${u.username}"`);
    console.log(`  No password yet. Assign one with:`);
    console.log(`    node scripts/users.js password ${u.id} --generate`);
}

async function assignPassword(id, password) {
    const userId = Number(id);
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('Invalid id');

    const generated = password === undefined || password === '--generate';
    if (generated) password = randomPassword();

    const { rows: prev } = await pool.query('SELECT name, username FROM users WHERE id = $1', [userId]);
    if (prev.length === 0) throw new Error(`User ${userId} does not exist`);
    const problem = auth.passwordProblem(password, prev[0]);
    if (problem) {
        throw new Error(problem + '.\n  Try --generate.');
    }

    const hash = await auth.hashPassword(password);
    // TEMPORARY: the person changes it on first login (the server allows nothing else until then).
    const { rows } = await pool.query(
        `UPDATE users
            SET password_hash = $1, failed_attempts = 0, locked_until = NULL,
                must_change_password = true, password_changed_at = NULL,
                temp_password_until = now() + ($3 || ' hours')::interval
          WHERE id = $2 RETURNING name, username`,
        [hash, userId, auth.TEMP_PASSWORD_HOURS]);

    // If it's being reassigned because it leaked, old sessions must not survive.
    const { rowCount } = await pool.query(
        'UPDATE sessions SET closed_at = now() WHERE user_id = $1 AND closed_at IS NULL',
        [userId]);

    await record(userId, 'password',
        `${generated ? 'generated' : 'set'} from the terminal, ${rowCount} session(s) closed`);

    const frame = '─'.repeat(password.length + 4);
    console.log(`\nOK TEMPORARY password assigned to ${rows[0].name} (signs in as "${rows[0].username}")\n`);
    console.log(`     ┌${frame}┐`);
    console.log(`     │  ${password}  │`);
    console.log(`     └${frame}┘\n`);
    console.log('  Shown only this once: the database keeps just the hash.');
    console.log(`  Give it to the person; they must change it on first login. Valid for ${auth.TEMP_PASSWORD_HOURS} hours.`);
}

// Unlike the endpoint, this doesn't stop you removing the last admin: it's the tool to fix a lockout.
async function changeRole(id, role) {
    if (!ROLES.includes(role)) throw new Error(`Invalid role. Must be one of: ${ROLES.join(', ')}`);
    const { rows } = await pool.query(
        'UPDATE users SET role = $1 WHERE id = $2 RETURNING name, role', [role, Number(id)]);
    if (rows.length === 0) throw new Error(`User ${id} does not exist`);
    await record(Number(id), 'role', `→ ${role} (from the terminal)`);
    console.log(`OK ${rows[0].name} is now ${rows[0].role}`);

    const { rows: admins } = await pool.query(
        "SELECT count(*) c FROM users WHERE role = 'admin' AND active");
    if (Number(admins[0].c) === 0) {
        console.log('\n!  No active admin left. Nobody can open the admin screen');
        console.log('   until you name one from here.');
    }
}

async function unlock(id) {
    const { rows } = await pool.query(
        `UPDATE users SET failed_attempts = 0, locked_until = NULL
          WHERE id = $1 RETURNING name`, [Number(id)]);
    if (rows.length === 0) throw new Error(`User ${id} does not exist`);
    await record(Number(id), 'unlock', 'from the terminal');
    console.log(`OK ${rows[0].name} unlocked`);
}

async function setActive(id, active) {
    const { rows } = await pool.query(
        'UPDATE users SET active = $1 WHERE id = $2 RETURNING name',
        [active, Number(id)]);
    if (rows.length === 0) throw new Error(`User ${id} does not exist`);

    if (!active) {
        // deactivating must take effect now, not when the token expires
        const { rowCount } = await pool.query(
            'UPDATE sessions SET closed_at = now() WHERE user_id = $1 AND closed_at IS NULL',
            [Number(id)]);
        await record(Number(id), 'deactivate', `from the terminal, ${rowCount} session(s) closed`);
        console.log(`OK ${rows[0].name} deactivated (${rowCount} session(s) closed)`);
        console.log('  Their movements stay: deactivating is logical, history is kept.');
    } else {
        await record(Number(id), 'reactivate', 'from the terminal');
        console.log(`OK ${rows[0].name} reactivated`);
    }
}

async function closeSessions(id) {
    const { rowCount } = await pool.query(
        'UPDATE sessions SET closed_at = now() WHERE user_id = $1 AND closed_at IS NULL',
        [Number(id)]);
    console.log(`OK ${rowCount} session(s) closed`);
}

const HELP = `
User and password management

  list                        status of everyone
  create <name> [role] [--username x]   role: operator (default) | storekeeper | admin | technician;
                              the username is derived from the name if not given
  password <id> [--generate]  assigns a password; shown only once
  role <id> <role>            operator | storekeeper | admin | technician
  unlock <id>                 clears failed attempts
  deactivate <id>             deactivates and closes their sessions
  reactivate <id>             reactivates
  close-sessions <id>         forces a new login
`;

(async () => {
    const [cmd, ...args] = process.argv.slice(2);
    try {
        switch (cmd) {
            case 'list': await list(); break;
            case 'create': {
                // create <name> [role] [--username x]
                const i = args.indexOf('--username');
                const username = i >= 0 ? args[i + 1] : undefined;
                const rest = args.filter((_, j) => j !== i && j !== i + 1 || i < 0);
                await create(rest[0], rest[1], username);
                break;
            }
            case 'password': await assignPassword(args[0], args[1]); break;
            case 'role': await changeRole(args[0], args[1]); break;
            case 'unlock': await unlock(args[0]); break;
            case 'deactivate': await setActive(args[0], false); break;
            case 'reactivate': await setActive(args[0], true); break;
            case 'close-sessions': await closeSessions(args[0]); break;
            default: console.log(HELP);
        }
        await pool.end();
    } catch (e) {
        console.error('\nERROR ' + e.message + '\n');
        await pool.end();
        process.exit(1);
    }
})();
