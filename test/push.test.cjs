const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const createPush = require('../push');
const { readSubscription } = createPush;
const { Rejection } = require('../util');
const { skip, createDb } = require('../scripts/testDb.cjs');

// Phone notifications (Web Push). What matters: the server only talks to the browsers' push services (or a
// storekeeper account could use it to probe internal addresses), the notice only goes to storekeeper and admin,
// and it never makes the thing that triggers it fail.

const GOOD = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
const BAD = (body, re) => assert.throws(() => readSubscription(body), e => e instanceof Rejection && e.status === 400 && re.test(e.message));

test('readSubscription: accepts the browsers\' push services and nothing else', () => {
    assert.deepEqual(readSubscription(GOOD), { endpoint: GOOD.endpoint, p256dh: GOOD.keys.p256dh, auth: GOOD.keys.auth });
    for (const endpoint of ['https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Qx', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
        assert.equal(readSubscription({ ...GOOD, endpoint }).endpoint, endpoint);
    }
    for (const endpoint of ['http://fcm.googleapis.com/x', 'https://127.0.0.1/x', 'https://localhost/x', 'https://169.254.169.254/latest', 'https://evil.com/fcm.googleapis.com',
        'https://fcm.googleapis.com.evil.com/x', 'https://evilfcm.googleapis.com.attacker.net/x', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'file:///etc/passwd', 'x', '']) {
        BAD({ ...GOOD, endpoint }, /endpoint|not allowed/);
    }
    BAD({ ...GOOD, endpoint: 5 }, /endpoint/);
    BAD({ ...GOOD, endpoint: GOOD.endpoint + 'a'.repeat(2100) }, /endpoint/);
    BAD({ endpoint: GOOD.endpoint }, /keys/);
    BAD({ ...GOOD, keys: { p256dh: 'x', auth: 'y' } }, /keys/);
    BAD(null, /endpoint/);
});

let testDb, pool, server, url, me;
const sent = [];
let failure = null;
const users = {};

before(async () => {
    if (skip) return;
    testDb = await createDb('push');
    pool = testDb.pool;
    for (const [key, role] of [['op', 'operator'], ['sk', 'storekeeper'], ['sk2', 'storekeeper'], ['adm', 'admin']]) {
        const { rows: [u] } = await pool.query(`INSERT INTO users (name, username, role) VALUES ($1::text, $1::text, $2) RETURNING id, name, role`, [`test-${key}`, role]);
        users[key] = u;
    }
    await pool.query(`INSERT INTO products (code, name) VALUES ('P-1', 'Test product')`);
    const push = createPush(pool, { send: async (sub, body, options) => { if (failure) throw failure; sent.push({ sub, body: JSON.parse(body), options }); } });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = me; next(); });
    // index.js puts this route behind the storekeeper/admin role; it is repeated here to test that the operator is kept out
    app.use('/api/push', (req, res, next) => ['storekeeper', 'admin'].includes(req.user.role) ? next() : res.status(403).json({ error: 'no' }), push.router);
    app.use('/api/requests', require('../requests')(pool, { notify: push.notify }));
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    url = `http://127.0.0.1:${server.address().port}`;
}, { timeout: 120_000 });

after(async () => {
    if (skip) return;
    await new Promise(r => server.close(r));
    await testDb.close();
});

const as = key => { me = users[key]; };
const call = async (path, method = 'GET', body) => {
    const r = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const sub = n => ({ ...GOOD, endpoint: `https://fcm.googleapis.com/fcm/send/${n}` });
const pause = () => new Promise(r => setTimeout(r, 200));
const count = async n => (await pool.query('SELECT count(*)::int AS n FROM push_subscriptions WHERE endpoint LIKE $1', [`%${n}`])).rows[0].n;

test('the public key is generated once and is always the same', { skip }, async () => {
    as('sk');
    const a = await call('/api/push/key');
    const b = await call('/api/push/key');
    assert.equal(a.status, 200);
    assert.match(a.body.key, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal(a.body.key, b.body.key);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM push_keys')).rows[0].n, 1);
});

test('subscribing: it belongs to whoever holds the session; if someone else signs in on that browser, it moves to them', { skip }, async () => {
    as('sk');
    assert.equal((await call('/api/push/subscriptions', 'POST', { ...sub('phone-1'), user_id: users.adm.id })).status, 201);
    assert.equal((await pool.query('SELECT user_id FROM push_subscriptions WHERE endpoint LIKE $1', ['%phone-1'])).rows[0].user_id, users.sk.id);
    as('adm');
    assert.equal((await call('/api/push/subscriptions', 'POST', sub('phone-1'))).status, 201);
    assert.equal((await pool.query('SELECT user_id FROM push_subscriptions WHERE endpoint LIKE $1', ['%phone-1'])).rows[0].user_id, users.adm.id);
    assert.equal(await count('phone-1'), 1, 'one row per device');
    assert.equal((await call('/api/push/subscriptions', 'POST', { ...GOOD, endpoint: 'https://127.0.0.1/x' })).status, 400);
});

test('removing: only your own device', { skip }, async () => {
    as('sk');
    await call('/api/push/subscriptions', 'POST', sub('phone-2'));
    as('adm');
    await call('/api/push/subscriptions', 'DELETE', { endpoint: sub('phone-2').endpoint });
    assert.equal(await count('phone-2'), 1, 'someone else\'s is not removed');
    as('sk');
    await call('/api/push/subscriptions', 'DELETE', { endpoint: sub('phone-2').endpoint });
    assert.equal(await count('phone-2'), 0);
    assert.equal((await call('/api/push/subscriptions', 'DELETE', {})).status, 400);
});

test('device limit per person', { skip }, async () => {
    as('sk2');
    for (let i = 0; i < 10; i++) assert.equal((await call('/api/push/subscriptions', 'POST', sub(`m-${i}`))).status, 201);
    assert.equal((await call('/api/push/subscriptions', 'POST', sub('m-10'))).status, 409);
    assert.equal((await call('/api/push/subscriptions', 'POST', sub('m-3'))).status, 201, 're-registering one they already have does not count');
});

test('a request notifies storekeeper and admin, not whoever made it nor the operator; and it signs with the server keys', { skip }, async () => {
    await pool.query('DELETE FROM push_subscriptions');
    as('sk'); await call('/api/push/subscriptions', 'POST', sub('sk-phone'));
    as('adm'); await call('/api/push/subscriptions', 'POST', sub('adm-phone'));
    await pool.query('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)',
        [users.op.id, sub('op-phone').endpoint, GOOD.keys.p256dh, GOOD.keys.auth]);
    sent.length = 0;
    const { id: product } = (await pool.query('SELECT id FROM products LIMIT 1')).rows[0];

    as('adm');
    assert.equal((await call('/api/requests', 'POST', { items: [{ product_id: product, quantity: 1 }] })).status, 201);
    await pause();
    assert.deepEqual(sent.map(e => e.sub.endpoint).sort(), [sub('sk-phone').endpoint], 'the admin who asked is not notified; the operator never is');
    const e = sent[0];
    assert.equal(e.body.url, '/requests');
    assert.match(e.body.body, /test-adm: 1 product/);
    assert.equal(e.options.vapidDetails.publicKey, (await call('/api/push/key')).body.key);
    assert.equal(e.options.urgency, 'high');
});

test('a notice that fails does not fail the request; a dead subscription (410) is deleted and a passing error (500) is kept', { skip }, async () => {
    as('sk'); await call('/api/push/subscriptions', 'POST', sub('dead'));
    const { id: product } = (await pool.query('SELECT id FROM products LIMIT 1')).rows[0];
    as('adm');

    failure = Object.assign(new Error('gone'), { statusCode: 410 });
    assert.equal((await call('/api/requests', 'POST', { items: [{ product_id: product, quantity: 1 }] })).status, 201);
    await pause();
    assert.equal(await count('dead'), 0);

    as('sk'); await call('/api/push/subscriptions', 'POST', sub('passing'));
    as('adm');
    failure = Object.assign(new Error('boom'), { statusCode: 500 });
    assert.equal((await call('/api/requests', 'POST', { items: [{ product_id: product, quantity: 1 }] })).status, 201);
    await pause();
    assert.equal(await count('passing'), 1);
    failure = null;
});

test('the operator does not get through /api/push (the route is for storekeeper and admin)', { skip }, async () => {
    as('op');
    assert.equal((await call('/api/push/key')).status, 403);
});
