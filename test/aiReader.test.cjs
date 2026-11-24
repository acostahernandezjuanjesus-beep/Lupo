const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../aiReader');

// A fake DeepSeek response with this content.
const response = (content, extra = {}) => ({ ok: true, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop', ...extra }] }) });
const strip = obj => JSON.stringify({ folio: null, issuer_name: null, issuer_rfc: null, invoice_date: null, subtotal: null, vat: null, total: null, pages: null, lines: [], ...obj });

test('normalize: what does not have the shape of its field is null, not an "almost" value', () => {
    const n = L.normalizeStrip({ folio: 'A-1187', issuer_name: 'ACEROS SA', issuer_rfc: 'eku9003173c9', invoice_date: '2026-09-14',
        subtotal: '$12,018.10', vat: '1,922.90', total: '13941.00', pages: '1 de 2', lines: [] });
    assert.equal(n.issuer_rfc, 'EKU9003173C9'); assert.equal(n.subtotal, '12018.10'); assert.equal(n.vat, '1922.90'); assert.equal(n.total, '13941.00');
    const m = L.normalizeStrip({ issuer_rfc: 'EKU90031', invoice_date: '2026-02-31', total: 'thirteen thousand', subtotal: '12.3.4', folio: '' });
    assert.equal(m.issuer_rfc, null, 'a cut-off RFC is not accepted'); assert.equal(m.invoice_date, null, 'a date that does not exist is not a date');
    assert.equal(m.total, null); assert.equal(m.subtotal, null); assert.equal(m.folio, null);
    assert.equal(L.normalizeStrip('text'), null); assert.equal(L.normalizeStrip([1]), null); assert.equal(L.normalizeStrip(null), null);
});

test('normalize lines: no description, no line; numbers are exact text', () => {
    const n = L.normalizeStrip({ lines: [
        { description: 'TAQUETE', quantity: '100', unit: 'PZA', unit_value: '0.258', amount: '25.80' },
        { description: '', amount: '5' }, { quantity: '2' }, null,
        { description: 'ODD', quantity: 'two', unit_value: '1.2.3', amount: 'x' }] });
    assert.equal(n.lines.length, 2);
    assert.equal(n.lines[0].unit_value, '0.258', 'the third decimal of the unit price is kept');
    assert.deepEqual([n.lines[1].quantity, n.lines[1].unit_value, n.lines[1].amount], [null, null, null]);
});

test('merge fields: agreement, single reading, majority and conflict', () => {
    assert.deepEqual(L.mergeField([null, null]), { value: null, readings: 0, agreement: 'none' });
    assert.equal(L.mergeField(['7161.64', null, '7161.64']).agreement, 'confirmed');
    assert.equal(L.mergeField([null, '7161.64']).agreement, 'single_reading');
    const maj = L.mergeField(['2026-09-01', '2026-09-01', '2025-09-01']);
    assert.equal(maj.value, '2026-09-01'); assert.equal(maj.agreement, 'majority'); assert.equal(maj.others[0].value, '2025-09-01');
    const c = L.mergeField(['2026-09-01', '2025-09-01']);
    assert.equal(c.value, null, 'two different readings and no winner: none is picked, the conflict is shown');
    assert.equal(c.agreement, 'conflict'); assert.equal(c.conflict.length, 2);
});

test('merge lines: the overlap does not duplicate, and the fuller description is kept', () => {
    const a = { description: 'TUBO INOXIDABLE 304 2 1/2"', quantity: '6', unit: null, unit_value: null, amount: '8913.00' };
    const b = { description: 'TUBO INOXIDABLE 304 2 1/2" CED 10 PARA OT-2215', quantity: null, unit: 'METRO LINEAL', unit_value: '1485.50', amount: '8913.00' };
    const other = { description: 'REDONDO DE NYLON', quantity: '2', unit: 'PIEZA', unit_value: '842.15', amount: '1684.30' };
    const r = L.mergeStrips([L.normalizeStrip({ lines: [a] }), L.normalizeStrip({ lines: [b, other] })]);
    assert.equal(r.lines.length, 2);
    assert.equal(r.lines[0].description, b.description); assert.equal(r.lines[0].strips, 2);
    assert.equal(r.lines[0].unit, 'METRO LINEAL'); assert.equal(r.lines[0].quantity, '6', 'fills in what the other strip lacked');
});

test('extractJson: with ```, with text around it, and garbage is null', () => {
    assert.deepEqual(L.extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(L.extractJson('Sure: {"a":1} done'), { a: 1 });
    assert.equal(L.extractJson('no json here'), null); assert.equal(L.extractJson('{broken'), null); assert.equal(L.extractJson(undefined), null);
});

test('readStrip: the request carries the system prompt, the image, low reasoning, and never asks for the UUID', async () => {
    let sent;
    const r = await L.readStrip('QUJD', { key: 'k', fetchFn: async (url, op) => { sent = { url, op, body: JSON.parse(op.body) }; return response(strip({ total: '7161.64' })); } });
    assert.equal(r.status, 'ok'); assert.equal(r.reading.total, '7161.64');
    const c = sent.body;
    assert.equal(c.reasoning_effort, 'low'); assert.equal(c.temperature, 0); assert.equal(c.max_tokens, 6000);
    assert.equal(c.messages[0].role, 'system'); assert.match(c.messages[0].content, /Do NOT transcribe the fiscal folio/);
    assert.equal(c.messages[1].content[0].image_url.url, 'data:image/jpeg;base64,QUJD');
    assert.equal(sent.op.headers.Authorization, 'Bearer k');
    assert.ok(!/"uuid"/i.test(c.messages[0].content.split('Return ONLY')[1]), 'the output contract has no uuid');
});

test('readStrip: no convergence, HTTP 500, no JSON and no network are statuses, not exceptions', async () => {
    const empty = await L.readStrip('x', { key: 'k', fetchFn: async () => response('', { finish_reason: 'length' }) });
    assert.deepEqual([empty.status, empty.detail], ['no_converge', 'length']);
    assert.equal((await L.readStrip('x', { key: 'k', fetchFn: async () => ({ ok: false, status: 500 }) })).status, 'error');
    assert.equal((await L.readStrip('x', { key: 'k', fetchFn: async () => response('I cannot read this') })).status, 'bad_format');
    assert.equal((await L.readStrip('x', { key: 'k', fetchFn: async () => { throw new Error('ECONNRESET'); } })).status, 'error');
});

test('readStrips: a failing strip does not take down the rest; read 3 at a time; the result says how many answered', async () => {
    let running = 0, peak = 0, calls = 0;
    const fetchFn = async () => {
        const i = calls++; running++; peak = Math.max(peak, running);
        await new Promise(r => setTimeout(r, 15)); running--;
        if (i === 2) return { ok: false, status: 429 };
        return response(strip(i === 4 ? { total: '7161.64', lines: [{ description: 'X', amount: '1.00' }] } : i === 5 ? { total: '7161.64' } : {}));
    };
    const r = await L.readStrips(Array(8).fill('QUJD'), { key: 'k', fetchFn });
    assert.equal(r.strips.total, 8); assert.equal(r.strips.read, 7); assert.deepEqual(r.strips.failures, { error: 1 });
    assert.ok(peak <= 3 && peak >= 2, `parallelism ${peak}`);
    assert.equal(r.fields.total.value, '7161.64'); assert.equal(r.fields.total.agreement, 'confirmed');
    assert.equal(r.fields.invoice_date.value, null); assert.equal(r.fields.invoice_date.agreement, 'none');
    assert.equal(r.lines.length, 1);
    assert.ok(!('uuid' in r.fields), 'the draft has no UUID');
});
