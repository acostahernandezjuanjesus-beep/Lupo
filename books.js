// Imports a monthly purchase book from its Excel file. POST /preview reads it and says what's new; POST /confirm
// re-reads the SAME file and saves the new lines. Lines are matched by content, not position (people edit the Excel),
// products and suppliers are only suggested (a person links), and dates are never invented.
// The Excel is Spanish input: the month in the file name ("(SEPTIEMBRE26)") and the headers stay Spanish.

const express = require('express');
const crypto = require('node:crypto');
const { readXlsx, XlsxError } = require('./xlsx');
const { toPositiveInt, fail, Rejection, normalizeSupplier } = require('./util');
const { suggest, linkCandidates } = require('./suggestions');
const auth = require('./auth');

const MONTHS = {
    ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6, JULIO: 7, AGOSTO: 8,
    SEPTIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
};
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINKS = 500;
const DAY = 86400000;
const NO_DAY = 'month identified; day pending';

// ---------- read the book ----------

/** 'Some book (SEPTIEMBRE26).xlsx' -> '2026-09'; null if the name doesn't say the month. */
function periodFromFile(name) {
    const m = /\(\s*([A-ZÁÉÍÓÚ]+)\s*(\d{2})\s*\)/.exec(String(name).toUpperCase());
    return m && m[1] in MONTHS ? `20${m[2]}-${String(MONTHS[m[1]]).padStart(2, '0')}` : null;
}

const isEmpty = v => v === null || v === undefined;
const textOf = v => {
    if (isEmpty(v)) return null;
    // PostgreSQL can't store a NUL byte; noNulls.js strips it from requests but this comes from a file
    const t = String(v).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
    return t === '' ? null : t;
};
const numberOf = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const folioOf = v => Number.isInteger(v) ? String(v) : textOf(v);          // Excel's 7792.0 is '7792'
const dayOf = d => d.toISOString().slice(0, 10);

/** Weekly sheets cross month boundaries: the book's month +-14 days. */
function monthWindow(period) {
    const y = Number(period.slice(0, 4)), m = Number(period.slice(5, 7));
    return [Date.UTC(y, m - 1, 1) - 14 * DAY, Date.UTC(y, m, 1) + 14 * DAY];
}

function blockDate(raw, period, warnings, where) {
    const [start, end] = monthWindow(period);
    const inside = d => d.getTime() >= start && d.getTime() < end;
    if (raw instanceof Date && !isNaN(raw)) {
        if (inside(raw)) return [dayOf(raw), 'explicit date'];
        const fixed = new Date(Date.UTC(Number(period.slice(0, 4)), raw.getUTCMonth(), raw.getUTCDate()));
        // Feb 29 in a non-leap year rolls into March: not the same date
        if (fixed.getUTCMonth() === raw.getUTCMonth() && inside(fixed)) {
            warnings.push(`${where}: the date ${dayOf(raw)} was read as ${dayOf(fixed)} (book year)`);
            return [dayOf(fixed), 'corrected date inferred from context'];
        }
        warnings.push(`${where}: the date ${dayOf(raw)} is outside the book's month; left empty`);
    } else if (!isEmpty(raw)) {
        warnings.push(`${where}: the date cell says "${textOf(raw)}", which is not a date; left empty`);
    }
    return [null, NO_DAY];
}

const stripAccents = t => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

// Each column is recognized by a word in its header ("N° FOLIO/REMISION" has FOLIO; "O.C.¿QUIEN SOLICITO?" has
// SOLICIT). Without the required ones we can't tell what each value is; a missing optional one just drops that value.
const REQUIRED = [['folio', 'FOLIO'], ['material', 'MATERIAL'], ['quantity', 'CANTIDAD'], ['price', 'PRECIO'], ['supplier', 'PROVEEDOR']];
const OPTIONAL = [['requester', 'SOLICIT'], ['comment', 'COMENTARIO']];
const COLUMN_LABEL = { folio: 'FOLIO', material: 'MATERIAL', quantity: 'CANTIDAD', price: 'PRECIO', supplier: 'PROVEEDOR', requester: 'who requested', comment: 'COMENTARIO' };
// where the columns usually sit (A=0), only to say when they aren't there
const USUAL_POSITION = { date: 0, folio: 1, material: 2, quantity: 3, price: 4, requester: 8, supplier: 9, comment: 10 };

/** 0 -> A, 25 -> Z, 26 -> AA. */
const letterOf = i => { let n = i + 1, t = ''; while (n > 0) { const m = (n - 1) % 26; t = String.fromCharCode(65 + m) + t; n = Math.floor((n - 1) / 26); } return t; };

/** The header row: the first one with a cell saying FECHA. -1 if the sheet has none. */
const headerRowOf = rows => rows.findIndex(r => Array.isArray(r) && r.some(v => typeof v === 'string' && stripAccents(v) === 'FECHA'));

/** Which column is each value, from the header. `missing`: required ones not found. */
function columnsOf(row) {
    const cells = row.map(v => typeof v === 'string' ? stripAccents(v) : '');
    const used = new Set(), col = {};
    const take = (key, word, exact = false) => {
        const i = cells.findIndex((c, j) => !used.has(j) && (exact ? c === word : c.includes(word)));
        if (i >= 0) { col[key] = i; used.add(i); }
    };
    take('date', 'FECHA', true);
    for (const [key, word] of [...REQUIRED, ...OPTIONAL]) take(key, word);
    return {
        col,
        missing: REQUIRED.map(([c]) => c).filter(c => col[c] === undefined),
        optionalMissing: OPTIONAL.map(([c]) => c).filter(c => col[c] === undefined),
    };
}

/**
 * Each sheet is a week with a header that says FECHA. Below it come blocks: the first row has date, folio,
 * requester, supplier and comment; the following ones, with no date, are more materials of the same folio and
 * inherit those. SUBTOTAL and TOTAL belong to the block, they aren't lines.
 *
 * Returns { lines, warnings, sheets, notes }. `notes` is what the person should know about the book's STRUCTURE
 * (a sheet not read, a missing or displaced column). A sheet that looks like purchases but can't be read (no PRECIO,
 * say) rejects the book: a shifted read is worse than none.
 */
function parseBook(sheets, period) {
    const lines = [], warnings = [], names = [], notes = [];
    let block = -1;
    sheets.forEach((sheet, i) => {
        const hasAnything = sheet.rows.some(r => Array.isArray(r) && r.some(v => !isEmpty(v)));
        const header = headerRowOf(sheet.rows);
        const { col, missing, optionalMissing } = header < 0
            ? { col: {}, missing: REQUIRED.map(([c]) => c), optionalMissing: [] }
            : columnsOf(sheet.rows[header]);
        // with FECHA and at least two other required columns the sheet IS purchases: if one is missing, don't guess
        const looksLikePurchases = header >= 0 && REQUIRED.length - missing.length >= 2;
        if (looksLikePurchases && missing.length > 0) {
            throw new Rejection(`In sheet "${sheet.name}" I can't find the column ${missing.map(c => `"${COLUMN_LABEL[c]}"`).join(' or ')} in the header (row ${header + 1}). ` +
                                "Without it I can't tell what each value is, so I won't import it and risk saving them wrong. Check that the header still says FECHA, FOLIO, MATERIAL, CANTIDAD, PRECIO and PROVEEDOR.", 422);
        }
        if (!looksLikePurchases) {
            if (hasAnything) notes.push(`Sheet "${sheet.name}" doesn't have the header of a purchases week (FECHA, MATERIAL, CANTIDAD, PRECIO...) and was not read.`);
            return;
        }
        names.push(sheet.name);
        if (Object.entries(col).some(([key, j]) => USUAL_POSITION[key] !== j)) {
            notes.push(`In sheet "${sheet.name}" the columns are not where they usually are; they were read by their header.`);
        }
        for (const key of optionalMissing) notes.push(`In sheet "${sheet.name}" I can't find the column "${COLUMN_LABEL[key]}": imported without that value.`);

        let b = { date: null, status: NO_DAY, folio: null, requester: null, supplier: null };
        for (let k = header + 1; k < sheet.rows.length; k++) {
            const g = j => j === undefined ? null : sheet.rows[k]?.[j] ?? null;
            const starts = g(col.date) !== null || g(col.folio) !== null;
            if (starts) {
                const [date, status] = blockDate(g(col.date), period, warnings, `${sheet.name} row ${k + 1}`);
                b = { date, status, folio: folioOf(g(col.folio)), requester: textOf(g(col.requester)), supplier: textOf(g(col.supplier)) };
                block++;
            }
            const material = textOf(g(col.material));
            // only a bare "TOTAL" or "SUBTOTAL" is a total: "TOTAL AZOLLA ZS 68" is a lubricant by the brand Total
            if (!material || /^(SUB)?TOTAL[\s:]*$/i.test(material)) continue;
            const quantity = numberOf(g(col.quantity)), price = numberOf(g(col.price));
            lines.push({
                sheet: sheet.name, sheet_order: i + 1, row_num: k + 1, cell: `${letterOf(col.material)}${k + 1}`, block: Math.max(block, 0),
                type: quantity && price ? 'purchase' : 'no_amount',
                date: b.date, date_status: starts || !b.date ? b.status : 'date inherited from block',
                description: material, quantity, unit_price: price || null,
                folio: b.folio, requester: b.requester, supplier: b.supplier,
                note: starts ? textOf(g(col.comment)) : null,
            });
        }
    });
    return { lines, warnings, sheets: names, notes };
}

// ---------- compare with the database ----------

// whole thousandths: the db numerics have 3 decimals, so no floating point comparison
const thousandths = v => v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 1000);
const SEP = '\u0001';
const folioKey = f => (f ?? '').trim().toUpperCase();
const byContent = (norm, quantity, price, folio) => [norm, thousandths(quantity), thousandths(price), folioKey(folio)].join(SEP);
const byPosition = (sheet, row, quantity, price, folio) => [sheet, row, thousandths(quantity), thousandths(price), folioKey(folio)].join(SEP);

/**
 * Marks each Excel line (with `desc_norm`, its description normalized by the database) as 'existing',
 * 'description_differs' or 'new' against the book's `existing` rows. Repeats are counted: Excel has 3 equal
 * ones, the database 2, only the third is new. Existing rows: { sheet, row_num, quantity, unit_price, folio,
 * description, description_norm }.
 */
function compare(lines, existing) {
    const have = new Map(), positions = new Map(), seen = new Map();
    for (const e of existing) {
        const k = byContent(e.description_norm, e.quantity, e.unit_price, e.folio);
        have.set(k, (have.get(k) ?? 0) + 1);
        positions.set(byPosition(e.sheet, e.row_num, e.quantity, e.unit_price, e.folio), e);
    }
    return lines.map(l => {
        const k = byContent(l.desc_norm, l.quantity, l.unit_price, l.folio);
        const n = (seen.get(k) ?? 0) + 1;
        seen.set(k, n);
        if (n <= (have.get(k) ?? 0)) return { ...l, status: 'existing' };
        const e = positions.get(byPosition(l.sheet, l.row_num, l.quantity, l.unit_price, l.folio));
        return e ? { ...l, status: 'description_differs', existing_description: e.description } : { ...l, status: 'new' };
    });
}

// ---------- similar suppliers (products are suggested by suggestions.js) ----------

const bigrams = s => {
    const t = ` ${s} `, out = new Map();
    for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1);
    return out;
};
const sum = m => [...m.values()].reduce((s, v) => s + v, 0);
function dice(a, b) {
    let common = 0;
    for (const [g, v] of a) common += Math.min(v, b.get(g) ?? 0);
    return (2 * common) / ((sum(a) + sum(b)) || 1);
}
const clean = s => s.toUpperCase().replace(/[^A-Z0-9 ]/g, '');

/** The supplier in the list that resembles a book name, or null. Suggestion only. */
function suggestSupplier(name, suppliers) {
    const n = clean(name), nNoSpaces = n.replace(/ /g, '');
    let best = null, bestScore = 0;
    for (const p of suppliers) {
        const q = clean(p.name), qNoSpaces = q.replace(/ /g, '');
        // "ACME TOOLS" inside "ACME TOOLS DE MEXICO"; "ACMETOOLS" inside "ACME TOOLS NORTE"
        const contains = nNoSpaces.length >= 5 && (qNoSpaces.includes(nNoSpaces) || nNoSpaces.includes(qNoSpaces));
        const s = Math.max(dice(bigrams(n), bigrams(q)), contains ? 0.9 : 0);
        if (s > bestScore) { bestScore = s; best = p; }
    }
    return best && bestScore >= 0.75 ? { id: best.id, name: best.name } : null;
}

// ---------- database and response ----------

const numText = (v, dec) => isEmpty(v) ? null : Number(v).toFixed(dec);
const amountOf = l => l.quantity && l.unit_price ? l.quantity * l.unit_price : 0;

/** Validates the body (file name and base64 content). Throws Rejection if anything is invalid. */
function readBody(body) {
    const c = body ?? {};
    if (typeof c.file !== 'string' || c.file.length > 200 || !/\.xlsx$/i.test(c.file.trim())) throw new Rejection('file must be the name of an .xlsx');
    if (typeof c.content !== 'string' || c.content.length === 0) throw new Rejection('content is required (the file in base64)');
    if (c.content.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) throw new Rejection('The file is too big to be a purchase book');
    if (!/^[A-Za-z0-9+/=\s]+$/.test(c.content)) throw new Rejection('content is not base64');
    const buffer = Buffer.from(c.content, 'base64');
    if (buffer.length === 0 || buffer.length > MAX_BYTES) throw new Rejection('The file is empty or too big');
    const file = c.file.trim().replace(/[\\/]/g, '_');
    const period = periodFromFile(file);
    if (!period) throw new Rejection('I can\'t tell which month the book is for. The file name must end like "(SEPTIEMBRE26).xlsx".');
    return { file, buffer, period, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

/** What the person decided in the preview: name links ({description, product_id}) and supplier links ({name: id}). */
function readDecisions(body) {
    const { links = [], suppliers: supplierLinks = {} } = body;
    if (!Array.isArray(links) || links.length > MAX_LINKS) throw new Rejection('links must be a short list');
    if (links.some(l => typeof l?.description !== 'string' || toPositiveInt(l?.product_id) === null)) throw new Rejection('each link needs description and product_id');
    if (typeof supplierLinks !== 'object' || supplierLinks === null || Array.isArray(supplierLinks)) throw new Rejection('suppliers must be an object {name: id}');
    if (Object.values(supplierLinks).some(v => toPositiveInt(v) === null)) throw new Rejection('each supplier needs a valid id');
    return { links, supplierLinks };
}

/** Everything asked of the database to compare and suggest. `q` is the pool or a transaction client. */
async function analyze(q, { file, buffer, period }) {
    const reading = parseBook(readXlsx(buffer).sheets, period);
    if (reading.lines.length === 0) {
        throw new Rejection('I found no purchase lines in this file. Is it a monthly purchase book? ' +
                            'Each purchases sheet needs a header with FECHA, MATERIAL, CANTIDAD and PRECIO.' +
                            (reading.notes.length ? ` ${reading.notes[0]}` : ''), 422);
    }
    const query = async (sql, args) => (await q.query(sql, args)).rows;

    const descriptions = [...new Set(reading.lines.map(l => l.description))];
    const norms = new Map((await query(
        'SELECT d AS description, normalize_description(d) AS norm FROM unnest($1::text[]) AS d', [descriptions])).map(n => [n.description, n.norm]));
    for (const l of reading.lines) l.desc_norm = norms.get(l.description);

    // A month's book is THE SAME book even if its name changes: browsers rename downloads (underscores, "[1]"), and
    // comparing only against a same-named book would take the whole month as new and duplicate it. With no
    // name match, a lone book for the month is the same one; if there are several and none matches, compare
    // against ALL of them (nothing duplicates) and the new lines go to a separate book.
    const ofMonth = await query('SELECT id, file FROM purchase_books WHERE period = $1 ORDER BY id', [period]);
    const book = ofMonth.find(b => b.file === file) ?? (ofMonth.length === 1 ? ofMonth[0] : null);
    const bookId = book?.id ?? null;
    const existing = ofMonth.length === 0 ? [] : await query(
        'SELECT sheet, row_num, quantity, unit_price, folio, description, description_norm FROM purchases WHERE book_id = ANY($1::int[])',
        [bookId === null ? ofMonth.map(b => b.id) : [bookId]]);
    const otherBooks = ofMonth.filter(b => b.id !== bookId).map(b => b.file);
    const matchedBook = book && book.file !== file ? book.file : null;
    const compared = compare(reading.lines, existing);

    // what the catalog already recognizes: a normalized description equal to an alias
    const linkOf = new Map((await query(
        `SELECT a.alias_norm, p.id, p.code, p.name FROM product_aliases a JOIN products p ON p.id = a.product_id
          WHERE a.alias_norm = ANY($1::text[])`, [[...new Set(compared.map(l => l.desc_norm))]]))
        .map(l => [l.alias_norm, { id: l.id, code: l.code, name: l.name }]));

    // a book name links to the supplier's name or to an alias a person already decided; the name wins if both match
    const suppliers = await query('SELECT id, name, archived_at IS NOT NULL AS archived FROM suppliers ORDER BY name');
    const aliases = await query('SELECT a.alias, p.id, p.name FROM supplier_aliases a JOIN suppliers p ON p.id = a.supplier_id');
    const supplierOf = new Map([
        ...aliases.map(e => [normalizeSupplier(e.alias), { id: e.id, name: e.name }]),
        ...suppliers.map(p => [normalizeSupplier(p.name), p]),
    ]);

    // product suggestions only for new lines the catalog doesn't recognize, same list and engine as Purchases
    const unrecognized = new Map(compared.filter(l => l.status === 'new' && !linkOf.has(l.desc_norm)).map(l => [l.description, l.desc_norm]));
    const productSuggestions = new Map();
    if (unrecognized.size > 0) {
        const candidates = await linkCandidates(q);
        for (const [description, norm] of unrecognized) {
            const s = suggest(norm, candidates);
            if (s) productSuggestions.set(description, s);
        }
    }

    const supplierSuggestions = new Map();
    for (const { supplier } of compared) {
        if (supplier && !supplierOf.has(normalizeSupplier(supplier)) && !supplierSuggestions.has(supplier)) {
            supplierSuggestions.set(supplier, suggestSupplier(supplier, suppliers.filter(p => !p.archived)));
        }
    }
    return { reading, compared, bookId, matchedBook, otherBooks, linkOf, supplierOf, productSuggestions, supplierSuggestions };
}

/**
 * 'near_certain' is the same form with other punctuation, or similarity >= 0.9 (the engine already guarantees
 * same numbers and no exclusive words): what "Mark the near-certain ones" ticks at once. The rest is 'similar'.
 * Input is the object suggest() returns.
 */
function forClient(s) {
    if (!s) return null;       // null, not undefined: JSON drops the key and the client expects null
    return {
        level: s.reason === 'same_form' || s.similarity >= 0.9 ? 'near_certain' : 'similar',
        similarity: s.similarity, product: s.product, similar_to: s.text, has_numbers: s.has_numbers,
    };
}

function summaryOf(a) {
    const { compared, linkOf } = a;
    const fresh = compared.filter(l => l.status === 'new');
    const count = status => compared.filter(l => l.status === status).length;
    return {
        lines: compared.length, new_count: fresh.length, existing_count: count('existing'), description_differs: count('description_differs'),
        new_amount: fresh.reduce((s, l) => s + amountOf(l), 0).toFixed(2),
        new_recognized: fresh.filter(l => linkOf.has(l.desc_norm)).length,
        new_unrecognized: fresh.filter(l => !linkOf.has(l.desc_norm)).length,
        new_no_supplier: fresh.filter(l => !l.supplier).length,
        new_no_date: fresh.filter(l => !l.date).length,
    };
}

function buildPreview(a, { file, period, sha256 }) {
    const { compared, linkOf, supplierOf, productSuggestions, supplierSuggestions } = a;
    const lineOut = l => ({
        row_num: l.row_num, block: l.block, status: l.status, type: l.type, date: l.date, date_status: l.date_status, folio: l.folio,
        description: l.description, quantity: numText(l.quantity, 3), unit_price: numText(l.unit_price, 3),
        amount: l.quantity && l.unit_price ? numText(amountOf(l), 2) : null,
        supplier: l.supplier, supplier_id: supplierOf.get(normalizeSupplier(l.supplier))?.id ?? null,
        requester: l.requester, note: l.note,
        product: linkOf.get(l.desc_norm) ?? null,
        suggestion: l.status === 'new' && !linkOf.has(l.desc_norm) ? forClient(productSuggestions.get(l.description)) : null,
        existing_description: l.existing_description ?? null,
    });
    const fresh = compared.filter(l => l.status === 'new');
    return {
        file, period, sha256, book_exists: a.bookId !== null, matched_book: a.matchedBook, other_books_of_month: a.otherBooks,
        summary: summaryOf(a),
        warnings: a.reading.warnings,
        notes: a.reading.notes,
        unlinked_suppliers: [...supplierSuggestions]
            .map(([name, suggested]) => ({ name, lines: fresh.filter(l => l.supplier === name).length, suggested }))
            .filter(p => p.lines > 0),
        sheets: a.reading.sheets.map(name => ({ name, lines: compared.filter(l => l.sheet === name).map(lineOut) })),
    };
}

/** Links and supplier links must belong to THIS book: nothing the person didn't see in the preview. */
async function validateDecisions(client, a, { links, supplierLinks }) {
    const descriptions = new Set(a.compared.map(l => l.description));
    const suppliers = new Set(a.compared.filter(l => l.status === 'new').map(l => l.supplier).filter(Boolean));
    for (const l of links) if (!descriptions.has(l.description)) throw new Rejection(`"${l.description.slice(0, 60)}" is not in this book`);
    for (const k of Object.keys(supplierLinks)) if (!suppliers.has(k)) throw new Rejection(`"${k.slice(0, 60)}" is not a supplier of the new lines in this book`);
    const ids = [...new Set(Object.values(supplierLinks).map(Number))];
    if (ids.length > 0 && (await client.query('SELECT id FROM suppliers WHERE id = ANY($1::int[])', [ids])).rows.length !== ids.length) {
        throw new Rejection('A chosen supplier does not exist');
    }
}

async function insertPurchases(client, bookId, fresh, a, supplierLinks, importId) {
    const COLUMNS = 17;
    // in batches: PostgreSQL allows 65,535 parameters per query
    for (let i = 0; i < fresh.length; i += 300) {
        const values = [], marks = [];
        fresh.slice(i, i + 300).forEach((l, j) => {
            const exact = a.supplierOf.get(normalizeSupplier(l.supplier))?.id;
            const chosen = supplierLinks[l.supplier] === undefined ? undefined : Number(supplierLinks[l.supplier]);
            marks.push(`(${Array.from({ length: COLUMNS }, (_, k) => `$${j * COLUMNS + k + 1}`).join(',')})`);
            values.push(bookId, l.sheet, l.sheet_order, l.cell, l.row_num, l.type, l.date, l.date_status, l.description,
                l.quantity, l.unit_price, l.supplier, exact ?? chosen ?? null, l.folio, l.requester, l.note, importId);
        });
        await client.query(
            `INSERT INTO purchases (book_id, sheet, sheet_order, cell, row_num, type, date, date_status, description, quantity,
                                    unit_price, supplier_text, supplier_id, folio, requester, note, import_id)
             VALUES ${marks.join(',')}`, values);
    }
}

async function link(client, links, userId, importId) {
    const skipped = [];
    for (const l of links) {
        const { rowCount } = await client.query(
            `INSERT INTO product_aliases (product_id, alias, origin, created_by, import_id)
             SELECT p.id, $2, 'manual', $3, $4 FROM products p WHERE p.id = $1 ON CONFLICT DO NOTHING`, [l.product_id, l.description, userId, importId]);
        if (rowCount === 0) skipped.push(l.description);
    }
    return { created: links.length - skipped.length, skipped };
}

module.exports = function createBooksRouter(pool) {
    const r = express.Router();
    // The book travels as base64 JSON. The size cap sits HERE, after session and role: whoever can't use the
    // module can't make us parse a big body either.
    const json = express.json({ limit: '12mb' });
    const respond = (req, res, err, message) => err instanceof Rejection || err instanceof XlsxError
        ? res.status(err.status ?? 422).json({ error: err.message })
        : fail(req, res, err, message);

    r.post('/preview', json, async (req, res) => {
        try {
            const c = readBody(req.body);
            res.json(buildPreview(await analyze(pool, c), c));
        } catch (err) { respond(req, res, err, 'Error reading the book'); }
    });

    r.post('/confirm', json, async (req, res) => {
        let client;
        try {
            const c = readBody(req.body), decisions = readDecisions(req.body);
            client = await pool.connect();
            await client.query('BEGIN');
            // two imports at once would compare against the same state and insert the same lines
            await client.query("SELECT pg_advisory_xact_lock(hashtext('import_book'))");
            const a = await analyze(client, c);
            await validateDecisions(client, a, decisions);

            const fresh = a.compared.filter(x => x.status === 'new');
            const bookId = a.bookId ?? (await client.query(
                'INSERT INTO purchase_books (file, period) VALUES ($1, $2) RETURNING id', [c.file, c.period])).rows[0].id;
            const summary = summaryOf(a);
            // the import goes FIRST: its lines and links name it, so it can be undone whole
            let importId = null;
            if (fresh.length > 0 || decisions.links.length > 0) {
                importId = (await client.query(
                    `INSERT INTO book_imports (book_id, file, sha256, user_id, new_count, existing_count, description_differs, links_created)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 0) RETURNING id`,
                    [bookId, c.file, c.sha256, req.user.id, fresh.length, summary.existing_count, summary.description_differs])).rows[0].id;
            }
            await insertPurchases(client, bookId, fresh, a, decisions.supplierLinks, importId);
            // the links' author comes from the session, never the body
            const links = await link(client, decisions.links, req.user.id, importId);
            // an import that changed nothing leaves no row
            if (importId !== null) {
                if (fresh.length === 0 && links.created === 0) await client.query('DELETE FROM book_imports WHERE id = $1', [importId]);
                else if (links.created > 0) await client.query('UPDATE book_imports SET links_created = $2 WHERE id = $1', [importId, links.created]);
            }
            await client.query('COMMIT');
            res.status(fresh.length > 0 ? 201 : 200).json({
                book_id: bookId, file: c.file, period: c.period, inserted: fresh.length,
                existing_count: summary.existing_count, description_differs: summary.description_differs,
                links_created: links.created, links_skipped: links.skipped, amount: summary.new_amount,
            });
        } catch (err) {
            await client?.query('ROLLBACK').catch(() => {});
            respond(req, res, err, 'Error importing the book');
        } finally { client?.release(); }
    });

    r.get('/history', async (req, res) => {
        try {
            const { rows } = await pool.query(`
                SELECT i.id, i.file, i.done_at, i.new_count, i.existing_count, i.links_created, i.undone_at,
                       u.name AS user_name, ud.name AS undone_by,
                       count(c.id)::int AS lines, count(c.movement_id)::int AS with_movement, round(sum(c.amount), 2)::text AS amount
                  FROM book_imports i
                  LEFT JOIN users u ON u.id = i.user_id
                  LEFT JOIN users ud ON ud.id = i.undone_by
                  LEFT JOIN purchases c ON c.import_id = i.id
                 GROUP BY i.id, u.name, ud.name
                 ORDER BY i.id DESC LIMIT 20`);
            res.json(rows.map(i => ({ ...i, undo_blocked_reason: i.undone_at ? null : undoBlockedReason(i) })));
        } catch (err) { fail(req, res, err, 'Error loading the imports'); }
    });

    r.post('/:id/undo', auth.requireRole('admin'), async (req, res) => {
        let client;
        try {
            const id = toPositiveInt(req.params.id);
            if (id === null) throw new Rejection('Invalid id');
            client = await pool.connect();
            await client.query('BEGIN');
            await client.query("SELECT pg_advisory_xact_lock(hashtext('import_book'))");
            const { rows: [imp] } = await client.query(
                `SELECT i.id, i.book_id, i.new_count, i.undone_at,
                        count(c.id)::int AS lines, count(c.movement_id)::int AS with_movement, coalesce(round(sum(c.amount), 2), 0)::text AS amount
                   FROM book_imports i LEFT JOIN purchases c ON c.import_id = i.id
                  WHERE i.id = $1 GROUP BY i.id`, [id]);
            if (!imp) throw new Rejection('That import does not exist', 404);
            if (imp.undone_at) throw new Rejection('That import was already undone', 409);
            const reason = undoBlockedReason(imp);
            if (reason) throw new Rejection(reason, 409);

            const lines = (await client.query('DELETE FROM purchases WHERE import_id = $1', [id])).rowCount;
            const links = (await client.query('DELETE FROM product_aliases WHERE import_id = $1', [id])).rowCount;
            // a book with no lines would count as a "month with a book" on the dashboard: if this import was all it had, it goes too
            let bookDeleted = false;
            if (imp.book_id !== null) {
                const { rows: [{ remaining }] } = await client.query('SELECT count(*)::int AS remaining FROM purchases WHERE book_id = $1', [imp.book_id]);
                if (remaining === 0) { await client.query('DELETE FROM purchase_books WHERE id = $1', [imp.book_id]); bookDeleted = true; }
            }
            await client.query('UPDATE book_imports SET undone_at = now(), undone_by = $2 WHERE id = $1', [id, req.user.id]);
            await client.query('COMMIT');
            res.json({ ok: true, lines, links, amount: imp.amount, book_deleted: bookDeleted });
        } catch (err) {
            await client?.query('ROLLBACK').catch(() => {});
            respond(req, res, err, 'Error undoing the import');
        } finally { client?.release(); }
    });

    return r;
};

/** Why a live import can't be undone; null if it can. `i` has `new_count`, `lines` and `with_movement`. */
function undoBlockedReason(i) {
    if (i.new_count > 0 && i.lines === 0) return 'It predates undo: its lines were not marked and can\'t be told apart from the rest.';
    if (i.with_movement > 0) return `${i.with_movement === 1 ? 'One of its lines is' : `${i.with_movement} of its lines are`} already linked to an inventory movement.`;
    return null;
}

module.exports.periodFromFile = periodFromFile;
module.exports.parseBook = parseBook;
module.exports.compare = compare;
module.exports.suggestSupplier = suggestSupplier;
module.exports.forClient = forClient;
