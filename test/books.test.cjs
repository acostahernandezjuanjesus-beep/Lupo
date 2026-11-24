const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const { readXlsx, XlsxError } = require('../xlsx');
const L = require('../books');
const { zip, xlsx, F, HEADER, sheetOf } = require('./xlsxFixture.cjs');

// Importing a purchase book from its Excel file (xlsx.js and books.js). All data is made up: the .xlsx files are
// built here with the same zip + XML layout Excel writes.

// ---------- xlsx.js ----------

test('xlsx: reads strings, numbers, dates by format, booleans, inline text and formulas with their stored value', () => {
    const { sheets } = readXlsx(xlsx([{ name: 'Sheet & 1', rows: [
        ['Hello & <bye>', 12.5, F(2026, 9, 7), true, { inline: 'inline' }, { f: 'B1*2', v: 25 }],
        null,
        [null, null, F(2026, 9, 8)],
    ] }]));
    assert.equal(sheets.length, 1);
    assert.equal(sheets[0].name, 'Sheet & 1', 'the sheet name is decoded');
    const f = sheets[0].rows;
    assert.equal(f[0][0], 'Hello & <bye>', 'entities are decoded by hand (no XML entity processing)');
    assert.equal(f[0][1], 12.5);
    assert.ok(f[0][2] instanceof Date && f[0][2].toISOString().slice(0, 10) === '2026-09-07', 'a number with a date format is a Date');
    assert.equal(f[0][3], true); assert.equal(f[0][4], 'inline');
    assert.equal(f[0][5], 25, 'a formula returns the value Excel stored');
    assert.equal(f[1], null, 'an empty row is null');
    assert.equal(f[2][0], null); assert.equal(f[2][2].toISOString().slice(0, 10), '2026-09-08');
});

test('xlsx: a CUSTOM date format is a date too; a plain number is not', () => {
    // Column 1 (odd index) of the builder uses dd/mm/yyyy (numFmtId 164, custom).
    const { sheets } = readXlsx(xlsx([{ name: 'H', rows: [[1, F(2026, 1, 15), 46000]] }]));
    assert.ok(sheets[0].rows[0][1] instanceof Date, 'custom dd/mm/yyyy');
    assert.equal(sheets[0].rows[0][2], 46000, 'a number without a date format stays a number');
});

test('xlsx: a one-row sheet with a single cell is still a list', () => {
    const { sheets } = readXlsx(xlsx([{ name: 'One', rows: [['solo']] }]));
    assert.deepEqual(sheets[0].rows, [['solo']]);
});

test('xlsx: anything that is not an Excel workbook is rejected with a message that can be shown to the person', () => {
    const bad = [
        [Buffer.alloc(0), /empty|not an \.xlsx/],
        [Buffer.from('this is a PDF, not a zip'), /valid \.xlsx/],
        [zip({ 'other/thing.txt': 'hello' }), /not an Excel workbook/],
        [xlsx([{ name: 'H', rows: [['x']] }]).subarray(0, 120), /valid \.xlsx|damaged/],     // cut off while copying
    ];
    for (const [buf, message] of bad) {
        assert.throws(() => readXlsx(buf), e => e instanceof XlsxError && message.test(e.message), String(message));
    }
});

test('xlsx: a zip that declares tens of megabytes when unpacked is not unpacked (zip bomb)', () => {
    const bomb = xlsx([{ name: 'H', rows: [['x']] }]);
    // Fake the real size declared for the first entry in the central directory: 200 MB.
    const eocd = bomb.length - 22, off = bomb.readUInt32LE(eocd + 16);
    bomb.writeUInt32LE(200 * 1024 * 1024, off + 24);
    assert.throws(() => readXlsx(bomb), e => e instanceof XlsxError && /too big/.test(e.message));
});

test('xlsx: without sheets, it is not a workbook', () => {
    assert.throws(() => readXlsx(zip({
        'xl/workbook.xml': '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    })), e => e instanceof XlsxError && /no sheets/.test(e.message));
});

// ---------- books.js: reading the book ----------

test('periodFromFile: month and year come from the name, and without them nothing is guessed', () => {
    assert.equal(L.periodFromFile('Monthly purchases (SEPTIEMBRE26).xlsx'), '2026-09');
    assert.equal(L.periodFromFile('x (enero27).xlsx'), '2027-01');
    assert.equal(L.periodFromFile('x (OCTUBRE 26).xlsx'), '2026-10');
    assert.equal(L.periodFromFile('Monthly purchases (AGOSTO).xlsx'), null, 'without a two-digit year nothing is guessed');
    assert.equal(L.periodFromFile('book.xlsx'), null);
    assert.equal(L.periodFromFile('x (FEBRER26).xlsx'), null, 'a misspelled month is not a month');
});

test('parseBook: the block is inherited, SUBTOTAL and TOTAL are not lines, and "TOTAL ACEITE" is a product', () => {
    const { sheets } = readXlsx(xlsx([sheetOf('07 Sep to 12 Sep', [
        [F(2026, 9, 7), 7917, 'LIJA J-73 MEDIANA', 50, 17.22, 861, 1644, 1907.04, 'JD', 'BOLTCO', 'SOLICITUD POR STOCK MINIMO'],
        [null, null, 'LIJA J-73 FINA', 50, 15.66, 783],
        [F(2026, 9, 8), 'FTC2299', 'TOTAL ACEITE ZS 68 CUBETA DE 19 LITROS', 1, 2067.12, 2067.12, 2067.12, 2397.8, 'ANA', 'ACME GASES', null],
        [null, null, 'SUBTOTAL'],
        [null, null, 'TOTAL'],
    ])]));
    const r = L.parseBook(sheets, '2026-09');
    assert.equal(r.lines.length, 3, 'a bare SUBTOTAL and TOTAL do not count; "TOTAL ACEITE..." does');
    const [a, b, c] = r.lines;
    assert.equal(a.folio, '7917', 'a numeric folio is text without ".0"'); assert.equal(a.date, '2026-09-07');
    assert.equal(a.date_status, 'explicit date'); assert.equal(a.supplier, 'BOLTCO'); assert.equal(a.note, 'SOLICITUD POR STOCK MINIMO');
    assert.equal(b.date_status, 'date inherited from block'); assert.equal(b.date, '2026-09-07');
    assert.equal(b.supplier, 'BOLTCO', 'the following materials inherit supplier, folio and requester');
    assert.equal(b.requester, 'JD'); assert.equal(b.note, null, 'the comment goes only on the first row of the block');
    assert.equal(b.block, a.block); assert.notEqual(c.block, a.block);
    assert.equal(c.description, 'TOTAL ACEITE ZS 68 CUBETA DE 19 LITROS'); assert.equal(c.supplier, 'ACME GASES');
    assert.equal(a.type, 'purchase'); assert.equal(a.row_num, 9, 'the row is the Excel one (1-based), so it can be checked');
});

test('parseBook: a line without quantity or price is no_amount, never an invented 0', () => {
    const { sheets } = readXlsx(xlsx([sheetOf('H', [
        [F(2026, 9, 7), 1, 'CASCO NARANJA', 1, 0],
        [null, null, 'LIJA LONA AZUL'],
    ])]));
    const [a, b] = L.parseBook(sheets, '2026-09').lines;
    assert.equal(a.type, 'no_amount'); assert.equal(a.unit_price, null, 'a price of 0 is stored as "no price"'); assert.equal(a.quantity, 1);
    assert.equal(b.type, 'no_amount'); assert.equal(b.quantity, null);
});

test('parseBook: dates, a misspelled year is fixed only if the book year puts it in its month; otherwise it is left empty', () => {
    const { sheets } = readXlsx(xlsx([sheetOf('H', [
        [F(2036, 9, 14), 'A1', 'X1', 1, 10],      // 2036 instead of 2026
        [F(2026, 3, 1), 'A2', 'X2', 1, 10],       // not near September in any year
        ['12/09/2026   (14/09)', 'A3', 'X3', 1, 10],   // text in the date cell
        [F(2026, 10, 2), 'A4', 'X4', 1, 10],      // a week crossing into the next month is normal
    ])]));
    const r = L.parseBook(sheets, '2026-09');
    const by = Object.fromEntries(r.lines.map(x => [x.description, x]));
    assert.equal(by.X1.date, '2026-09-14'); assert.equal(by.X1.date_status, 'corrected date inferred from context');
    assert.equal(by.X2.date, null); assert.equal(by.X2.date_status, 'month identified; day pending');
    assert.equal(by.X3.date, null);
    assert.equal(by.X4.date, '2026-10-02'); assert.equal(by.X4.date_status, 'explicit date');
    assert.equal(r.warnings.length, 3, 'each touched or unread date leaves a warning with its sheet and row');
    assert.match(r.warnings[0], /H row 9.*2036-09-14.*2026-09-14/);
});

test('parseBook: a sheet without a FECHA header is not a purchases week', () => {
    const { sheets } = readXlsx(xlsx([{ name: 'Summary', rows: [['something else', 1, 2]] }, sheetOf('Week', [[F(2026, 9, 7), 1, 'A', 1, 1]])]));
    const r = L.parseBook(sheets, '2026-09');
    assert.deepEqual(r.sheets, ['Week']); assert.equal(r.lines.length, 1);
});

test('parseBook: columns are read by their HEADER - an inserted column does not shift the data, and it is reported', () => {
    // Someone inserts "NOTAS" between MATERIAL and CANTIDAD: before, everything was read shifted.
    const header = [...HEADER.slice(0, 3), 'NOTAS', ...HEADER.slice(3)];
    const { sheets } = readXlsx(xlsx([{ name: 'Week', rows: [header,
        [F(2026, 9, 7), 7917, 'LIJA J-73 MEDIANA', 'a note', 50, 17.22, 861, 861, 998.76, 'JD', 'BOLTCO', 'STOCK']] }]));
    const r = L.parseBook(sheets, '2026-09');
    const [a] = r.lines;
    assert.equal(a.quantity, 50); assert.equal(a.unit_price, 17.22); assert.equal(a.type, 'purchase');
    assert.equal(a.supplier, 'BOLTCO'); assert.equal(a.requester, 'JD'); assert.equal(a.note, 'STOCK');
    assert.equal(a.cell, 'C2', 'the cell is the material one, where it really is');
    assert.equal(r.notes.length, 1); assert.match(r.notes[0], /Week.*not where they usually are.*header/);
});

test('parseBook: the header is recognized regardless of case, accents or extra words ("Precio Unitario", "Cantidád")', () => {
    const header = ['Fecha', 'Folio', 'Material', 'Cantidád', 'Precio Unitario', 'Quién solicitó', 'Proveedor', 'Comentario'];
    const { sheets } = readXlsx(xlsx([{ name: 'S', rows: [header, [F(2026, 9, 7), 'A1', 'CLAVOS', 3, 10, 'JD', 'X', null]] }]));
    const [a] = L.parseBook(sheets, '2026-09').lines;
    assert.deepEqual([a.quantity, a.unit_price, a.supplier, a.requester], [3, 10, 'X', 'JD']);
});

test('parseBook: a sheet that looks like purchases but lacks a required column rejects the book, saying which', () => {
    const noPrice = HEADER.map(c => c === 'PRECIO' ? 'IMPORTE UNITARIO' : c);
    const { sheets } = readXlsx(xlsx([{ name: 'Week 2', rows: [noPrice, [F(2026, 9, 7), 1, 'A', 1, 1]] }]));
    assert.throws(() => L.parseBook(sheets, '2026-09'), e => e.status === 422 && /Week 2.*"PRECIO"/.test(e.message));
    const noTwo = HEADER.map(c => c === 'PRECIO' || c === 'PROVEEDOR' ? '?' : c);
    const { sheets: s2 } = readXlsx(xlsx([{ name: 'S', rows: [noTwo, [F(2026, 9, 7), 1, 'A', 1, 1]] }]));
    assert.throws(() => L.parseBook(s2, '2026-09'), e => /"PRECIO" or "PROVEEDOR"/.test(e.message));
});

test('parseBook: a sheet that is not purchases is skipped and REPORTED; an empty one makes no noise', () => {
    const { sheets } = readXlsx(xlsx([
        { name: 'Summary', rows: [['something else', 1, 2]] },
        { name: 'Loose FECHA', rows: [['FECHA', 'something'], [1, 2]] },
        { name: 'Empty', rows: [] },
        sheetOf('Week', [[F(2026, 9, 7), 1, 'A', 1, 1]]),
    ]));
    const r = L.parseBook(sheets, '2026-09');
    assert.deepEqual(r.sheets, ['Week']);
    assert.equal(r.notes.length, 2);
    assert.match(r.notes[0], /"Summary".*was not read/); assert.match(r.notes[1], /"Loose FECHA".*was not read/);
});

test('parseBook: without the optional column (requester, comment) it imports and says which data is missing', () => {
    const header = ['FECHA', 'FOLIO', 'MATERIAL', 'CANTIDAD', 'PRECIO', 'PROVEEDOR'];
    const { sheets } = readXlsx(xlsx([{ name: 'S', rows: [header, [F(2026, 9, 7), 'A1', 'CLAVOS', 3, 10, 'X']] }]));
    const r = L.parseBook(sheets, '2026-09');
    assert.equal(r.lines.length, 1); assert.equal(r.lines[0].requester, null);
    assert.ok(r.notes.some(o => /"who requested".*without that value/.test(o)));
    assert.ok(r.notes.some(o => /"COMENTARIO".*without that value/.test(o)));
});

test('parseBook: the usual header of real books is read in its usual place, without notes', () => {
    const real = ['FECHA', 'N° FOLIO/REMISION', 'MATERIAL', 'CANTIDAD', 'PRECIO', 'SUBTOTAL', 'SUBTOTAL', 'TOTAL', 'O.C.¿QUIEN SOLICITO?', 'PROVEEDOR', 'COMENTARIO'];
    const { sheets } = readXlsx(xlsx([{ name: 'S', rows: [real, [F(2026, 9, 7), 1, 'A', 1, 1, 1, 1, 1, 'JD', 'P', 'C']] }]));
    const r = L.parseBook(sheets, '2026-09');
    assert.deepEqual(r.notes, []);
    assert.deepEqual([r.lines[0].requester, r.lines[0].supplier, r.lines[0].note], ['JD', 'P', 'C']);
});

// ---------- books.js: compare with the database ----------

const R = (dn, quantity, unit_price, folio, extra = {}) => ({ sheet: 'S1', row_num: 9, desc_norm: dn, description: dn, quantity, unit_price, folio, ...extra });
const E = (dn, quantity, unit_price, folio, extra = {}) => ({ sheet: 'S1', row_num: 9, description: dn, description_norm: dn, quantity: String(quantity), unit_price: String(unit_price), folio, ...extra });

test('compare: by content, not by position - rows move when the Excel gets more readable', () => {
    const r = L.compare([R('LIJA', 50, 17.22, '7917', { row_num: 30 })], [E('LIJA', '50.000', '17.220', '7917', { row_num: 9 })]);
    assert.equal(r[0].status, 'existing');
});

test('compare: repeats are counted - if the Excel has 3 equal ones and the database 2, only the third is new', () => {
    const rs = [1, 2, 3].map(i => R('GAS', 1, 395.68, '9000', { row_num: 10 + i }));
    const r = L.compare(rs, [E('GAS', 1, 395.68, '9000', { row_num: 90 }), E('GAS', 1, 395.68, '9000', { row_num: 91 })]);
    assert.deepEqual(r.map(x => x.status), ['existing', 'existing', 'new']);
});

test('compare: a description fixed in the Excel (same sheet, row, quantity, price and folio) is not a new purchase', () => {
    const r = L.compare([R('BROCA CENTRAR', 1, 443.96, 'M1339')], [E('BORCA CENTRAR', 1, 443.96, 'M1339')]);
    assert.equal(r[0].status, 'description_differs'); assert.equal(r[0].existing_description, 'BORCA CENTRAR', 'it says what the database has');
});

test('compare: what is not there is new; a different quantity, price or folio is not "the same line"', () => {
    const db = [E('LIJA', 50, 17.22, '7917')];
    assert.equal(L.compare([R('LIJA', 50, 17.22, '7918', { row_num: 40 })], db)[0].status, 'new', 'other folio');
    assert.equal(L.compare([R('LIJA', 51, 17.22, '7917', { row_num: 40 })], db)[0].status, 'new', 'other quantity');
    assert.equal(L.compare([R('LIJA', 50, 17.23, '7917', { row_num: 40 })], db)[0].status, 'new', 'other price');
    assert.equal(L.compare([R('LIJA', 50, 17.22, '7917', { row_num: 40 })], [])[0].status, 'new', 'empty book');
});

test('compare: no price in the Excel and NULL in the database are the same (both 0 thousandths), and the folio is case-insensitive', () => {
    const r = L.compare([R('CASCO', 1, null, 'r1146')], [{ ...E('CASCO', 1, 0, 'R1146'), unit_price: null }]);
    assert.equal(r[0].status, 'existing');
});

// ---------- books.js: suppliers and similar names ----------

test('suggestSupplier: one contains the other; something different is not suggested', () => {
    const suppliers = [{ id: 1, name: 'ACME GASES DE MEXICO' }, { id: 2, name: 'BOLT CO FASTENERS' }, { id: 3, name: 'ZED' }];
    assert.equal(L.suggestSupplier('ACME GASES', suppliers).id, 1);
    assert.equal(L.suggestSupplier('BOLTCO', suppliers).id, 2, 'without the space: BOLTCO inside BOLT CO FASTENERS');
    assert.equal(L.suggestSupplier('NOVASUPPLY', suppliers), null, 'a new supplier is not invented');
});

test('forClient: the same form with other punctuation, or a similarity >= 0.9, is "near_certain"; the rest, "similar"', () => {
    const base = { product: { id: 1, code: 'P1', name: 'X' }, text: 'X', has_numbers: true };
    assert.equal(L.forClient({ ...base, reason: 'same_form', similarity: 0.8 }).level, 'near_certain');
    assert.equal(L.forClient({ ...base, reason: 'similar', similarity: 0.93 }).level, 'near_certain');
    assert.equal(L.forClient({ ...base, reason: 'similar', similarity: 0.7 }).level, 'similar');
    assert.equal(L.forClient(null), null);
});

// ---------- the server ----------

const FILE = 'Monthly purchases (SEPTIEMBRE26).xlsx';
const testBook = () => xlsx([sheetOf('07 Sep to 12 Sep', [
    [F(2026, 9, 7), 7917, 'LIJA J-73 MEDIANA', 50, 17.22, 861, 861, 998.76, 'JD', 'BOLTCO', 'SOLICITUD POR STOCK MINIMO'],
    [null, null, 'LIJA J-73 FINA', 50, 15.66, 783],
    [F(2026, 9, 8), 'FTC2299', 'THINNER AMERICANO, LITRO', 20, 41.38, 827.6, 827.6, 960.02, 'JD', 'PAINT HOUSE', null],
])]);
const bodyOf = (extra = {}) => ({ file: FILE, content: testBook().toString('base64'), ...extra });

/** A fake database: returns the state it is given and records the writes. */
const THINNER = { text: 'THINNER AMERICANO', via: 'link', id: 5, code: 'LUB-THINNER', name: 'American Thinner' };
async function environment(t, role, { existing = [], book = null, books = null, links = [], suppliers = [], aliases = [], candidates = [THINNER] } = {}) {
    const writes = [];
    const pool = {
        async query(sql, args = []) {
            if (/INSERT INTO (purchase_books|purchases|product_aliases|book_imports)/.test(sql)) {
                writes.push({ sql, args });
                return /product_aliases/.test(sql) ? { rows: [], rowCount: 1 } : /purchase_books/.test(sql) ? { rows: [{ id: 77 }] }
                    : /book_imports/.test(sql) ? { rows: [{ id: 88 }] } : { rows: [] };
            }
            if (/unnest\(\$1::text\[\]\)/.test(sql)) return { rows: args[0].map(d => ({ description: d, norm: d.toUpperCase().replace(/\s+/g, ' ').trim() })) };
            if (/FROM purchase_books WHERE period = \$1 ORDER BY id/.test(sql)) return { rows: books ?? (book ? [{ id: book, file: FILE }] : []) };
            if (/FROM purchases WHERE book_id/.test(sql)) return { rows: existing };
            if (/WHERE a\.alias_norm = ANY/.test(sql)) return { rows: links };
            if (/FROM suppliers ORDER BY name/.test(sql)) return { rows: suppliers };
            if (/FROM supplier_aliases a JOIN suppliers p/.test(sql)) return { rows: aliases };
            if (/FROM suppliers WHERE id = ANY/.test(sql)) return { rows: args[0].map(id => ({ id })) };
            if (/UNION ALL/.test(sql)) return { rows: candidates };
            return { rows: [] };            // BEGIN, COMMIT, ROLLBACK and the lock
        },
        async connect() { return { query: this.query.bind(this), release() {} }; },
    };
    const identity = {
        requireSession: () => (req, res, next) => { req.user = { id: 7, role }; next(); },
        requireRole: (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Insufficient role' }),
    };
    const server = createApp(pool, identity).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = async (route, body) => {
        const r = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    return { post, writes };
}

test('permissions: operator and technician cannot import books (they are purchases); storekeeper and admin can', async t => {
    for (const [role, expected] of [['operator', 403], ['technician', 403], ['storekeeper', 200], ['admin', 200]]) {
        const { post } = await environment(t, role);
        const r = await post('/api/purchases/import/preview', bodyOf());
        assert.equal(r.status, expected, role);
    }
});

test('preview: reads the book, says what is new and writes NOTHING', async t => {
    const { post, writes } = await environment(t, 'storekeeper', {
        suppliers: [{ id: 1, name: 'PAINT HOUSE' }, { id: 2, name: 'BOLT CO FASTENERS' }],
        links: [{ alias_norm: 'LIJA J-73 MEDIANA', id: 3, code: 'LIJA-1', name: 'Lija J-73' }],
    });
    const r = await post('/api/purchases/import/preview', bodyOf());
    assert.equal(r.status, 200);
    assert.deepEqual(writes, [], 'the preview writes nothing');
    const b = r.body;
    assert.equal(b.period, '2026-09'); assert.equal(b.book_exists, false); assert.match(b.sha256, /^[0-9a-f]{64}$/);
    assert.equal(b.summary.lines, 3); assert.equal(b.summary.new_count, 3); assert.equal(b.summary.existing_count, 0);
    assert.equal(b.summary.new_amount, '2471.60', '50×17.22 + 50×15.66 + 20×41.38');
    assert.equal(b.summary.new_recognized, 1, 'only "LIJA J-73 MEDIANA" has a link to the catalog');
    assert.equal(b.sheets.length, 1); assert.equal(b.sheets[0].name, '07 Sep to 12 Sep');
    assert.deepEqual(b.notes, [], 'a book like the warehouse ones has no notes');
    const [lija, fina, thinner] = b.sheets[0].lines;
    assert.equal(lija.product.code, 'LIJA-1'); assert.equal(fina.product, null);
    assert.equal(lija.quantity, '50.000'); assert.equal(lija.unit_price, '17.220'); assert.equal(lija.amount, '861.00');
    assert.equal(thinner.suggestion.product.id, 5, 'THINNER AMERICANO, LITRO resembles American Thinner, and it is only SUGGESTED');
    assert.ok(['near_certain', 'similar'].includes(thinner.suggestion.level)); assert.equal(thinner.suggestion.similar_to, 'THINNER AMERICANO');
    assert.equal(thinner.supplier_id, 1, 'supplier with an exact match: linked');
    assert.equal(lija.supplier_id, null, 'BOLTCO is not an exact match: left unlinked...');
    assert.deepEqual(b.unlinked_suppliers.map(p => [p.name, p.suggested?.id]), [['BOLTCO', 2]], '...but BOLT CO FASTENERS is suggested');
});

test('preview: a book name a person already declared as a supplier alias links by itself; an archived supplier is not suggested', async t => {
    const { post } = await environment(t, 'storekeeper', {
        suppliers: [{ id: 1, name: 'PAINT HOUSE', archived: false }, { id: 2, name: 'BOLT CO FASTENERS', archived: true }],
        aliases: [{ alias: 'boltco', id: 2, name: 'BOLT CO FASTENERS' }],
    });
    const { body: b } = await post('/api/purchases/import/preview', bodyOf());
    const lija = b.sheets[0].lines[0];
    assert.equal(lija.supplier, 'BOLTCO');
    assert.equal(lija.supplier_id, 2, 'the alias already decided links without asking again');
    assert.deepEqual(b.unlinked_suppliers, [], 'nothing left to decide');

    const archived = await environment(t, 'storekeeper', { suppliers: [{ id: 2, name: 'BOLT CO FASTENERS', archived: true }] });
    const { body: c } = await archived.post('/api/purchases/import/preview', bodyOf());
    assert.equal(c.unlinked_suppliers.find(p => p.name === 'BOLTCO').suggested, null, 'an archived supplier is not offered as a suggestion');
});

test('preview: uses the Purchases engine - another MEASURE is not suggested, and neither is an exclusive word', async t => {
    const candidates = [
        { text: 'ROLLO DE 305 M PELICULA PLASTICA ESTIRABLE ANCHO 5" CAL 60', via: 'link', id: 11, code: 'EMP-1', name: 'Roll 305' },
        { text: 'GUANTE DE SOLDADOR ROJO CON KEVLAR PAR', via: 'link', id: 12, code: 'EPP-ROJO', name: 'Red glove' },
        { text: 'CONDULET 1/2" CONEXION TIPO FS VOLTEK', via: 'link', id: 13, code: 'ELE-1', name: 'Condulet' },
    ];
    const book = xlsx([sheetOf('H', [
        [F(2026, 9, 7), 1, 'ROLLO DE 244 M PELICULA PLASTICA ESTIRABLE ANCHO 18" CAL 50', 2, 154.31],       // other measures
        [F(2026, 9, 7), 2, 'GUANTE DE SOLDADOR AZUL CON KEVLAR PAR', 6, 69.11],                              // other color
        [F(2026, 9, 7), 3, 'CONDULET 1/2" CONEXION TIPO FS VOLTECK', 2, 55],                                 // a typo
    ])]);
    const { post } = await environment(t, 'storekeeper', { candidates });
    const r = await post('/api/purchases/import/preview', { file: FILE, content: book.toString('base64') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [roll, glove, condulet] = r.body.sheets[0].lines;
    assert.equal(roll.suggestion, null, '244 M is not 305 M: not suggested, even if they look over 90% alike');
    assert.equal(glove.suggestion, null, 'blue is not red (exclusive word in suggestions.js)');
    assert.equal(condulet.suggestion.product.id, 13, 'VOLTECK/VOLTEK yes: same measures, one letter apart');
    assert.equal(condulet.suggestion.level, 'similar', 'not the same form (one letter changes): a person looks at it; "near_certain" is only what changes in punctuation');
    assert.ok(condulet.suggestion.similarity >= 0.6);
});

test('preview: what the database already has shows as "existing"; importing twice does not duplicate', async t => {
    const existing = [
        { sheet: '07 Sep to 12 Sep', row_num: 9, quantity: '50.000', unit_price: '17.220', folio: '7917', description: 'LIJA J-73 MEDIANA', description_norm: 'LIJA J-73 MEDIANA' },
        { sheet: '07 Sep to 12 Sep', row_num: 10, quantity: '50.000', unit_price: '15.660', folio: '7917', description: 'LIJA J-73 FINA', description_norm: 'LIJA J-73 FINA' },
        { sheet: '07 Sep to 12 Sep', row_num: 11, quantity: '20.000', unit_price: '41.380', folio: 'FTC2299', description: 'THINNER AMERICANO, LITRO', description_norm: 'THINNER AMERICANO, LITRO' },
    ];
    const { post, writes } = await environment(t, 'admin', { book: 4, existing });
    const r = await post('/api/purchases/import/preview', bodyOf());
    assert.equal(r.body.summary.new_count, 0); assert.equal(r.body.summary.existing_count, 3); assert.equal(r.body.book_exists, true);
    const c = await post('/api/purchases/import/confirm', bodyOf());
    assert.equal(c.status, 200, 'with nothing new it is not a 201');
    assert.equal(c.body.inserted, 0);
    assert.equal(writes.filter(e => /INSERT INTO purchases/.test(e.sql)).length, 0);
    assert.equal(writes.filter(e => /book_imports/.test(e.sql)).length, 0, 'an import with no effect leaves no row');
});

const BOOK_ALREADY = [
    { sheet: '07 Sep to 12 Sep', row_num: 9, quantity: '50.000', unit_price: '17.220', folio: '7917', description: 'LIJA J-73 MEDIANA', description_norm: 'LIJA J-73 MEDIANA' },
    { sheet: '07 Sep to 12 Sep', row_num: 10, quantity: '50.000', unit_price: '15.660', folio: '7917', description: 'LIJA J-73 FINA', description_norm: 'LIJA J-73 FINA' },
];

test('the same book of the month under ANOTHER name (the browser renames downloads) is recognized and does NOT duplicate what is loaded', async t => {
    const saved = 'Monthly purchases (SEPTIEMBRE26).xlsx';   // the name it was loaded with
    const { post, writes } = await environment(t, 'storekeeper', { books: [{ id: 4, file: saved }], existing: BOOK_ALREADY });
    const r = await post('/api/purchases/import/preview', bodyOf({ file: 'Monthly_purchases_(SEPTIEMBRE26)[1].xlsx' }));
    assert.equal(r.status, 200);
    assert.equal(r.body.book_exists, true, 'a lone book of the month is the same one');
    assert.equal(r.body.matched_book, saved);
    assert.deepEqual(r.body.other_books_of_month, [], 'no "other book" warning: it is the same');
    assert.equal(r.body.summary.existing_count, 2, 'what was already there is NOT taken as new');
    assert.equal(r.body.summary.new_count, 1, 'only the missing line');

    const c = await post('/api/purchases/import/confirm', bodyOf({ file: 'Monthly_purchases_(SEPTIEMBRE26)[1].xlsx' }));
    assert.equal(c.status, 201);
    assert.equal(c.body.inserted, 1);
    assert.equal(c.body.book_id, 4, 'added to the book that already exists');
    assert.equal(writes.filter(e => /INSERT INTO purchase_books/.test(e.sql)).length, 0, 'no separate book for the same month');
});

test('with the same name nothing changes: matched_book is null', async t => {
    const { post } = await environment(t, 'storekeeper', { book: 4, existing: BOOK_ALREADY });
    const r = await post('/api/purchases/import/preview', bodyOf());
    assert.equal(r.body.book_exists, true);
    assert.equal(r.body.matched_book, null);
});

test('several books for the month and none with that name: compared against ALL (no duplicates) and the new lines go to a separate book', async t => {
    const { post, writes } = await environment(t, 'storekeeper', {
        books: [{ id: 4, file: 'one (SEPTIEMBRE26).xlsx' }, { id: 5, file: 'two (SEPTIEMBRE26).xlsx' }], existing: BOOK_ALREADY,
    });
    const r = await post('/api/purchases/import/preview', bodyOf({ file: 'three (SEPTIEMBRE26).xlsx' }));
    assert.equal(r.body.book_exists, false, 'which of the two it belongs to is unknown');
    assert.equal(r.body.matched_book, null);
    assert.deepEqual(r.body.other_books_of_month, ['one (SEPTIEMBRE26).xlsx', 'two (SEPTIEMBRE26).xlsx']);
    assert.equal(r.body.summary.existing_count, 2, 'what is loaded in any book of the month is not entered again');
    const c = await post('/api/purchases/import/confirm', bodyOf({ file: 'three (SEPTIEMBRE26).xlsx' }));
    assert.equal(c.body.inserted, 1);
    assert.equal(writes.filter(e => /INSERT INTO purchase_books/.test(e.sql)).length, 1, 'the new lines go to a separate book');
});

test('confirm: saves the new lines with the chosen supplier, the author comes from the SESSION and the links are the ones the person ticked', async t => {
    const { post, writes } = await environment(t, 'storekeeper', {
        suppliers: [{ id: 2, name: 'BOLT CO FASTENERS' }, { id: 1, name: 'PAINT HOUSE' }],
    });
    const r = await post('/api/purchases/import/confirm', bodyOf({
        links: [{ description: 'THINNER AMERICANO, LITRO', product_id: 5 }],
        suppliers: { BOLTCO: 2 },
        user_id: 999, created_by: 999,         // the body does not decide: the author is the session
    }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.inserted, 3); assert.equal(r.body.links_created, 1); assert.equal(r.body.amount, '2471.60');
    const purchases = writes.find(e => /INSERT INTO purchases/.test(e.sql));
    assert.equal(purchases.args.length, 3 * 17);
    const row = n => purchases.args.slice(n * 17, n * 17 + 17);
    assert.deepEqual(row(0).slice(0, 12), [77, '07 Sep to 12 Sep', 1, 'C9', 9, 'purchase', '2026-09-07', 'explicit date', 'LIJA J-73 MEDIANA', 50, 17.22, 'BOLTCO']);
    assert.equal(row(0)[12], 2, 'BOLTCO was linked to the supplier the person chose');
    assert.equal(row(0)[11], 'BOLTCO', 'and the text from the book is untouched');
    assert.equal(row(1)[12], 2, 'the next material of the block inherits the supplier');
    assert.equal(row(0)[16], 88, 'each line carries the import that brought it (so it can be undone)');
    assert.equal(row(2)[12], 1, 'PAINT HOUSE is an exact match: linked by itself');
    const alias = writes.find(e => /INSERT INTO product_aliases/.test(e.sql));
    assert.deepEqual(alias.args, [5, 'THINNER AMERICANO, LITRO', 7, 88], 'created_by = the session user (7), not the 999 from the body; and the link carries its import');
    const imp = writes.find(e => /book_imports/.test(e.sql));
    assert.equal(imp.args[3], 7); assert.equal(imp.args[4], 3);
    assert.match(imp.args[2], /^[0-9a-f]{64}$/);
});

test('confirm: with no link or supplier chosen, the new lines are saved UNLINKED and WITHOUT a linked supplier (completed later)', async t => {
    const { post, writes } = await environment(t, 'admin');
    const r = await post('/api/purchases/import/confirm', bodyOf());
    assert.equal(r.status, 201); assert.equal(r.body.links_created, 0);
    assert.equal(writes.some(e => /product_aliases/.test(e.sql)), false, 'NOTHING is linked by itself, however similar');
    const purchases = writes.find(e => /INSERT INTO purchases/.test(e.sql));
    assert.equal(purchases.args[12], null); assert.equal(purchases.args[11], 'BOLTCO');
});

test('confirm: a link or supplier that is not from this book is rejected, without writing', async t => {
    for (const extra of [
        { links: [{ description: 'SOMETHING ELSE NOT IN THE BOOK', product_id: 5 }] },
        { suppliers: { 'SUPPLIER NOT IN THE BOOK': 2 } },
        { links: [{ description: 'THINNER AMERICANO, LITRO', product_id: 'x' }] },
        { suppliers: { BOLTCO: -1 } },
        { links: 'all' }, { suppliers: [1] },
    ]) {
        const { post, writes } = await environment(t, 'admin');
        const r = await post('/api/purchases/import/confirm', bodyOf(extra));
        assert.equal(r.status, 400, JSON.stringify(extra));
        assert.equal(writes.length, 0, JSON.stringify(extra));
    }
});

test('a malformed body is a 400 with its reason, and a file that is not a book is a 422 - never a 500', async t => {
    const { post } = await environment(t, 'admin');
    const route = '/api/purchases/import/preview';
    for (const [body, error] of [
        [{}, /file/], [{ file: 'book.pdf', content: 'AAAA' }, /\.xlsx/], [{ file: FILE }, /content/],
        [{ file: FILE, content: '***' }, /base64/],
        [{ file: 'book (SEPTIEMBRE).xlsx', content: testBook().toString('base64') }, /which month/],
    ]) {
        const r = await post(route, body);
        assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
        assert.match(r.body.error, error);
    }
    const notABook = await post(route, { file: FILE, content: Buffer.from('this is not a zip, it is text').toString('base64') });
    assert.equal(notABook.status, 422); assert.match(notABook.body.error, /xlsx/);
    const noPurchases = await post(route, { file: FILE, content: xlsx([{ name: 'Other', rows: [['nothing about purchases']] }]).toString('base64') });
    assert.equal(noPurchases.status, 422); assert.match(noPurchases.body.error, /purchase lines/);
    const noPrice = xlsx([{ name: 'S', rows: [HEADER.map(c => c === 'PRECIO' ? 'X' : c), [F(2026, 9, 7), 1, 'A', 1, 1]] }]);
    const broken = await post(route, { file: FILE, content: noPrice.toString('base64') });
    assert.equal(broken.status, 422); assert.match(broken.body.error, /"PRECIO"/);
});
