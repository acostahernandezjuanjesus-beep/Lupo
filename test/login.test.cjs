const { test, before } = require('node:test');
const assert = require('node:assert/strict');

// failure delays are real behaviour but not what most tests here are about: 0 means no sleeping
process.env.LUPO_FAIL_DELAY_MS = '0';

const auth = require('../auth');
const { createApp } = require('../index');
const { LoginLimiter } = require('../loginLimiter');

const PASSWORD = 'a-long-password-1';
let HASH;
before(async () => { HASH = await auth.hashPassword(PASSWORD); });

/** In-memory stand-in for the database: users, sessions and audit log. */
function fakeDb({ users }) {
    const sessions = [], auditLog = [], queries = [];
    const respond = async (sql, args = []) => {
        queries.push({ sql, args });
        // userFromToken
        if (/FROM sessions s\s+JOIN users u/.test(sql)) {
            const s = sessions.find(x => x.hash === args[0] && !x.closed);
            const u = s && users.find(x => x.id === s.user_id && x.active);
            return { rows: u ? [{ id: u.id, name: u.name, role: u.role, must_change_password: u.must_change_password }] : [] };
        }
        // openSession: the row, no lock
        if (/FROM users WHERE lower\(username\) = lower\(\$1\)/.test(sql)) {
            // copies, like a real database: a row already read doesn't change when another request updates it
            return { rows: users.filter(u => u.username.toLowerCase() === String(args[0]).toLowerCase()).map(u => ({ ...u })) };
        }
        // changePassword: the row, no lock
        if (/SELECT id, name, username, password_hash FROM users WHERE id = \$1/.test(sql)) return { rows: users.filter(u => u.id === args[0]).map(u => ({ ...u })) };
        if (/UPDATE users SET failed_attempts = failed_attempts \+ 1 WHERE id = \$1 RETURNING failed_attempts/.test(sql)) {
            const u = users.find(x => x.id === args[0]); u.failed_attempts++;
            return { rows: [{ failed_attempts: u.failed_attempts }] };
        }
        if (/UPDATE users SET failed_attempts = failed_attempts \+ 1 WHERE id = \$1/.test(sql)) { users.find(u => u.id === args[0]).failed_attempts++; return { rows: [] }; }
        if (/UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = \$1/.test(sql)) { users.find(u => u.id === args[0]).failed_attempts = 0; return { rows: [] }; }
        // compare-and-swap: only touches the row if the hash is still the one that was verified
        if (/UPDATE users SET password_hash = \$1, must_change_password = false/.test(sql)) {
            const u = users.find(x => x.id === args[1]);
            if (!u || u.password_hash !== args[2]) return { rows: [], rowCount: 0 };
            Object.assign(u, { password_hash: args[0], must_change_password: false, password_changed_at: 'now', temp_password_until: null, temp_expired: false, failed_attempts: 0 });
            return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO sessions/.test(sql)) { sessions.push({ user_id: args[0], hash: args[1], closed: false }); return { rows: [] }; }
        if (/UPDATE sessions SET closed_at = now\(\)\s+WHERE user_id = \$1 AND closed_at IS NULL AND token_hash <> \$2/.test(sql)) {
            let n = 0;
            for (const s of sessions) if (s.user_id === args[0] && !s.closed && s.hash !== args[1]) { s.closed = true; n++; }
            return { rows: [], rowCount: n };
        }
        if (/INSERT INTO user_audit_log/.test(sql)) { auditLog.push({ sql, args }); return { rows: [] }; }
        if (/SELECT id, name FROM users\s+WHERE active/.test(sql)) {
            return { rows: users.filter(u => u.active && u.password_hash).map(u => ({ id: u.id, name: u.name })) };
        }
        return { rows: [], rowCount: 0 };
    };
    const pool = { query: respond, async connect() { return { query: respond, release() {} }; } };
    return { pool, sessions, auditLog, queries };
}

const person = (extra = {}) => ({ id: 1, name: 'John Smith', username: 'juan', role: 'storekeeper', active: true,
    password_hash: HASH, failed_attempts: 0, must_change_password: false, password_changed_at: null, ...extra });

async function setup(t, users, { proxy = false } = {}) {
    const db = fakeDb({ users });
    const prev = process.env.LUPO_PROXY;
    if (proxy) process.env.LUPO_PROXY = '1'; else delete process.env.LUPO_PROXY;
    const server = createApp(db.pool).listen(0, '127.0.0.1');
    if (prev === undefined) delete process.env.LUPO_PROXY; else process.env.LUPO_PROXY = prev;
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, method = 'GET', body, headers = {}) => {
        const t0 = performance.now();
        const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => null), headers: r.headers, ms: performance.now() - t0 };
    };
    const login = (username, password, origin) => request('/api/session', 'POST', { username, password }, origin ? { 'x-forwarded-for': origin } : {});
    return { ...db, request, login };
}

// ---------- login ----------

test('login by username and password: username is case-insensitive, and the response says if the password must change', async t => {
    const e = await setup(t, [person(), person({ id: 2, username: 'temp', name: 'Newcomer', must_change_password: true })]);
    const a = await e.login('JUAN', PASSWORD);
    assert.equal(a.status, 201); assert.ok(a.body.token); assert.equal(a.body.user.name, 'John Smith'); assert.equal(a.body.user.must_change_password, false);
    const b = await e.login('temp', PASSWORD);
    assert.equal(b.body.user.must_change_password, true);
});

test('one failure message: unknown user, deactivated user, no password and wrong password are IDENTICAL', async t => {
    const e = await setup(t, [person(), person({ id: 2, username: 'inactive', active: false }), person({ id: 3, username: 'nopass', password_hash: null })], { proxy: true });
    const responses = [];
    let i = 0;
    for (const [u, p] of [['juan', 'another-password-1'], ['nobody', PASSWORD], ['inactive', PASSWORD], ['nopass', PASSWORD]]) {
        responses.push(await e.login(u, p, `10.0.0.${++i}`));
    }
    for (const r of responses) { assert.equal(r.status, 401); assert.deepEqual(r.body, responses[0].body); }
    assert.equal(responses[0].body.error, 'Incorrect username or password');
    assert.ok(!('attempts_left' in responses[0].body), 'remaining attempts are not counted: accounts are never locked');
});

test('empty, huge or control-character fields: 400 before spending scrypt or touching the database', async t => {
    const e = await setup(t, [person()]);
    for (const body of [{}, { username: 'juan' }, { password: 'x' }, { username: '', password: 'x' }, { username: 'a'.repeat(51), password: 'x' }, { username: 'juan', password: 'x'.repeat(201) }, { username: 5, password: 'x' },
        { username: 'juan\u0000', password: 'x' }, { username: '\u0000', password: 'x' }, { username: 'ju\nan', password: 'x' }, { username: 'ju\tan', password: 'x' }, { username: 'juan', password: PASSWORD + '\u0000' }]) {
        assert.equal((await e.request('/api/session', 'POST', body)).status, 400, JSON.stringify(body).slice(0, 50));
    }
    assert.equal(e.queries.filter(q => /lower\(username\)/.test(q.sql)).length, 0, 'the user was never even looked up');
});

test('a null byte on ANY route is a 400, not a PostgreSQL 500', async t => {
    const e = await setup(t, [person()]);
    const { body: { token } } = await e.login('juan', PASSWORD);
    const h = { authorization: `Bearer ${token}` };
    for (const [path, body] of [['/api/products', { code: 'A\u0000B', name: 'x', category_id: 1, unit: 'piece' }], ['/api/movements', { product_id: 1, type: 'in', quantity: 1, note: 'hello\u0000' }],
        ['/api/session/password', { current: PASSWORD, new_password: 'new-password-1\u0000' }], ['/api/admin/users', { name: 'a\u0000b' }]]) {
        const r = await e.request(path, 'POST', body, h);
        assert.ok(r.status === 400 || r.status === 403, `${path} -> ${r.status}`);       // 403: the test role isn't admin; what it can't be is 500
        assert.ok(r.status !== 500);
    }
    const r = await e.request('/api/products', 'POST', '{"code":"A\\u0000B","name":"x"}', h);
    assert.equal(r.status, 400); assert.equal(r.body.error_code, 'invalid_character');
    assert.equal((await e.request('/api/products', 'POST', '{"a":{"b":["x\\u0000"]}}', h)).status, 400, 'nested too');
});

test('a null byte in the ADDRESS (query or path) is also a 400, not a PostgreSQL 500', async t => {
    const e = await setup(t, [person()]);
    const { body: { token } } = await e.login('juan', PASSWORD);
    const h = { authorization: `Bearer ${token}` };
    for (const path of ['/api/products?q=%00', '/api/products?q=a%00b', '/api/purchases?supplier_text=%00', '/api/suppliers/detail?text=a%00', '/api/suppliers/%00/aliases']) {
        const r = await e.request(path, 'GET', undefined, h);
        assert.equal(r.status, 400, path);
        assert.equal(r.body.error_code, 'invalid_character', path);
    }
    assert.notEqual((await e.request('/api/products?q=%2500', 'GET', undefined, h)).status, 400, '%2500 is the text "%00", not a null');
});

test('an old 8-character password still works to LOG IN (only new ones need 12)', async t => {
    const short = await auth.hashPassword('abcd-efg');
    const e = await setup(t, [person({ password_hash: short })]);
    assert.equal((await e.login('juan', 'abcd-efg')).status, 201);
});

// ---------- no per-account lock, per-origin limit ----------

test('the account is NEVER locked: many failures from different origins and the right password still gets in at once', async t => {
    const e = await setup(t, [person()], { proxy: true });
    for (let i = 1; i <= 15; i++) assert.equal((await e.login('juan', 'bad-bad-bad-1', `10.1.0.${i}`)).status, 401);
    const ok = await e.login('juan', PASSWORD, '10.1.0.99');
    assert.equal(ok.status, 201, 'after 15 failures from others, the person gets in without waiting');
});

test('per-ORIGIN limit: the tenth failure closes the door on that device, not on the account or anyone else', async t => {
    const e = await setup(t, [person()], { proxy: true });
    for (let i = 1; i <= 10; i++) assert.equal((await e.login('juan', 'bad-bad-bad-1', '10.2.0.1')).status, 401, `failure ${i}`);
    const blocked = await e.login('juan', PASSWORD, '10.2.0.1');           // even with the right password
    assert.equal(blocked.status, 429); assert.equal(blocked.body.error_code, 'too_many_attempts');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0); assert.ok(blocked.body.wait_seconds > 0);
    assert.equal((await e.login('juan', PASSWORD, '10.2.0.2')).status, 201, 'another device gets in normally');
});

test('the shop shares ONE address: ten failures on one account do not lock another person out from there', async t => {
    const e = await setup(t, [person(), person({ id: 2, name: 'Ana', username: 'ana' })], { proxy: true });
    for (let i = 1; i <= 10; i++) assert.equal((await e.login('juan', 'bad-bad-bad-1', '10.8.0.1')).status, 401);
    assert.equal((await e.login('juan', PASSWORD, '10.8.0.1')).status, 429, 'that account, from that address, waits');
    assert.equal((await e.login('ana', PASSWORD, '10.8.0.1')).status, 201, 'a coworker gets in from the same address');
});

test('trying one password against MANY users also hits the cap: sixty failures per address', async t => {
    const e = await setup(t, [person()], { proxy: true });
    for (let i = 0; i < 60; i++) assert.equal((await e.login(`made-up-${i}`, 'bad-bad-bad-1', '10.9.0.1')).status, 401);
    assert.equal((await e.login('juan', PASSWORD, '10.9.0.1')).status, 429, 'the whole address waits');
    assert.equal((await e.login('juan', PASSWORD, '10.9.0.2')).status, 201, 'another address gets in normally');
});

test('a simultaneous BURST from one origin cannot skip the limit: of 60 at once, only 10 are evaluated', async t => {
    const e = await setup(t, [person()], { proxy: true });
    const r = await Promise.all(Array.from({ length: 60 }, () => e.login('juan', 'bad-bad-bad-1', '10.3.0.1')));
    assert.equal(r.filter(x => x.status === 401).length, 10, 'ten evaluated');
    assert.equal(r.filter(x => x.status === 429).length, 50, 'fifty stopped immediately');
    assert.equal(e.queries.filter(q => /lower\(username\)/.test(q.sql)).length, 10, 'only the ten reached the database');
});

test('a success releases ITS slot (good passwords do not use up the quota) but does not erase earlier failures', async t => {
    const e = await setup(t, [person()], { proxy: true });
    for (let i = 0; i < 9; i++) await e.login('juan', 'bad-bad-bad-1', '10.4.0.1');
    for (let i = 0; i < 5; i++) assert.equal((await e.login('juan', PASSWORD, '10.4.0.1')).status, 201, 'five successes in a row');
    assert.equal((await e.login('juan', 'bad-bad-bad-1', '10.4.0.1')).status, 401, 'the tenth failure is still evaluated');
    assert.equal((await e.login('juan', PASSWORD, '10.4.0.1')).status, 429, 'and with ten failures there is no room, even for the right password');
});

test('a server error (500) does not count against the origin as a failure', async t => {
    const u = [person()];
    const db = fakeDb({ users: u });
    let breaks = true;
    const original = db.pool.query;
    db.pool.query = async (sql, args) => { if (breaks && /lower\(username\)/.test(sql)) throw new Error('the database went down'); return original(sql, args); };
    const prev = process.env.LUPO_PROXY; process.env.LUPO_PROXY = '1';
    const server = createApp(db.pool).listen(0, '127.0.0.1');
    if (prev === undefined) delete process.env.LUPO_PROXY; else process.env.LUPO_PROXY = prev;
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const login = () => fetch(`http://127.0.0.1:${server.address().port}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.5.0.1' }, body: JSON.stringify({ username: 'juan', password: PASSWORD }) }).then(r => r.status);
    for (let i = 0; i < 12; i++) assert.equal(await login(), 500);
    breaks = false;
    assert.equal(await login(), 201, 'twelve server errors did not use up the origin\'s slots');
});

test('without LUPO_PROXY the X-Forwarded-For header is IGNORED: faking another address does not skip the limit', async t => {
    const e = await setup(t, [person()], { proxy: false });
    for (let i = 1; i <= 10; i++) await e.login('juan', 'bad-bad-bad-1', `10.6.0.${i}`);   // fake "different origins"
    assert.equal((await e.login('juan', PASSWORD, '10.6.0.200')).status, 429);
});

test('ten failures in a row on one account leave ONE line in the user audit log (not one per attempt)', async t => {
    const e = await setup(t, [person()], { proxy: true });
    for (let i = 1; i <= 14; i++) await e.login('juan', 'bad-bad-bad-1', `10.7.0.${i}`);
    const warnings = e.auditLog.filter(b => /'attempts'/.test(b.sql));
    assert.equal(warnings.length, 1); assert.match(warnings[0].args[1], /10 wrong passwords in a row/);
});

test('the failure streak counter is cleared on success', async t => {
    const u = person();
    const e = await setup(t, [u], { proxy: true });
    for (let i = 1; i <= 4; i++) await e.login('juan', 'bad-bad-bad-1', `10.8.0.${i}`);
    assert.equal(u.failed_attempts, 4);
    await e.login('juan', PASSWORD, '10.8.0.9');
    assert.equal(u.failed_attempts, 0);
});

// ---------- no lock during scrypt ----------

test('login holds NO row lock while scrypt runs (the real person does not queue behind an attack)', async t => {
    const e = await setup(t, [person()], { proxy: true });
    await Promise.all(Array.from({ length: 8 }, (_, i) => e.login('juan', 'bad-bad-bad-1', `10.9.0.${i}`)));
    await e.login('juan', PASSWORD, '10.9.1.1');
    const locking = e.queries.filter(q => /FOR UPDATE/i.test(q.sql));
    assert.deepEqual(locking.map(q => q.sql.slice(0, 60)), [], 'no login query asks for FOR UPDATE');
});

// ---------- the delay does not reveal who exists ----------

test('the failure delay is the SAME for an existing user and a made-up one', async t => {
    const prev = process.env.LUPO_FAIL_DELAY_MS;
    process.env.LUPO_FAIL_DELAY_MS = '40';                 // 40, 80, 160, 320 ms...
    t.after(() => { process.env.LUPO_FAIL_DELAY_MS = prev; });
    const e = await setup(t, [person()], { proxy: true });
    const times = { real: [], fake: [] };
    for (let i = 0; i < 5; i++) {
        times.real.push((await e.login('juan', 'bad-bad-bad-1', `10.10.${i}.1`)).ms);
        times.fake.push((await e.login('ghost', 'bad-bad-bad-1', `10.11.${i}.1`)).ms);
    }
    const last = a => a[a.length - 1];
    // by the fifth failure the delay is 640 ms
    assert.ok(last(times.real) > 500 && last(times.fake) > 500, `the delay grows for both: ${last(times.real) | 0} and ${last(times.fake) | 0} ms`);
    assert.ok(Math.abs(last(times.real) - last(times.fake)) < 150, 'and it is the same');
    // whoever succeeds never waits the accumulated delay
    const good = await e.login('juan', PASSWORD, '10.12.0.1');
    assert.equal(good.status, 201); assert.ok(good.ms < 300, `success does not inherit the delay (${good.ms | 0} ms)`);
});

test('the failure delay grows (250, 500, 1000... up to 4 s) and with 0 it does not sleep', () => {
    const prev = process.env.LUPO_FAIL_DELAY_MS;
    process.env.LUPO_FAIL_DELAY_MS = '250';
    assert.deepEqual([1, 2, 3, 4, 5, 6, 20].map(auth.failDelay), [250, 500, 1000, 2000, 4000, 4000, 4000]);
    process.env.LUPO_FAIL_DELAY_MS = '0';
    assert.equal(auth.failDelay(9), 0);
    process.env.LUPO_FAIL_DELAY_MS = prev;
});

// ---------- the user list ----------

test('GET /api/users is no longer public: 401 without a session; with one, only id and name', async t => {
    const e = await setup(t, [person(), person({ id: 2, username: 'other', name: 'Other Person' })]);
    assert.equal((await e.request('/api/users')).status, 401);
    const { body: { token } } = await e.login('juan', PASSWORD);
    const r = await e.request('/api/users', 'GET', undefined, { authorization: `Bearer ${token}` });
    assert.equal(r.status, 200); assert.equal(r.body.length, 2);
    for (const x of r.body) assert.deepEqual(Object.keys(x).sort(), ['id', 'name'], 'the login username is not in the list');
});

// ---------- temporary password ----------

test('with the temporary password you can only change it, see who you are, or log out', async t => {
    const e = await setup(t, [person({ must_change_password: true })]);
    const { body: { token } } = await e.login('juan', PASSWORD);
    const h = { authorization: `Bearer ${token}` };
    for (const [path, method] of [['/api/products', 'GET'], ['/api/users', 'GET'], ['/api/movements', 'GET']]) {
        const r = await e.request(path, method, undefined, h);
        assert.equal(r.status, 403, `${method} ${path}`); assert.equal(r.body.error_code, 'must_change_password');
    }
    assert.equal((await e.request('/api/session', 'GET', undefined, h)).status, 200);
    assert.equal((await e.request('/api/session', 'DELETE', undefined, h)).status, 204);
});

test('changing your own password: asks for the current one, validates the new one, closes other sessions and writes to the audit log', async t => {
    const u = person({ must_change_password: true });
    const e = await setup(t, [u]);
    const a = await e.login('juan', PASSWORD);
    const other = await e.login('juan', PASSWORD);                       // another open session (another phone)
    const h = { authorization: `Bearer ${a.body.token}` };
    const change = (current, newPassword) => e.request('/api/session/password', 'POST', { current, new_password: newPassword }, h);

    assert.equal((await change('not-the-current-1', 'another-new-password-9')).status, 401, 'the current one has to be right');
    assert.equal((await change(PASSWORD, PASSWORD)).status, 400, 'same as the current one');
    const rc = await change(PASSWORD, 'short-1'); assert.equal(rc.status, 400, JSON.stringify(rc.body)); assert.match(rc.body.error, /at least 12/);
    assert.match((await change(PASSWORD, 'juan-juan-juan-juan')).body.error, /username/);
    assert.match((await change(PASSWORD, '123456789012')).body.error, /obvious/);
    assert.equal(u.must_change_password, true, 'no rejection changed anything');

    const ok = await change(PASSWORD, 'my-own-password-9');
    assert.equal(ok.status, 204);
    assert.equal(u.must_change_password, false); assert.equal(u.password_changed_at, 'now');
    assert.equal(await auth.verifyPassword('my-own-password-9', u.password_hash), true);
    assert.ok(other.body.token, 'the other session existed');
    assert.equal(e.sessions.filter(s => !s.closed).length, 1, 'only the session the change came from stays open');
    assert.ok(e.auditLog.some(b => /'own_password'/.test(b.sql)));
    // with the final password it can work
    assert.equal((await e.request('/api/users', 'GET', undefined, h)).status, 200);
    assert.equal((await e.login('juan', 'my-own-password-9')).status, 201);
    assert.equal((await e.login('juan', PASSWORD, '10.9.9.9')).status, 401, 'the temporary one no longer works');
});

test('two SIMULTANEOUS password changes with the same "current": only one gets through', async t => {
    const u = person();
    const e = await setup(t, [u]);
    const { body: { token } } = await e.login('juan', PASSWORD);
    const h = { authorization: `Bearer ${token}` };
    const r = await Promise.all(['first-new-password-1', 'second-new-password-2'].map(newPassword => e.request('/api/session/password', 'POST', { current: PASSWORD, new_password: newPassword }, h)));
    assert.deepEqual(r.map(x => x.status).sort(), [204, 401], 'one passes and the other sees the current one already changed');
    const winner = r[0].status === 204 ? 'first-new-password-1' : 'second-new-password-2';
    assert.equal(await auth.verifyPassword(winner, u.password_hash), true, 'the password is the winner\'s, not a mix');
});

test('changing the password without a session: 401', async t => {
    const e = await setup(t, [person()]);
    assert.equal((await e.request('/api/session/password', 'POST', { current: PASSWORD, new_password: 'another-new-password-9' })).status, 401);
});

// ---------- password rules and the generator ----------

test('new passwords: 12 minimum, not weak, not containing your username, not your name, no null', () => {
    const ctx = { username: 'john.smith', name: 'John Smith' };
    assert.match(auth.passwordProblem('short', ctx), /12/);
    assert.match(auth.passwordProblem('111111111111', ctx), /obvious/);
    assert.match(auth.passwordProblem('xx-JOHN.SMITH-xx-123', ctx), /username/);
    assert.match(auth.passwordProblem('johnsmith1234', { username: 'other', name: 'John Smith1234' }), /your name/);
    assert.ok(auth.passwordProblem('horse-battery-9\u0000', ctx), 'not with a null byte');
    assert.equal(auth.passwordProblem('horse-battery-9', ctx), null);
    assert.equal(auth.loginPassword('abc'), true); assert.equal(auth.loginPassword(''), false);
    assert.equal(auth.loginPassword('x'.repeat(201)), false); assert.equal(auth.loginPassword(null), false);
    assert.equal(auth.loginPassword('secret\u0000'), false, 'scrypt ignores the trailing null: "secret" and "secret\\0" were the same');
    assert.equal(auth.isValidUsername('john.smith'), true);
    for (const bad of ['', 'a'.repeat(51), 'ju\u0000an', 'ju\nan', 'ju\tan', '\u007f', 5, null]) assert.equal(auth.isValidUsername(bad), false, JSON.stringify(bad));
});

test('the generator: four groups of two syllables, always valid, and never repeats', () => {
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
        const p = auth.randomPassword();
        assert.match(p, /^(?:[bdfklmnprstv][aeiou]){2}(?:-(?:[bdfklmnprstv][aeiou]){2}){3}$/);
        assert.equal(auth.isValidPassword(p), true); assert.equal(auth.isWeakPassword(p), false);
        seen.add(p);
    }
    assert.ok(seen.size > 295, `${seen.size} distinct out of 300`);
});

// ---------- the per-origin limit, alone ----------

test('LoginLimiter: reserves before verifying, window empties, exact wait and bounded memory', () => {
    let now = 1_000_000;
    const l = new LoginLimiter({ max: 3, windowMs: 60_000, cap: 3, now: () => now });
    const a1 = l.reserve('a'), a2 = l.reserve('a');
    assert.ok(a1.allowed && a2.allowed);
    now += 10_000;
    const a3 = l.reserve('a');
    assert.ok(a3.allowed, 'three slots');
    const full = l.reserve('a');
    assert.equal(full.allowed, false); assert.equal(full.wait, 50, 'frees up when the first one leaves the window (60 s - 10 s)');
    a2.release();
    assert.ok(l.reserve('a').allowed, 'release gives back ITS slot');
    now += 61_000;
    assert.ok(l.reserve('a').allowed, 'the window passed');
    for (const k of ['b', 'c', 'd', 'e']) l.reserve(k);
    assert.ok(l.attempts.size <= 3, 'memory does not grow without bound');
});

test('LoginLimiter: consecutive failures of a typed username go up, are forgotten on success and expire', () => {
    let now = 1_000_000;
    const l = new LoginLimiter({ windowMs: 60_000, now: () => now });
    assert.deepEqual([l.recordFailure('x'), l.recordFailure('x'), l.recordFailure('x')], [1, 2, 3]);
    assert.equal(l.recordFailure('y'), 1, 'another user counts separately');
    l.forget('x');
    assert.equal(l.recordFailure('x'), 1, 'success resets it');
    l.recordFailure('x'); now += 61_000;
    assert.equal(l.recordFailure('x'), 1, 'with no failures during the window, it starts from zero');
});

// ---------- the temporary password expires (72 h) ----------

test('a CURRENT temporary password gets in; an EXPIRED one with the right password: a 403 that says so, no session', async t => {
    const current = person({ id: 1, username: 'current', must_change_password: true, temp_expired: false });
    const expired = person({ id: 2, username: 'expired', must_change_password: true, temp_expired: true });
    const e = await setup(t, [current, expired], { proxy: true });
    const ok = await e.login('current', PASSWORD, '10.20.0.1');
    assert.equal(ok.status, 201); assert.equal(ok.body.user.must_change_password, true);
    const sessionsBefore = e.sessions.length;
    const exp = await e.login('expired', PASSWORD, '10.20.0.2');
    assert.equal(exp.status, 403); assert.equal(exp.body.error_code, 'temp_password_expired');
    assert.match(exp.body.error, /administrator/);
    assert.equal(e.sessions.length, sessionsBefore, 'no session was opened');
    assert.equal(expired.failed_attempts, 0, 'not a wrong password: it adds no failures');
});

test('expired with the WRONG password: the same old 401 (the notice does not reveal which accounts exist or have a temporary one)', async t => {
    const e = await setup(t, [person({ id: 1, username: 'expired', must_change_password: true, temp_expired: true }), person({ id: 2, username: 'normal' })], { proxy: true });
    const a = await e.login('expired', 'bad-bad-bad-1', '10.21.0.1');
    const b = await e.login('normal', 'bad-bad-bad-1', '10.21.0.2');
    const c = await e.login('ghost', 'bad-bad-bad-1', '10.21.0.3');
    for (const r of [a, b, c]) { assert.equal(r.status, 401); assert.deepEqual(r.body, a.body); }
    assert.ok(!/expired/i.test(JSON.stringify(a.body)));
});

test('an expired temporary password does not use up the origin\'s quota: whoever insists with it is not blocked', async t => {
    const e = await setup(t, [person({ username: 'expired', must_change_password: true, temp_expired: true })], { proxy: true });
    for (let i = 0; i < 15; i++) assert.equal((await e.login('expired', PASSWORD, '10.22.0.1')).status, 403, `attempt ${i + 1}`);
});

test('a person who has NO temporary password never gets the expired notice', async t => {
    const e = await setup(t, [person({ must_change_password: false, temp_expired: true })]);   // the flag alone is not enough
    assert.equal((await e.login('juan', PASSWORD)).status, 201);
});

test('changing the password clears the temporary password\'s expiry date', async t => {
    const u = person({ must_change_password: true, temp_expired: false, temp_password_until: new Date(Date.now() + 3600e3) });
    const e = await setup(t, [u]);
    const { body: { token } } = await e.login('juan', PASSWORD);
    assert.equal((await e.request('/api/session/password', 'POST', { current: PASSWORD, new_password: 'my-own-password-9' }, { authorization: `Bearer ${token}` })).status, 204);
    assert.equal(u.temp_password_until, null);
});

test('72 hours is the validity', () => {
    assert.equal(auth.TEMP_PASSWORD_HOURS, 72);
});
