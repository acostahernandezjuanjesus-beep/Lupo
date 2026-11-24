// Reads a photographed paper invoice with a vision model, one strip at a time.
//
// The client cuts the sheet into overlapping strips: the model only sees ~1,100
// tokens of image, and on a whole sheet it fills in what it cannot see.
// The UUID and seals are never requested (the model invented them even when
// told to say "unreadable"); they come from the XML or the QR.
// The overlap is a free check: a field two strips read the same is confirmed,
// one they read differently is null with the conflict shown.
// The result is a DRAFT for a person to confirm, the date above all (it
// misread 2025 for 2026 consistently).
// reasoning_effort stays 'low': off, it fabricated a coherent invoice; 'high'
// only doubles the cost. An empty reply with finish_reason 'length' is a valid
// "did not converge" outcome, not a network error.

const { amountText, RE_RFC } = require('./cfdi');

const API_URL = process.env.DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const TIMEOUT_MS = 120_000;
const PARALLEL = 3;

const PROMPT = `You transcribe Mexican CFDI invoices photographed on paper. The invoices are printed in Spanish. You receive ONE STRIP of the sheet, not the whole sheet. You do not interpret: you copy.

What you write goes into the accounting books without anyone checking it character by character. A null field makes a person type it: twenty seconds. An invented field enters as truth and nobody finds out until an account does not add up months later. Null is always better than almost.

FORBIDDEN:
- Completing a half-read string. The whole field is null.
- Producing a well-formed value when the area cannot be read.
- Filling in with patterns or characters that 'fit'.
- Calculating. Do not add lines or multiply: invoices contain roundings. Copy or null.
- Correcting or expanding what is written.
- Inventing what is outside the strip: if a value does not appear in this strip, it is null.

Do NOT transcribe the fiscal folio / UUID or the digital seals. That data arrives another way.

Return ONLY this JSON, without \`\`\` and without surrounding text. null for anything you do not read with certainty in this strip:
{"folio":,"issuer_name":,"issuer_rfc":,"invoice_date":,"subtotal":,"vat":,"total":,"pages":,"lines":[{"description":,"quantity":,"unit":,"unit_value":,"amount":}]}
Amounts: digits and decimal point only. invoice_date: YYYY-MM-DD. vat is the IVA tax amount. pages: the printed page indicator such as '1 de 2', or null.
lines: ONLY the rows of the concepts table that are fully visible in this strip; [] if there are none.`;

// ---- Normalize what the model said: anything malformed becomes null ----

const text = (v, max) => {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const t = String(v).trim();
    return t !== '' && t.length <= max ? t : null;
};

function isoDate(v) {
    const t = text(v, 10);
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const d = new Date(`${t}T12:00:00Z`);
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t ? t : null;
}

const amount = v => {
    const t = text(v, 20);
    return t === null ? null : amountText(t.replace(/[$,\s]/g, ''));
};

const quantity = v => {
    const t = text(v, 20)?.replace(/,/g, '') ?? null;
    return t !== null && /^\d{1,12}(\.\d{1,6})?$/.test(t) ? t : null;
};

/** One strip's raw reply, with every field shaped or null. */
function normalizeStrip(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const rfc = text(obj.issuer_rfc, 13)?.toUpperCase().replace(/\s/g, '') ?? null;
    const lines = (Array.isArray(obj.lines) ? obj.lines : []).slice(0, 60).map(p => ({
        description: text(p?.description, 500),
        quantity: quantity(p?.quantity),
        unit: text(p?.unit, 40),
        unit_value: quantity(p?.unit_value),
        amount: amount(p?.amount),
    })).filter(p => p.description !== null);
    return {
        folio: text(obj.folio, 40),
        issuer_name: text(obj.issuer_name, 200),
        issuer_rfc: rfc !== null && RE_RFC.test(rfc) ? rfc : null,
        invoice_date: isoDate(obj.invoice_date),
        subtotal: amount(obj.subtotal),
        vat: amount(obj.vat),
        total: amount(obj.total),
        pages: text(obj.pages, 10),
        lines,
    };
}

// ---- Merge the strips ----

const FIELDS = ['folio', 'issuer_name', 'issuer_rfc', 'invoice_date', 'subtotal', 'vat', 'total', 'pages'];

/**
 * Each field: { value, readings, agreement } or { value: null, conflict }.
 *   - no strip read it                 -> value null, 'none'
 *   - all readers agree                -> value; 'confirmed' with 2+ readings, 'single_reading' with 1
 *   - readers differ                   -> a value wins only with 2+ readings and a lead
 *                                         over the runner-up ('majority'); else null plus the conflict
 */
function mergeField(values) {
    const counts = new Map();
    for (const v of values) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
    if (counts.size === 0) return { value: null, readings: 0, agreement: 'none' };
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length === 1) return { value: ranked[0][0], readings: ranked[0][1], agreement: ranked[0][1] >= 2 ? 'confirmed' : 'single_reading' };
    if (ranked[0][1] >= 2 && ranked[0][1] > ranked[1][1]) return { value: ranked[0][0], readings: ranked[0][1], agreement: 'majority', others: ranked.slice(1).map(([value, count]) => ({ value, count })) };
    return { value: null, readings: 0, agreement: 'conflict', conflict: ranked.map(([value, count]) => ({ value, count })) };
}

const lineKey = p => `${(p.description ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18)}|${p.amount ?? ''}`;

/**
 * Lines from all strips, dropping the ones the overlap showed twice (same amount
 * and same start of description); the longest description wins. Two truly
 * identical rows would collapse into one, which is why this is only a draft.
 */
function mergeLines(readings) {
    const seen = new Map();
    for (const l of readings) for (const p of l.lines) {
        const k = lineKey(p);
        const prev = seen.get(k);
        if (!prev) seen.set(k, { ...p, strips: 1 });
        else {
            prev.strips++;
            if ((p.description?.length ?? 0) > (prev.description?.length ?? 0)) prev.description = p.description;
            for (const c of ['quantity', 'unit', 'unit_value']) prev[c] ??= p[c];
        }
    }
    return [...seen.values()];
}

/** Normalized readings (one per strip that answered) -> the invoice draft. */
function mergeStrips(readings) {
    const fields = {};
    for (const c of FIELDS) fields[c] = mergeField(readings.map(l => l[c]));
    return { fields, lines: mergeLines(readings) };
}

// ---- Call the model ----

/** The JSON the model said, even wrapped in ``` or text. */
function extractJson(content) {
    if (typeof content !== 'string') return null;
    const cleaned = content.replace(/```(?:json)?/gi, '').trim();
    const i = cleaned.indexOf('{'), j = cleaned.lastIndexOf('}');
    if (i === -1 || j <= i) return null;
    try { return JSON.parse(cleaned.slice(i, j + 1)); } catch { return null; }
}

/**
 * One strip (base64 JPEG) -> { status, reading, detail }.
 * status: 'ok' | 'no_converge' | 'bad_format' | 'error'. Never throws, so one
 * failed strip does not sink the others.
 */
async function readStrip(jpegBase64, { key, fetchFn = fetch } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
        const res = await fetchFn(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            signal: ctl.signal,
            body: JSON.stringify({
                model: MODEL,
                temperature: 0,
                max_tokens: 6000,
                reasoning_effort: 'low',
                messages: [
                    // System message on purpose: as a user message the model skipped the instructions.
                    { role: 'system', content: PROMPT },
                    { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }] },
                ],
            }),
        });
        if (!res.ok) return { status: 'error', detail: `HTTP ${res.status}` };
        const body = await res.json();
        const choice = body?.choices?.[0];
        const content = choice?.message?.content;
        if (!content || !content.trim()) return { status: 'no_converge', detail: choice?.finish_reason ?? null };
        const reading = normalizeStrip(extractJson(content));
        return reading ? { status: 'ok', reading } : { status: 'bad_format' };
    } catch (e) {
        return { status: 'error', detail: e.name === 'AbortError' ? 'timeout' : 'no connection' };
    } finally {
        clearTimeout(timer);
    }
}

/** All strips, PARALLEL at a time. Returns the draft and how many strips answered. */
async function readStrips(strips, options) {
    const results = new Array(strips.length);
    let next = 0;
    const worker = async () => {
        while (next < strips.length) {
            const i = next++;
            results[i] = await readStrip(strips[i], options);
        }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, strips.length) }, worker));
    const good = results.filter(r => r.status === 'ok').map(r => r.reading);
    const failures = {};
    for (const r of results) if (r.status !== 'ok') failures[r.status] = (failures[r.status] ?? 0) + 1;
    return { ...mergeStrips(good), strips: { total: strips.length, read: good.length, failures } };
}

module.exports = { readStrips, readStrip, mergeStrips, mergeField, mergeLines, normalizeStrip, extractJson, PROMPT, MODEL };
