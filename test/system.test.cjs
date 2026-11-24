const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('../scripts/loadTS.cjs');
const { systemProblems, readableBytes, duration } = load('system.ts');

// What the admin sees on Home when something is wrong. It must not stay quiet too often or shout too much.

const healthy = () => ({
    backup: { status: 'ok', hours_ago: 5 },
    migrations: { registry: true, applied: 14, pending: [] },
    database: { response_ms: 3, connections: { total: 2, idle: 2, waiting: 0 } },
});

test('all fine: no warnings (including when backups are not configured)', () => {
    assert.deepEqual(systemProblems(healthy()), []);
    assert.deepEqual(systemProblems({ ...healthy(), backup: { status: 'unconfigured', hours_ago: null } }), []);
});

test('a late backup or no backup record ALWAYS warns: not knowing is not being fine', () => {
    assert.match(systemProblems({ ...healthy(), backup: { status: 'late', hours_ago: 60.4 } })[0], /60 hours ago/);
    assert.match(systemProblems({ ...healthy(), backup: { status: 'no_record', hours_ago: null } })[0], /no backup on record/);
});

test('pending migrations, a slow database and requests waiting for a connection', () => {
    const d = { ...healthy(), migrations: { registry: true, applied: 14, pending: ['032_x.sql'] }, database: { response_ms: 2500, connections: { total: 10, idle: 0, waiting: 3 } } };
    assert.equal(systemProblems(d).length, 3);
});

test('no migration registry (applied by hand) is not a warning: there is nothing to say', () => {
    assert.deepEqual(systemProblems({ ...healthy(), migrations: { registry: false, applied: null, pending: null } }), []);
});

test('readable sizes and durations; unknown is a dash, not a zero', () => {
    assert.equal(readableBytes('111807'), '111.8 KB');
    assert.equal(readableBytes(9821207), '9.8 MB');
    assert.equal(readableBytes(null), '—');
    assert.equal(readableBytes('x'), '—');
    assert.deepEqual([45, 600, 7200, 200000].map(duration), ['45 s', '10 min', '2 h', '2 d']);
});
