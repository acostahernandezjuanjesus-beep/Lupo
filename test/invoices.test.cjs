const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const { buildInvoice } = require('../invoices');

// All made up: fake RFCs and UUIDs (see cfdi.test.cjs).
const UUID = 'A1B2C3D4-0000-4000-8000-0123456789AB';
const QR = `https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?id=${UUID}&re=AAA010101AAA&rr=BBB020202BB1&tt=0000007161.640000&fe=abcd1234`;
const SEAL = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxxxxxxxxxxabcd1234';
const xml = (extra = '') => `<?xml version="1.0"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Serie="A" Folio="1234" Fecha="2026-09-01T10:30:00" SubTotal="6173.83" Total="7161.64" Moneda="MXN" MetodoPago="PPD" TipoDeComprobante="I">
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="ACEROS DEL NORTE"/><cfdi:Receptor Rfc="BBB020202BB1" Nombre="TALLER" UsoCFDI="G03"/>
  <cfdi:Conceptos><cfdi:Concepto Cantidad="3" Unidad="KG" Descripcion="BARRA REDONDA ${extra}" ValorUnitario="690.4" Importe="2071.33"/></cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="987.81"/>
  <cfdi:Complemento><tfd:TimbreFiscalDigital UUID="${UUID}" FechaTimbrado="2026-09-01T10:31:02" SelloCFD="${SEAL}"/></cfdi:Complemento>
</cfdi:Comprobante>`;

// ---------- The policy of what wins, no database ----------

test('XML: the UUID comes from the file, and anything extra the client sends is ignored', () => {
    const r = buildInvoice({ xml: xml(), uuid: 'B1B2C3D4-0000-4000-8000-0123456789AB', manual_uuid: 'B1B2C3D4-0000-4000-8000-0123456789AB',
        total: '1.00', issuer_name: 'OTHER', invoice_date: '2020-01-01', captured_by: 999 });
    const d = r.data;
    assert.equal(d.source, 'xml'); assert.equal(d.uuid, UUID); assert.equal(d.uuid_source, 'xml');
    assert.equal(d.total, '7161.64', 'the XML rules over the typed total');
    assert.equal(d.issuer_name, 'ACEROS DEL NORTE'); assert.equal(d.invoice_date, '2026-09-01');
    assert.equal(d.date_confirmed, true, 'the XML confirms the date by itself');
    assert.equal(d.lines[0].amount, '2071.33', 'printed amount, not 3 x 690.4');
    assert.equal('captured_by' in d, false);
});
test('photo with no QR and no typed UUID: ends up WITHOUT a UUID, never an invented one', () => {
    const d = buildInvoice({ source: 'photo', total: '100', uuid: UUID }).data;
    assert.equal(d.uuid, null); assert.equal(d.uuid_source, null);
});
test('UUID typed by a person: accepted with its source; malformed, not', () => {
    const d = buildInvoice({ source: 'photo', total: '100', manual_uuid: UUID.toLowerCase() }).data;
    assert.equal(d.uuid, UUID); assert.equal(d.uuid_source, 'manual');
    assert.match(buildInvoice({ source: 'photo', total: '100', manual_uuid: 'nope' }).error, /UUID/);
});
test('photo with a readable QR: the UUID and the total come from the QR', () => {
    const d = buildInvoice({ source: 'photo', qr: QR }).data;
    assert.equal(d.uuid, UUID); assert.equal(d.uuid_source, 'qr'); assert.equal(d.total, '7161.64');
    assert.equal(d.issuer_rfc, 'AAA010101AAA');
    assert.equal(d.date_confirmed, false, 'the QR has no date');
});
test('a typed total that contradicts the QR is not saved', () => {
    const r = buildInvoice({ source: 'photo', qr: QR, total: '5979.09' });
    assert.equal(r.conflict.error_code, 'total_mismatch');
    assert.equal(buildInvoice({ source: 'photo', qr: QR, total: '7161.640' }).data.total, '7161.64', 'the same amount written differently passes');
});
test('XML and QR from different sheets: neither is saved', () => {
    const r = buildInvoice({ xml: xml(), qr: QR.replace('0000007161.640000', '0000000001.000000') });
    assert.equal(r.conflict.error_code, 'mismatch'); assert.deepEqual(r.conflict.discrepancies, ['total']);
});
test('date: without XML it is only confirmed if the person marks it, and only if there is a date', () => {
    assert.equal(buildInvoice({ source: 'photo', total: '1', invoice_date: '2026-09-01' }).data.date_confirmed, false);
    assert.equal(buildInvoice({ source: 'photo', total: '1', invoice_date: '2026-09-01', date_confirmed: true }).data.date_confirmed, true);
    assert.equal(buildInvoice({ source: 'photo', total: '1', date_confirmed: true }).data.date_confirmed, false);
    assert.match(buildInvoice({ source: 'photo', total: '1', invoice_date: '2026-02-31' }).error, /invoice_date/);
});
test('validation: malformed input is an error with its name, not a Postgres 500', () => {
    for (const [body, error] of [
        [{}, /source/], [{ source: 'ai', total: '1' }, /source/], [{ source: 'qr', total: '1' }, /QR/], [{ source: 'photo' }, /total/],
        [{ source: 'photo', total: 'lots' }, /total/], [{ source: 'photo', total: '1', purchase_type: 'weird' }, /purchase_type/],
        [{ source: 'photo', total: '1', payment_method: 'XX' }, /payment_method/], [{ source: 'photo', total: '1', issuer_rfc: 'xx' }, /issuer_rfc/],
        [{ source: 'photo', total: '1', lines: [{ description: '' }] }, /description/], [{ source: 'photo', total: '1', lines: 'x' }, /list/],
        [{ source: 'photo', total: '1', supplier_ids: [1] }, /supplier_ids/], [{ source: 'photo', total: '1', series: 'x'.repeat(26) }, /series/],
        [{ source: 'photo', total: '1234567890123.00' }, /total/],
    ]) assert.match(buildInvoice(body).error ?? '', error, JSON.stringify(body).slice(0, 60));
});
test('unclassified by default: the purchase type is not guessed', () => {
    assert.equal(buildInvoice({ source: 'photo', total: '1' }).data.purchase_type, 'unclassified');
});

// ---------- The HTTP contract ----------

async function setup(t, role = 'storekeeper', { existing = null, failWith = null } = {}) {
    const inserts = [];
    const pool = {
        async query(sql, args = []) {
            if (/INSERT INTO invoices/.test(sql)) {
                inserts.push({ sql, args });
                if (failWith) { const e = new Error('x'); e.code = failWith; throw e; }
                return { rows: [{ id: 7 }] };
            }
            if (/INSERT INTO invoice_lines/.test(sql)) { inserts.push({ sql, args }); return { rows: [] }; }
            if (/FROM invoices WHERE uuid/.test(sql)) return { rows: existing ? [existing] : [] };
            if (/SELECT COUNT/.test(sql)) return { rows: [{ count: '0' }] };
            if (/count\(\*\) FILTER/.test(sql)) return { rows: [{ to_pay: 0, to_pay_amount: null, overdue: 0, overdue_amount: null }] };
            if (/FROM invoice_lines/.test(sql)) return { rows: [] };
            if (/FROM invoices f/.test(sql) && /f\.id = \$1/.test(sql)) return { rows: [{ id: 7, total: '10.00' }] };
            if (/UPDATE invoices/.test(sql)) { inserts.push({ sql, args }); return { rowCount: 1 }; }
            return { rows: [] };
        },
        async connect() { return { query: this.query.bind(this), release() {} }; },
    };
    const identity = {
        // x-role: none means no session: 401, like the real one.
        requireSession: () => (req, res, next) => {
            const r = req.get('x-role') ?? role;
            if (r === 'none') return res.status(401).json({ error: 'no session' });
            req.user = { id: 7, role: r }; next();
        },
        requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'no permission' }),
    };
    const server = createApp(pool, identity).listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    t.after(() => new Promise(r => server.close(r)));
    const url = `http://127.0.0.1:${server.address().port}/api/invoices`;
    const call = async (route, method = 'GET', body, headers = {}) => {
        const r = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { call, inserts };
}

test('permissions: no session 401; operator 403 on EVERY route; storekeeper and admin get in', async t => {
    const e = await setup(t);
    for (const [route, method, body] of [['', 'GET'], ['/7', 'GET'], ['', 'POST', { source: 'photo', total: '1' }],
        ['/7', 'PATCH', { note: 'x' }], ['/read-qr', 'POST', { text: QR }], ['/read-xml', 'POST', { xml: xml() }],
        ['/categories', 'GET'], ['/files/3', 'GET'], ['/files/3', 'DELETE'], ['/7/files', 'POST', { x: 1 }],
        ['/read-photo', 'POST', { strips: ['x'] }], ['/7/reconciliation', 'GET'], ['/7/lines/1/stock-in', 'POST', { product_id: 1 }],
        ['/7/lines/1/no-stock-in', 'POST', {}], ['/7/lines/1/undo', 'POST']]) {
        assert.equal((await e.call(route, method, body, { 'x-role': 'none' })).status, 401, `${method} ${route}`);
        assert.equal((await e.call(route, method, body, { 'x-role': 'operator' })).status, 403, `${method} ${route}`);
    }
    for (const role of ['storekeeper', 'admin']) assert.equal((await e.call('', 'GET', undefined, { 'x-role': role })).status, 200);
    assert.equal(e.inserts.length, 0, 'nothing was written by the rejections');
});
test('save: the author comes from the session even if the body says another', async t => {
    const e = await setup(t);
    const r = await e.call('', 'POST', { xml: xml(), captured_by: 999 });
    assert.equal(r.status, 201); assert.equal(r.body.uuid, UUID); assert.equal(r.body.lines, 1);
    const args = e.inserts.find(x => /INSERT INTO invoices/.test(x.sql)).args;
    assert.equal(args[13], 7, 'captured_by = session user');
    assert.equal(args[1], UUID); assert.equal(args[2], 'xml');
});
test('an XML over 100 KB goes through (the global cap does not apply), and one over 3 MB does not', async t => {
    const e = await setup(t);
    // The padding goes in an XML comment: inside a description the server would rightly reject it (max 500 characters).
    const padded = n => xml().replace('<cfdi:Emisor', `<!--${'x'.repeat(n)}--><cfdi:Emisor`);
    assert.equal((await e.call('', 'POST', { xml: padded(150_000) })).status, 201);
    assert.equal((await e.call('', 'POST', { xml: padded(3_200_000) })).status, 413);
});
test('duplicate: 409 with the invoice that was already there', async t => {
    const e = await setup(t, 'storekeeper', { failWith: '23505', existing: { id: 3, invoice_date: '2026-09-01', total: '7161.64', issuer_name: 'ACEROS' } });
    const r = await e.call('', 'POST', { xml: xml() });
    assert.equal(r.status, 409); assert.equal(r.body.error_code, 'duplicate_invoice'); assert.equal(r.body.existing.id, 3);
});
test('XML and QR that do not match: 409 and nothing is written', async t => {
    const e = await setup(t);
    const r = await e.call('', 'POST', { xml: xml(), qr: QR.replace('AAA010101AAA', 'CCC030303CC3') });
    assert.equal(r.status, 409); assert.deepEqual(r.body.discrepancies, ['issuer_rfc']);
    assert.equal(e.inserts.length, 0);
});
test('read QR and read XML: they do not save, and say whether it was already registered', async t => {
    const e = await setup(t, 'storekeeper', { existing: { id: 3, invoice_date: null, total: '1.00', issuer_name: 'X' } });
    const q = await e.call('/read-qr', 'POST', { text: QR });
    assert.equal(q.status, 200); assert.equal(q.body.qr.uuid, UUID); assert.equal(q.body.already_registered.id, 3);
    assert.equal((await e.call('/read-qr', 'POST', { text: 'https://example.com' })).status, 400);
    const x = await e.call('/read-xml', 'POST', { xml: xml(), qr: QR });
    assert.equal(x.status, 200); assert.deepEqual(x.body.discrepancies, []); assert.equal(x.body.invoice.total, '7161.64');
    assert.equal(e.inserts.length, 0);
});
test('list and fetch: invalid filters are 400; invalid id 400', async t => {
    const e = await setup(t);
    assert.equal((await e.call('?status=weird')).status, 400);
    assert.equal((await e.call('?purchase_type=weird')).status, 400);
    assert.equal((await e.call('/abc')).status, 400);
    const l = await e.call('?status=to_pay');
    assert.equal(l.status, 200); assert.equal(l.body.summary.to_pay_amount, null, 'with no invoices the sum is null, not 0');
});
test('update: UUID and total can NOT be changed; a corrected date ends up confirmed', async t => {
    const e = await setup(t);
    assert.equal((await e.call('/7', 'PATCH', { uuid: UUID, total: '1.00' })).status, 400, 'nothing to change: those fields are not editable');
    assert.equal((await e.call('/7', 'PATCH', { purchase_type: 'weird' })).status, 400);
    assert.equal((await e.call('/7', 'PATCH', { paid_at: '2026-13-40' })).status, 400);
    const r = await e.call('/7', 'PATCH', { invoice_date: '2026-09-01', purchase_type: 'direct_to_job' });
    assert.equal(r.status, 200);
    const u = e.inserts.find(x => /UPDATE invoices/.test(x.sql));
    assert.match(u.sql, /date_confirmed/); assert.ok(u.args.includes(true));
    assert.doesNotMatch(u.sql, /uuid|total/);
});

// ---------- What a file really is ----------

test('realType: by the first bytes, not by what the client declares', () => {
    const { realType } = require('../invoices');
    const b = (...parts) => Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
    assert.equal(realType(b('%PDF-1.7 rest')), 'application/pdf');
    assert.equal(realType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
    assert.equal(realType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
    assert.equal(realType(b('RIFF', Buffer.from([1, 2, 3, 4]), 'WEBPVP8 ')), 'image/webp');
    assert.equal(realType(b(Buffer.from([0xef, 0xbb, 0xbf]), '  <?xml version="1.0"?><a/>')), 'application/xml', 'with BOM and spaces');
    for (const bad of ['{"a":1}', 'MZ an executable', '', 'GIF89a...']) assert.equal(realType(Buffer.from(bad)), null, JSON.stringify(bad));
});

test('read-photo: no key 503, and it validates the strips before calling anyone', async t => {
    const e = await setup(t);
    const before = process.env.DEEPSEEK_API_KEY;
    t.after(() => { if (before === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = before; });
    delete process.env.DEEPSEEK_API_KEY;
    assert.equal((await e.call('/read-photo', 'POST', { strips: [] })).status, 503, 'no key: there is no reader, and it says so');
    process.env.DEEPSEEK_API_KEY = 'test-key';           // never used: everything is rejected before
    for (const [body, why] of [[{}, 'no strips'], [{ strips: [] }, 'empty list'], [{ strips: 'x' }, 'not a list'],
        [{ strips: Array(17).fill('/9j/4AAQSkZJRg==') }, 'more than 16'], [{ strips: [123] }, 'not text'],
        [{ strips: ['not base64 !!!'] }, 'not base64'],
        [{ strips: [Buffer.from('%PDF-1.7 hello world').toString('base64')] }, 'a PDF claiming to be a strip'],
        [{ strips: [Buffer.from('MZ some executable').toString('base64')] }, 'an executable']]) {
        const r = await e.call('/read-photo', 'POST', body);
        assert.equal(r.status, 400, why);
    }
    assert.equal(e.inserts.length, 0);
});

test('reconciliation: invalid ids are 400 before touching the database, and quantity is validated without padding zeros', async t => {
    const e = await setup(t);
    for (const [route, method, body] of [['/x/reconciliation', 'GET'], ['/7/lines/x/stock-in', 'POST', { product_id: 1 }],
        ['/7/lines/1/stock-in', 'POST', {}], ['/7/lines/1/stock-in', 'POST', { product_id: 'x' }],
        ['/7/lines/1/stock-in', 'POST', { product_id: 1, learn: 'yes' }],
        ['/0/lines/1/no-stock-in', 'POST', {}], ['/7/lines/1/no-stock-in', 'POST', { product_id: 'x' }], ['/7/lines/-1/undo', 'POST']]) {
        assert.equal((await e.call(route, method, body)).status, 400, `${method} ${route}`);
    }
    const { isValidQuantity } = require('../reconciliation');
    assert.equal(isValidQuantity('5.000000'), '5', 'the zeros of numeric(18,6) are not a fraction');
    assert.equal(isValidQuantity('2.500000'), '2.5');
    assert.equal(isValidQuantity('0.125'), '0.125');
    for (const bad of ['0', '0.000000', '-1', '1.2345', 'two', '', null, undefined, '1e3', '1,5', 1e10]) assert.equal(isValidQuantity(bad), null, String(bad));
    assert.equal(e.inserts.length, 0);
});
