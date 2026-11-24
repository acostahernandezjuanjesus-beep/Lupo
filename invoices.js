// Invoice capture (accounts payable). Mounted behind session AND the
// storekeeper/admin role: operators don't see spending, and the server enforces it.
//
// Rules:
//  - The UUID only comes from the XML, the QR, or a person typing it from the
//    paper. Never from AI (it invented folios even when told to say "unreadable").
//  - The XML wins over whatever the client sends.
//  - XML and QR from the same sheet that disagree: nothing is saved.
//  - Amounts are the printed ones; nothing is recomputed.
//  - `captured_by` comes from the session, never from the body.

const express = require('express');
const crypto = require('node:crypto');
const { classifyInvoice, SPEND_CATEGORIES } = require('./classify');
const { readStrips } = require('./aiReader');
const { noNulls } = require('./noNulls');
const { toPositiveInt, escapeLike, fail } = require('./util');
const { resolveSupplier } = require('./suppliers');
const { readQr, readXml, crossCheck, amountText, sameAmount, RE_UUID, RE_RFC } = require('./cfdi');

const PAGE_SIZE = 50;
const MAX_LINES = 300;
const PURCHASE_TYPES = ['stock', 'direct_to_job', 'unclassified'];
const PAYMENT_METHODS = ['PUE', 'PPD'];
const NON_XML_SOURCES = ['qr', 'photo', 'manual'];

// ---- Field validation: a malformed value is a 400 with a reason, never a Postgres 500 (22P02/22001/22003) ----

// null = empty, undefined = invalid
const str = (v, max) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    if (t === '') return null;
    return t.length <= max ? t : undefined;
};

const toInt = toPositiveInt;

/** YYYY-MM-DD that actually exists (not 2026-02-31). */
function isoDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    const d = new Date(`${v}T12:00:00Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : undefined;
}

/** Amount in cents for numeric(14,2): up to 12 integer digits. undefined if not an amount. */
function money(v) {
    if (v === undefined || v === null || v === '') return null;
    const t = amountText(typeof v === 'number' ? String(v) : v);
    return t !== null && t.split('.')[0].length <= 12 ? t : undefined;
}

/** Quantity or unit price for numeric(18,6). */
function exact(v) {
    if (v === undefined || v === null || v === '') return null;
    const t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
    return /^\d{1,12}(\.\d{1,6})?$/.test(t) ? t : undefined;
}

// Search: ignores case and accents, matches anywhere. Every word must appear in
// the invoice fields or in one of its lines.
const NO_ACCENT = c => `translate(lower(${c}), 'áéíóúüñ', 'aeiouun')`;
const HAYSTACK = NO_ACCENT(`concat_ws(' ', f.issuer_name, f.issuer_rfc, f.series, f.folio, f.series || '-' || f.folio, f.uuid,
    f.note, f.spend_category, f.project, f.supplier_ids::text, to_char(f.invoice_date, 'YYYY-MM-DD'), f.total::text)`);
const LINE_HAYSTACK = NO_ACCENT(`concat_ws(' ', l.description, l.identification_no, l.prod_serv_key)`);
const stripAccents = t => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MAX_TERMS = 6;

// ---- What is read and what is saved ----

const COLUMNS = `
    f.id, f.source, f.uuid, f.uuid_source, f.supplier_id, p.name AS supplier,
    f.issuer_rfc, f.issuer_name, f.receiver_rfc, f.series, f.folio, f.voucher_type,
    to_char(f.invoice_date, 'YYYY-MM-DD') AS invoice_date, f.date_confirmed,
    f.stamped_at, f.captured_at, f.captured_by, u.name AS captured_by_name,
    f.subtotal, f.vat, f.total, f.currency, f.payment_method, f.payment_form, f.cfdi_use,
    f.purchase_type, to_char(f.due_on, 'YYYY-MM-DD') AS due_on,
    to_char(f.paid_at, 'YYYY-MM-DD') AS paid_at,
    f.supplier_ids, f.pages, f.sat_status, f.sat_status_checked_at, f.note,
    f.spend_category, f.project, f.classification,
    (SELECT count(*)::int FROM invoice_lines l WHERE l.invoice_id = f.id) AS lines_total,
    (SELECT count(*)::int FROM invoice_lines l WHERE l.invoice_id = f.id AND l.reconciliation <> 'pending') AS lines_reconciled`;
const FROM_JOINS = `FROM invoices f
      LEFT JOIN suppliers p ON p.id = f.supplier_id
      LEFT JOIN users u ON u.id = f.captured_by`;

/** How many already-classified invoices this issuer has, by type (the history classify.js uses). */
async function historyOf(db, rfc) {
    if (!rfc) return {};
    const { rows } = await db.query(
        `SELECT purchase_type, count(*)::int AS n FROM invoices
          WHERE issuer_rfc = $1 AND purchase_type IN ('stock', 'direct_to_job') GROUP BY 1`, [rfc]);
    return Object.fromEntries(rows.map(x => [x.purchase_type, x.n]));
}

async function alreadyRegistered(pool, uuid) {
    const { rows } = await pool.query(
        `SELECT id, to_char(invoice_date, 'YYYY-MM-DD') AS invoice_date, total, issuer_name
           FROM invoices WHERE uuid = $1`, [uuid]);
    return rows[0] ?? null;
}

/**
 * Merges what the sources say and what the person sent into one row to save, or
 * returns { error } / { conflict }. All the "what wins" policy lives here so it
 * can be tested without a database.
 */
function buildInvoice(b) {
    const c = b ?? {};
    const out = {};
    const typed = {};                       // what the person may have typed
    const read = (name, validate, max) => {
        const v = validate === str ? str(c[name], max) : validate(c[name]);
        if (v === undefined) throw new Error(`${name} is not valid`);
        typed[name] = v;
    };

    try {
        for (const [n, max] of [['issuer_name', 200], ['series', 25], ['folio', 40], ['voucher_type', 1],
            ['payment_form', 2], ['cfdi_use', 4], ['note', 1000]]) read(n, str, max);
        read('issuer_rfc', v => { const t = str(v, 13)?.toUpperCase() ?? null; return t === null || RE_RFC.test(t) ? t : undefined; });
        read('receiver_rfc', v => { const t = str(v, 13)?.toUpperCase() ?? null; return t === null || RE_RFC.test(t) ? t : undefined; });
        read('invoice_date', v => v === undefined || v === null || v === '' ? null : isoDate(v));
        read('due_on', v => v === undefined || v === null || v === '' ? null : isoDate(v));
        read('subtotal', money); read('vat', money); read('total', money);
        read('currency', v => { const t = str(v, 3)?.toUpperCase() ?? null; return t === null || /^[A-Z]{3}$/.test(t) ? t : undefined; });
        read('payment_method', v => { const t = str(v, 3)?.toUpperCase() ?? null; return t === null || PAYMENT_METHODS.includes(t) ? t : undefined; });
        read('pages', v => v === undefined || v === null || v === '' ? 1 : toInt(v) ?? undefined);
        read('supplier_id', v => v === undefined || v === null || v === '' ? null : toInt(v) ?? undefined);
        read('purchase_type', v => v === undefined || v === null || v === '' ? 'unclassified' : PURCHASE_TYPES.includes(v) ? v : undefined);
        read('spend_category', v => { const t = str(v, 60); return t === undefined || t === null || SPEND_CATEGORIES.includes(t) ? t : undefined; });
        read('project', str, 40);
        read('supplier_ids', v => {
            if (v === undefined || v === null) return {};
            if (typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length > 20) return undefined;
            for (const [k, x] of Object.entries(v)) if (k.length > 60 || typeof x !== 'string' || x.length > 120) return undefined;
            return v;
        });
    } catch (e) {
        return { error: e.message };
    }

    // 1. The XML, if present, is the source that rules.
    let F = null;
    if (c.xml !== undefined && c.xml !== null) {
        const r = readXml(c.xml);
        if (!r.ok) return { error: r.error };
        F = r.invoice;
    }
    // 2. The QR.
    let Q = null;
    if (c.qr !== undefined && c.qr !== null && c.qr !== '') {
        const r = readQr(c.qr);
        if (!r.ok) return { error: r.error };
        Q = r.qr;
    }
    if (F && Q) {
        const discrepancies = crossCheck(F, Q);
        if (discrepancies.length) {
            return { conflict: { error_code: 'mismatch', discrepancies,
                error: 'The XML and the QR are not from the same invoice. Nothing was saved.' } };
        }
    }

    // How it came in. The server derives it, not the client.
    if (F) out.source = 'xml';
    else if (NON_XML_SOURCES.includes(c.source)) out.source = c.source;
    else return { error: 'source must be xml, qr, photo or manual' };
    // With a readable QR it is not "manual": the person typed the rest but the UUID came from the QR.
    if (Q && out.source === 'manual') out.source = 'qr';
    if (out.source === 'qr' && !Q) return { error: 'A QR invoice needs the QR' };
    if (out.source === 'xml' && !F) return { error: 'An XML invoice needs the XML' };

    // The UUID: XML, QR or typed. Never "read".
    if (F) { out.uuid = F.uuid; out.uuid_source = 'xml'; }
    else if (Q) { out.uuid = Q.uuid; out.uuid_source = 'qr'; }
    else if (c.manual_uuid !== undefined && c.manual_uuid !== null && c.manual_uuid !== '') {
        const u = typeof c.manual_uuid === 'string' ? c.manual_uuid.trim().toUpperCase() : '';
        if (!RE_UUID.test(u)) return { error: 'The typed fiscal folio is not shaped like a UUID' };
        out.uuid = u; out.uuid_source = 'manual';
    } else { out.uuid = null; out.uuid_source = null; }

    // Paper data: the XML wins, then the QR, then what the person typed.
    const pick = (n, qrKey) => F && F[n] !== undefined && F[n] !== null ? F[n]
        : Q && qrKey && Q[qrKey] !== undefined ? Q[qrKey] : typed[n];
    out.issuer_rfc = pick('issuer_rfc', 'issuer_rfc');
    out.receiver_rfc = pick('receiver_rfc', 'receiver_rfc');
    out.issuer_name = pick('issuer_name');
    out.series = pick('series'); out.folio = pick('folio');
    out.voucher_type = pick('voucher_type');
    out.payment_form = pick('payment_form'); out.cfdi_use = pick('cfdi_use');
    out.currency = pick('currency') ?? 'MXN';
    out.stamped_at = F?.stamped_at ?? null;
    out.xml_text = F ? c.xml : null;                      // also stored as a file

    out.invoice_date = F?.invoice_date ?? typed.invoice_date;
    // Only the XML confirms a date by itself. Without it a person has to look (it is the
    // field the AI misread reproducibly), and only if there is a date.
    out.date_confirmed = out.invoice_date != null && (F != null || c.date_confirmed === true);

    // Amounts: from the XML if present; the total from the QR; and a typed total that
    // contradicts the QR is not saved (two independent sources disagree, someone is wrong).
    const totalValue = F ? money(F.total) : Q ? Q.total : typed.total;
    if (totalValue === undefined || totalValue === null) return { error: 'total is required' };
    if (!F && Q && typed.total !== null && sameAmount(typed.total, Q.total) === false) {
        return { conflict: { error_code: 'total_mismatch', qr_total: Q.total, typed_total: typed.total,
            error: 'The total you typed is not the one in the QR. Check the paper.' } };
    }
    out.total = totalValue;
    out.subtotal = F ? money(F.subtotal) : typed.subtotal;
    out.vat = F ? money(F.vat) : typed.vat;
    if (out.subtotal === undefined || out.vat === undefined) return { error: 'subtotal or vat is not an amount' };

    const xmlMethod = F?.payment_method && PAYMENT_METHODS.includes(F.payment_method) ? F.payment_method : null;
    out.payment_method = xmlMethod ?? typed.payment_method;

    // What the person decides, with or without XML.
    out.purchase_type = typed.purchase_type;
    // Did the person pick these three? If not, classify.js proposes them; if so, their pick rules and is marked manual.
    out.chose = {
        purchase_type: c.purchase_type !== undefined && c.purchase_type !== null && c.purchase_type !== '',
        spend_category: typed.spend_category !== null, project: typed.project !== null,
    };
    out.spend_category = typed.spend_category; out.project = typed.project;
    out.due_on = typed.due_on;
    out.supplier_ids = typed.supplier_ids;
    out.pages = typed.pages;
    out.supplier_id = typed.supplier_id;
    out.note = typed.note;

    // Lines.
    const rawLines = F ? F.lines : Array.isArray(c.lines) ? c.lines : c.lines === undefined ? [] : null;
    if (rawLines === null) return { error: 'lines must be a list' };
    if (rawLines.length > MAX_LINES) return { error: `An invoice cannot have more than ${MAX_LINES} lines` };
    out.lines = [];
    for (const [i, k] of rawLines.entries()) {
        if (!k || typeof k !== 'object') return { error: `Line ${i + 1} is not valid` };
        const description = str(k.description, 500);
        if (!description) return { error: `Line ${i + 1} needs a description` };
        const l = {
            sort_order: i + 1, description,
            quantity: exact(k.quantity), unit_value: exact(k.unit_value), amount: money(k.amount),
            unit: str(k.unit, 40), unit_key: str(k.unit_key, 10),
            prod_serv_key: str(k.prod_serv_key, 10), identification_no: str(k.identification_no, 100),
        };
        for (const [n, v] of Object.entries(l)) if (v === undefined) return { error: `Line ${i + 1}: ${n} is not valid` };
        out.lines.push(l);
    }
    return { data: out };
}

// ---- Files: the original of each invoice, to read inside the app ----

const MAX_FILE = 15 * 1024 * 1024;
const MAX_FILES_PER_INVOICE = 20;

/** The REAL type of a file by its first bytes: a .exe renamed to .pdf declares application/pdf. */
function realType(b) {
    if (b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    // XML: starts with "<" (after an optional BOM and whitespace).
    const text = b.subarray(0, 64).toString('utf8');
    const head = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trimStart();
    if (head.startsWith('<')) return 'application/xml';
    return null;
}

const safeName = v => {
    let n;
    try { n = decodeURIComponent(String(v ?? '')); } catch { n = String(v ?? ''); }
    n = n.replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 200);
    return n || 'file';
};

// ---- The router ----

module.exports = function createInvoicesRouter(pool) {
    const r = express.Router();
    // A whole XML travels as text, so the global 100 KB cap is too small. It lives here,
    // after session and role, so someone who can't use this can't make the server parse 3 MB.
    // Not on file upload: there the body is the raw file, and the JSON parser would eat it first.
    const invoicesJson = express.json({ limit: '3mb' });
    r.use((req, res, next) => /\/files$|\/read-photo$/.test(req.path) ? next() : invoicesJson(req, res, next));
    r.use(noNulls);

    // Reads a QR and says whether that invoice is already registered. Saves nothing.
    r.post('/read-qr', async (req, res) => {
        const parsed = readQr((req.body ?? {}).text);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        try {
            res.json({ qr: parsed.qr, already_registered: await alreadyRegistered(pool, parsed.qr.uuid) });
        } catch (err) {
            fail(req, res, err, 'Error looking up the invoice');
        }
    });

    // Reads a paper invoice with DeepSeek, one strip at a time (see aiReader.js).
    // Saves nothing and returns no UUID: the result is a draft a person confirms.
    // It costs money and sends images to a third party: storekeeper/admin only, a cap
    // on strips, and at most two readings at once.
    const stripsJson = express.json({ limit: '14mb' });
    const MAX_STRIPS = 16;
    let readingAi = 0;
    r.post('/read-photo', stripsJson, async (req, res) => {
        const key = process.env.DEEPSEEK_API_KEY;
        if (!key) return res.status(503).json({ error: 'AI reading is not configured on this server. Enter the invoice by hand or from its XML.' });
        const strips = (req.body ?? {}).strips;
        if (!Array.isArray(strips) || strips.length < 1 || strips.length > MAX_STRIPS) {
            return res.status(400).json({ error: `strips must be a list of 1 to ${MAX_STRIPS} images` });
        }
        for (const [i, b] of strips.entries()) {
            // Each strip is a base64 JPEG; checked by its bytes, not by what the client says.
            if (typeof b !== 'string' || b.length > 1_500_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)
                || realType(Buffer.from(b.slice(0, 16), 'base64')) !== 'image/jpeg') {
                return res.status(400).json({ error: `Strip ${i + 1} is not a valid JPEG` });
            }
        }
        if (readingAi >= 2) return res.status(429).json({ error: 'Other invoices are already being read. Wait a moment.' });
        readingAi++;
        try {
            res.json(await readStrips(strips, { key }));
        } catch (err) {
            console.error('read-photo:', err.message);
            res.status(500).json({ error: 'Error reading the invoice' });
        } finally {
            readingAi--;
        }
    });

    // Reads an XML (optionally cross-checked with the QR of the same sheet). Saves nothing.
    // Also returns the classification it would get, to see before saving.
    r.post('/read-xml', async (req, res) => {
        const b = req.body ?? {};
        const parsed = readXml(b.xml);
        if (!parsed.ok) return res.status(400).json({ error: parsed.error });
        let discrepancies = null;
        if (b.qr !== undefined && b.qr !== null && b.qr !== '') {
            const q = readQr(b.qr);
            if (!q.ok) return res.status(400).json({ error: q.error });
            discrepancies = crossCheck(parsed.invoice, q.qr);
        }
        try {
            const f = parsed.invoice;
            const history = await historyOf(pool, f.issuer_rfc);
            const classification = classifyInvoice({ lines: f.lines, history });
            res.json({ invoice: f, discrepancies, classification, already_registered: await alreadyRegistered(pool, f.uuid) });
        } catch (err) {
            fail(req, res, err, 'Error looking up the invoice');
        }
    });

    r.post('/', async (req, res) => {
        const a = buildInvoice(req.body);
        if (a.error) return res.status(400).json({ error: a.error });
        if (a.conflict) return res.status(409).json(a.conflict);
        const d = a.data;

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // No supplier chosen: link an existing one by issuer RFC (firmest) or by name or an
            // equivalence. None is created: adding one is a decision for the Suppliers screen.
            if (d.supplier_id === null || d.supplier_id === undefined) {
                d.supplier_id = await resolveSupplier(client, { rfc: d.issuer_rfc, name: d.issuer_name });
            }
            // Automatic categories. What the person chose while capturing rules.
            const auto = classifyInvoice({ lines: d.lines, supplier_ids: d.supplier_ids, note: d.note,
                history: await historyOf(client, d.issuer_rfc) });
            const manual = value => ({ value, source: 'manual', reason: 'chosen when captured' });
            const classification = {
                spend_category: d.chose.spend_category ? manual(d.spend_category) : auto.spend_category,
                project: d.chose.project ? manual(d.project) : auto.project,
                purchase_type: d.chose.purchase_type ? manual(d.purchase_type) : auto.purchase_type,
            };

            const { rows: [row] } = await client.query(
                `INSERT INTO invoices
                    (source, uuid, uuid_source, supplier_id, issuer_rfc, issuer_name, receiver_rfc,
                     series, folio, voucher_type, invoice_date, date_confirmed, stamped_at,
                     captured_by, subtotal, vat, total, currency, payment_method, payment_form, cfdi_use,
                     purchase_type, due_on, supplier_ids, pages, note, spend_category, project, classification)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
                 RETURNING id`,
                [d.source, d.uuid, d.uuid_source, d.supplier_id, d.issuer_rfc, d.issuer_name, d.receiver_rfc,
                    d.series, d.folio, d.voucher_type, d.invoice_date, d.date_confirmed, d.stamped_at,
                    // `captured_by` is the session, never the body.
                    req.user.id, d.subtotal, d.vat, d.total, d.currency, d.payment_method, d.payment_form, d.cfdi_use,
                    classification.purchase_type.value, d.due_on, JSON.stringify(d.supplier_ids), d.pages, d.note,
                    classification.spend_category.value, classification.project.value, JSON.stringify(classification)]);
            for (const l of d.lines) {
                await client.query(
                    `INSERT INTO invoice_lines
                        (invoice_id, sort_order, description, quantity, unit, unit_key, prod_serv_key,
                         identification_no, unit_value, amount)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                    [row.id, l.sort_order, l.description, l.quantity, l.unit, l.unit_key, l.prod_serv_key,
                        l.identification_no, l.unit_value, l.amount]);
            }
            // The XML that was read is also the original: keep it to view later.
            if (d.xml_text) {
                const buf = Buffer.from(d.xml_text, 'utf8');
                if (buf.length <= MAX_FILE) {
                    await client.query(
                        `INSERT INTO invoice_files (invoice_id, name, mime, bytes, sha256, content, uploaded_by)
                         VALUES ($1, $2, 'application/xml', $3, $4, $5, $6)`,
                        [row.id, `${d.series ?? ''}${d.folio ?? 'invoice'}.xml`, buf.length,
                            crypto.createHash('sha256').update(buf).digest('hex'), buf, req.user.id]);
                }
            }
            await client.query('COMMIT');
            res.status(201).json({ id: row.id, uuid: d.uuid, source: d.source, lines: d.lines.length, classification });
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* connection already dead */ }
            if (err.code === '23505') {
                const existing = d.uuid ? await alreadyRegistered(pool, d.uuid).catch(() => null) : null;
                return res.status(409).json({ error_code: 'duplicate_invoice', existing,
                    error: 'That invoice is already registered' });
            }
            if (err.code === '23503') return res.status(400).json({ error: 'The supplier does not exist' });
            if (err.code === '23514') return res.status(400).json({ error: 'Some invoice data breaks the rules' });
            fail(req, res, err, 'Error saving the invoice');
        } finally {
            client.release();
        }
    });

    // Automatic categories with counts, for browsing: who billed, which month,
    // spend category, project and payment status, over ALL invoices. Nulls are
    // counted apart ("unclassified", not zero).
    r.get('/categories', async (req, res) => {
        const group = (key, name = null) => `SELECT ${key} AS key, ${name ?? key} AS name, count(*)::int AS invoices,
                sum(total)::text AS amount FROM invoices GROUP BY 1, 2 ORDER BY sum(total) DESC NULLS LAST LIMIT 30`;
        try {
            const [suppliers, months, categories, projects, statuses, types] = await Promise.all([
                pool.query(`SELECT COALESCE(issuer_rfc, 'no_rfc') AS key, max(COALESCE(issuer_name, '(no name)')) AS name,
                                   count(*)::int AS invoices, sum(total)::text AS amount
                              FROM invoices GROUP BY 1 ORDER BY sum(total) DESC NULLS LAST LIMIT 30`),
                pool.query(`SELECT COALESCE(to_char(invoice_date, 'YYYY-MM'), 'no_date') AS key,
                                   COALESCE(to_char(invoice_date, 'YYYY-MM'), 'No date') AS name,
                                   count(*)::int AS invoices, sum(total)::text AS amount
                              FROM invoices GROUP BY 1, 2 ORDER BY 1 DESC LIMIT 24`),
                pool.query(group(`COALESCE(spend_category, 'no_category')`, `COALESCE(spend_category, 'No category')`)),
                pool.query(group(`COALESCE(project, 'no_project')`, `COALESCE(project, 'No project')`)),
                pool.query(`SELECT count(*) FILTER (WHERE paid_at IS NULL)::int AS to_pay,
                                   count(*) FILTER (WHERE paid_at IS NULL AND due_on < current_date)::int AS overdue,
                                   count(*) FILTER (WHERE paid_at IS NOT NULL)::int AS paid FROM invoices`),
                pool.query(group(`purchase_type`)),
            ]);
            res.json({ suppliers: suppliers.rows, months: months.rows, spend_categories: categories.rows, projects: projects.rows, types: types.rows,
                statuses: statuses.rows[0], available_spend_categories: SPEND_CATEGORIES });
        } catch (err) {
            fail(req, res, err, 'Error loading the categories');
        }
    });

    r.get('/', async (req, res) => {
        const { q, status, purchase_type, supplier, month, spend_category, project, from, to, min_amount, max_amount } = req.query;
        const requested = Number(req.query.page);
        const page = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
        // A page too big for a safe integer would give an infinite OFFSET and a Postgres 500 ("bigint: “Infinity”").
        if (!Number.isSafeInteger((page - 1) * PAGE_SIZE)) return res.status(400).json({ error: 'page out of range' });
        const values = [], cond = [];
        const param = v => { values.push(v); return `$${values.length}`; };
        const textParam = (v, max, name) => {
            if (v === undefined || v === '') return null;
            if (typeof v !== 'string' || v.length > max) { throw new Error(`${name} is invalid`); }
            return v;
        };
        try {
            const search = textParam(q, 200, 'q');
            if (search !== null) {
                const terms = stripAccents(search).split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
                for (const t of terms) {
                    const p = param(`%${escapeLike(t)}%`);
                    cond.push(`(${HAYSTACK} LIKE ${p} ESCAPE '\\'
                        OR EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = f.id AND ${LINE_HAYSTACK} LIKE ${p} ESCAPE '\\'))`);
                }
            }
            if (status !== undefined && status !== '') {
                if (status === 'to_pay') cond.push('f.paid_at IS NULL');
                else if (status === 'paid') cond.push('f.paid_at IS NOT NULL');
                else if (status === 'overdue') cond.push('f.paid_at IS NULL AND f.due_on < current_date');
                else throw new Error('status is invalid');
            }
            if (purchase_type !== undefined && purchase_type !== '') {
                if (!PURCHASE_TYPES.includes(purchase_type)) throw new Error('purchase_type is invalid');
                cond.push(`f.purchase_type = ${param(purchase_type)}`);
            }
            const sup = textParam(supplier, 13, 'supplier');
            if (sup !== null) cond.push(sup === 'no_rfc' ? 'f.issuer_rfc IS NULL' : `f.issuer_rfc = ${param(sup.toUpperCase())}`);
            const m = textParam(month, 10, 'month');
            if (m !== null) {
                if (m === 'no_date') cond.push('f.invoice_date IS NULL');
                else if (/^\d{4}-\d{2}$/.test(m)) cond.push(`to_char(f.invoice_date, 'YYYY-MM') = ${param(m)}`);
                else throw new Error('month is invalid');
            }
            const cat = textParam(spend_category, 60, 'spend_category');
            if (cat !== null) cond.push(cat === 'no_category' ? 'f.spend_category IS NULL' : `f.spend_category = ${param(cat)}`);
            const pr = textParam(project, 40, 'project');
            if (pr !== null) cond.push(pr === 'no_project' ? 'f.project IS NULL' : `f.project = ${param(pr)}`);
            for (const [name, v, op] of [['from', from, '>='], ['to', to, '<=']]) {
                if (v === undefined || v === '') continue;
                const f = isoDate(v);
                if (f === undefined) throw new Error(`${name} must be YYYY-MM-DD`);
                cond.push(`f.invoice_date ${op} ${param(f)}`);
            }
            for (const [name, v, op] of [['min_amount', min_amount, '>='], ['max_amount', max_amount, '<=']]) {
                if (v === undefined || v === '') continue;
                const d = money(v);
                if (d === undefined || d === null) throw new Error(`${name} must be an amount`);
                cond.push(`f.total ${op} ${param(d)}`);
            }
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
        const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
        try {
            const { rows: [t] } = await pool.query(`SELECT COUNT(*) FROM invoices f ${where}`, values);
            const total = Number(t.count);
            const { rows } = await pool.query(
                `SELECT ${COLUMNS} ${FROM_JOINS} ${where}
                  ORDER BY f.invoice_date DESC NULLS LAST, f.id DESC
                  LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
                [...values, PAGE_SIZE, (page - 1) * PAGE_SIZE]);
            // What is owed, over ALL invoices (not the filter or the page). An empty sum is null, not 0.
            const { rows: [s] } = await pool.query(
                `SELECT count(*) FILTER (WHERE paid_at IS NULL)::int AS to_pay,
                        sum(total) FILTER (WHERE paid_at IS NULL)::text AS to_pay_amount,
                        count(*) FILTER (WHERE paid_at IS NULL AND due_on < current_date)::int AS overdue,
                        sum(total) FILTER (WHERE paid_at IS NULL AND due_on < current_date)::text AS overdue_amount
                   FROM invoices`);
            res.json({ invoices: rows, total, page, pages: Math.ceil(total / PAGE_SIZE), summary: s });
        } catch (err) {
            fail(req, res, err, 'Error loading the invoices');
        }
    });

    // Files (before /:id, which must not swallow these routes)

    r.get('/files/:fileId', async (req, res) => {
        const fileId = toInt(req.params.fileId);
        if (fileId === null) return res.status(400).json({ error: 'id must be a positive integer' });
        try {
            const { rows } = await pool.query('SELECT name, mime, bytes, content FROM invoice_files WHERE id = $1', [fileId]);
            if (rows.length === 0) return res.status(404).json({ error: 'The file does not exist' });
            const a = rows[0];
            res.set({
                'Content-Type': a.mime,
                'Content-Length': String(a.bytes),
                'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.name)}`,
                // An uploaded file is never interpreted or run: opened directly it is plain data, no scripts.
                'X-Content-Type-Options': 'nosniff',
                'Content-Security-Policy': "sandbox; default-src 'none'",
                'Cache-Control': 'private, max-age=3600',
            });
            res.end(a.content);
        } catch (err) {
            fail(req, res, err, 'Error reading the file');
        }
    });

    r.delete('/files/:fileId', async (req, res) => {
        const fileId = toInt(req.params.fileId);
        if (fileId === null) return res.status(400).json({ error: 'id must be a positive integer' });
        try {
            const { rowCount } = await pool.query('DELETE FROM invoice_files WHERE id = $1', [fileId]);
            if (rowCount === 0) return res.status(404).json({ error: 'The file does not exist' });
            res.status(204).end();
        } catch (err) {
            fail(req, res, err, 'Error deleting the file');
        }
    });

    // Uploads an original: the body IS the file (no base64, which adds 33 %).
    r.post('/:id/files', express.raw({ type: () => true, limit: MAX_FILE + 1024 }), async (req, res) => {
        const id = toInt(req.params.id);
        if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
        const buf = req.body;
        if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'The file is empty' });
        if (buf.length > MAX_FILE) return res.status(413).json({ error: 'The file is over 15 MB' });
        const real = realType(buf);
        if (real === null) return res.status(415).json({ error: 'Only PDF, JPG, PNG, WEBP and XML are accepted' });
        // The type the client declares must match what the file IS.
        const declared = String(req.get('content-type') ?? '').split(';')[0].trim().toLowerCase().replace('text/xml', 'application/xml');
        if (declared !== real) return res.status(415).json({ error: `The file claims to be ${declared || 'something else'} but is ${real}` });
        try {
            const { rows: [n] } = await pool.query('SELECT count(*)::int AS n FROM invoice_files WHERE invoice_id = $1', [id]);
            if (n.n >= MAX_FILES_PER_INVOICE) return res.status(409).json({ error: `An invoice takes up to ${MAX_FILES_PER_INVOICE} files` });
            const { rows: [a] } = await pool.query(
                `INSERT INTO invoice_files (invoice_id, name, mime, bytes, sha256, content, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, mime, bytes`,
                [id, safeName(req.get('x-name')), real, buf.length, crypto.createHash('sha256').update(buf).digest('hex'), buf, req.user.id]);
            res.status(201).json(a);
        } catch (err) {
            if (err.code === '23505') return res.status(409).json({ error_code: 'duplicate_file', error: 'That file is already on the invoice' });
            if (err.code === '23503') return res.status(404).json({ error: 'The invoice does not exist' });
            fail(req, res, err, 'Error saving the file');
        }
    });

    r.get('/:id', async (req, res) => {
        const id = toInt(req.params.id);
        if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
        try {
            const { rows } = await pool.query(`SELECT ${COLUMNS} ${FROM_JOINS} WHERE f.id = $1`, [id]);
            if (rows.length === 0) return res.status(404).json({ error: 'The invoice does not exist' });
            const { rows: lines } = await pool.query(
                `SELECT sort_order, description, quantity, unit, unit_key, prod_serv_key, identification_no,
                        unit_value, amount, product_id
                   FROM invoice_lines WHERE invoice_id = $1 ORDER BY sort_order`, [id]);
            const { rows: files } = await pool.query(
                'SELECT id, name, mime, bytes, uploaded_at FROM invoice_files WHERE invoice_id = $1 ORDER BY id', [id]);
            res.json({ ...rows[0], lines, files });
        } catch (err) {
            fail(req, res, err, 'Error loading the invoice');
        }
    });

    // Removes an invoice (captured by mistake, or a test). Its lines and files go
    // with it (ON DELETE CASCADE) and a snapshot stays in `deleted_invoices` with
    // who removed it, since an invoice is an accounting document. Files are not kept.
    //
    // An invoice that already generated stock-ins is NOT deleted: the balance
    // changed and the movement log is not rewritten; fix it with an adjustment.
    // Those lines are the ones with reconciliation = 'stock_in'.
    r.delete('/:id', async (req, res) => {
        const id = toInt(req.params.id);
        if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: [f] } = await client.query(
                `SELECT id, uuid, issuer_name, issuer_rfc, series, folio, invoice_date, total FROM invoices WHERE id = $1 FOR UPDATE`, [id]);
            if (!f) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'The invoice does not exist' }); }
            const { rows: [n] } = await client.query(
                `SELECT count(*)::int AS lines, count(*) FILTER (WHERE reconciliation = 'stock_in')::int AS stock_ins,
                        (SELECT count(*)::int FROM invoice_files WHERE invoice_id = $1) AS files
                   FROM invoice_lines WHERE invoice_id = $1`, [id]);
            if (n.stock_ins > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error_code: 'has_stock_ins', stock_ins: n.stock_ins,
                    error: `This invoice already generated ${n.stock_ins} stock-in${n.stock_ins === 1 ? '' : 's'} and cannot be removed: the balance already changed. Fix a wrong stock-in with an adjustment.` });
            }
            // The author comes from the session, never from the body.
            await client.query(
                `INSERT INTO deleted_invoices (invoice_id, uuid, issuer_name, issuer_rfc, series, folio, invoice_date, total, lines, files, deleted_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [f.id, f.uuid, f.issuer_name, f.issuer_rfc, f.series, f.folio, f.invoice_date, f.total, n.lines, n.files, req.user.id]);
            await client.query('DELETE FROM invoices WHERE id = $1', [id]);
            await client.query('COMMIT');
            res.status(204).end();
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* connection already dead */ }
            fail(req, res, err, 'Error removing the invoice');
        } finally {
            client.release();
        }
    });

    // What a person can change later: classify it, set the due date, mark it paid,
    // confirm the date. NOT the UUID or the total: if those were wrong, delete and
    // capture again with its source. Fixing a category marks it manual, and the
    // system never overwrites it.
    r.patch('/:id', async (req, res) => {
        const id = toInt(req.params.id);
        if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
        const b = req.body ?? {};
        const sets = [], values = [];
        const set = (col, v) => { values.push(v); sets.push(`${col} = $${values.length}`); };
        const corrected = {};
        const manual = value => ({ value, source: 'manual', reason: 'corrected by a person' });

        if ('purchase_type' in b) {
            if (!PURCHASE_TYPES.includes(b.purchase_type)) return res.status(400).json({ error: 'purchase_type is invalid' });
            set('purchase_type', b.purchase_type); corrected.purchase_type = manual(b.purchase_type);
        }
        if ('spend_category' in b) {
            const v = b.spend_category === null ? null : SPEND_CATEGORIES.includes(b.spend_category) ? b.spend_category : undefined;
            if (v === undefined) return res.status(400).json({ error: 'spend_category is invalid' });
            set('spend_category', v); corrected.spend_category = manual(v);
        }
        if ('project' in b) {
            const v = b.project === null ? null : str(b.project, 40);
            if (v === undefined) return res.status(400).json({ error: 'project is invalid' });
            set('project', v); corrected.project = manual(v);
        }
        for (const col of ['due_on', 'paid_at']) {
            if (col in b) {
                const v = b[col] === null ? null : isoDate(b[col]);
                if (v === undefined) return res.status(400).json({ error: `${col} must be YYYY-MM-DD` });
                set(col, v);
            }
        }
        if ('invoice_date' in b) {
            const v = isoDate(b.invoice_date);
            if (v === undefined) return res.status(400).json({ error: 'invoice_date must be YYYY-MM-DD' });
            set('invoice_date', v);
            // Fixing the date by hand means looking at it: it is confirmed.
            set('date_confirmed', true);
        }
        if ('note' in b) {
            const v = str(b.note, 1000);
            if (v === undefined) return res.status(400).json({ error: 'note is not valid' });
            set('note', v);
        }
        if ('supplier_id' in b) {
            const v = b.supplier_id === null ? null : toInt(b.supplier_id);
            if (v === undefined || (b.supplier_id !== null && v === null)) return res.status(400).json({ error: 'supplier_id is invalid' });
            set('supplier_id', v);
        }
        if (Object.keys(corrected).length) {
            values.push(JSON.stringify(corrected));
            sets.push(`classification = classification || $${values.length}::jsonb`);
        }
        if (sets.length === 0) return res.status(400).json({ error: 'Nothing to change' });

        values.push(id);
        try {
            const { rowCount } = await pool.query(`UPDATE invoices SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
            if (rowCount === 0) return res.status(404).json({ error: 'The invoice does not exist' });
            const { rows } = await pool.query(`SELECT ${COLUMNS} ${FROM_JOINS} WHERE f.id = $1`, [id]);
            res.json(rows[0]);
        } catch (err) {
            if (err.code === '23503') return res.status(400).json({ error: 'The supplier does not exist' });
            if (err.code === '23514') return res.status(400).json({ error: 'That change breaks the invoice rules' });
            fail(req, res, err, 'Error updating the invoice');
        }
    });

    require('./reconciliation')(r, pool);

    return r;
};

module.exports.buildInvoice = buildInvoice;
module.exports.realType = realType;
