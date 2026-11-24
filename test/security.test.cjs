const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// Headers, request id, access log and body errors.
// No database: the real identity queries a double that finds no session (401) or fails (500).

async function serve(t, { pool, proxy = false, accessLog = null } = {}) {
    pool ??= { async query() { return { rows: [] }; }, async connect() { return { query: this.query, release() {} }; } };
    const prev = process.env.LUPO_PROXY;
    if (proxy) process.env.LUPO_PROXY = '1'; else delete process.env.LUPO_PROXY;
    const server = createApp(pool, undefined, { accessLog }).listen(0, '127.0.0.1');
    if (prev === undefined) delete process.env.LUPO_PROXY; else process.env.LUPO_PROXY = prev;
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    return `http://127.0.0.1:${server.address().port}`;
}

test('every response carries the security headers, and the API is not cached', async t => {
    const base = await serve(t);
    const r = await fetch(`${base}/api/products`);
    assert.equal(r.status, 401);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'no inline scripts: that is what protects the token');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src blob:/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.headers.get('permissions-policy'), /camera=\(self\)/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-powered-by'), null);
});

test('HSTS only over HTTPS: with a trusted proxy and X-Forwarded-Proto, not over plain HTTP', async t => {
    const plain = await serve(t);
    assert.equal((await fetch(`${plain}/api/health`)).headers.get('strict-transport-security'), null);
    const behind = await serve(t, { proxy: true });
    const r = await fetch(`${behind}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(r.headers.get('strict-transport-security'), /max-age=\d+/);
    // without trusting the proxy that header is worthless: anyone could write it
    assert.equal((await fetch(`${plain}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } })).headers.get('strict-transport-security'), null);
});

test('each request gets its own id and the client\'s is ignored', async t => {
    const base = await serve(t);
    const a = (await fetch(`${base}/api/health`, { headers: { 'X-Request-Id': 'injected' } })).headers.get('x-request-id');
    const b = (await fetch(`${base}/api/health`)).headers.get('x-request-id');
    assert.match(a, /^[0-9a-f-]{36}$/);
    assert.notEqual(a, 'injected');
    assert.notEqual(a, b);
});

test('access log: one JSON line with id, IP, path without query and status; never the token or the body', async t => {
    const lines = [];
    const base = await serve(t, { accessLog: l => lines.push(JSON.parse(l)) });
    const r = await fetch(`${base}/api/products?q=searched-secret`, { headers: { Authorization: 'Bearer very-secret-token' } });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(lines.length, 1);
    const l = lines[0];
    assert.equal(l.id, r.headers.get('x-request-id'));
    assert.match(l.ip, /127\.0\.0\.1$/);
    assert.deepEqual([l.m, l.path, l.s, l.u], ['GET', '/api/products', 401, null]);
    assert.ok(Number.isInteger(l.ms) && l.ms >= 0 && !isNaN(Date.parse(l.t)));
    assert.doesNotMatch(JSON.stringify(l), /secret/);
});

test('the healthcheck does not fill the log when it is fine, but does when it fails', async t => {
    const lines = [];
    let down = false;
    const pool = { async query() { if (down) throw new Error('database down'); return { rows: [] }; } };
    const base = await serve(t, { pool, accessLog: l => lines.push(JSON.parse(l)) });
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(lines.length, 0);
    down = true;
    assert.equal((await fetch(`${base}/api/health`)).status, 503);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(lines.map(l => l.s), [503]);
});

test('body errors: broken JSON is 400, huge body 413, odd charset 415 — none is a 500', async t => {
    const base = await serve(t);
    const send = (body, type = 'application/json') => fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': type }, body });
    assert.equal((await send('{broken')).status, 400);
    assert.equal((await send(JSON.stringify({ x: 'a'.repeat(200_000) }))).status, 413);
    const r = await send('{}', 'application/json; charset=iso-8859-1');
    assert.equal(r.status, 415);
    assert.deepEqual(await r.json(), { error: 'Invalid request' });
});

test('a server error answers 500 with no details and with the id that is in the log', async t => {
    const quiet = console.error; console.error = () => {};
    t.after(() => { console.error = quiet; });
    const pool = { async query() { throw new Error('/srv/app/secret.js: failed'); } };
    const base = await serve(t, { pool });
    const r = await fetch(`${base}/api/products`, { headers: { Authorization: 'Bearer x' } });
    assert.equal(r.status, 500);
    const body = await r.json();
    assert.equal(body.id, r.headers.get('x-request-id'));
    assert.equal(body.error, 'Internal server error');
    assert.doesNotMatch(JSON.stringify(body), /secret|srv/);
});
