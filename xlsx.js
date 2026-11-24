// Minimal read-only .xlsx reader with no new dependencies: an .xlsx is a zip of XML, so node:zlib opens the zip
// and fast-xml-parser (same safe options as cfdi.js) opens the XML. A spreadsheet library would be more attack
// surface for reading text, numbers and dates.
//
//   readXlsx(buffer) -> { sheets: [{ name, rows: [[value|null, ...] | null, ...] }] }
//   rows[i] is Excel row i+1 (null if empty); value is string, number, boolean, Date (UTC, only when the cell
//   format is a date) or null. Formulas return the value Excel stored.
//   Anything that isn't an xlsx, or is too big, throws XlsxError with a message that can be shown to the user.

const zlib = require('node:zlib');
const { XMLParser } = require('fast-xml-parser');

class XlsxError extends Error {
    constructor(message) { super(message); this.name = 'XlsxError'; }
}

// a purchase book is hundreds of KB; a zip inflating to tens of MB is trying to exhaust memory
const MAX_ENTRIES = 400;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_SHEETS = 40;
const MAX_ROWS = 20000;

/** { read(name) -> Buffer | null }: nothing is extracted until asked. */
function openZip(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new XlsxError('The file is empty or not an .xlsx');
    // end of central directory, searched from the end (may carry a comment up to 64 KB)
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new XlsxError('The file is not a valid .xlsx (its contents could not be read)');
    const entries = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new XlsxError('This .xlsx uses a zip format that is not supported. Save it again from Excel.');
    }
    if (entries > MAX_ENTRIES) throw new XlsxError('The file has too many parts to be a purchase book');
    if (cdOffset + cdSize > buf.length) throw new XlsxError('The file is damaged (was it cut off while copying?)');

    const index = new Map();
    let p = cdOffset;
    for (let n = 0; n < entries; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('The file is damaged');
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const realSize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        index.set(name, { method, compSize, realSize, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }

    let inflated = 0;
    const read = name => {
        const e = index.get(name);
        if (!e) return null;
        if (e.realSize > MAX_ENTRY_BYTES) throw new XlsxError('The file is too big to be a purchase book');
        const o = e.localOffset;
        if (o + 30 > buf.length || buf.readUInt32LE(o) !== 0x04034b50) throw new XlsxError('The file is damaged');
        const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
        if (start + e.compSize > buf.length) throw new XlsxError('The file is damaged (was it cut off while copying?)');
        const data = buf.subarray(start, start + e.compSize);
        let out;
        if (e.method === 0) out = data;
        else if (e.method === 8) {
            try { out = zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }); }
            catch { throw new XlsxError('The file is damaged or too big'); }
        } else throw new XlsxError('This .xlsx uses a compression that is not supported. Save it again from Excel.');
        inflated += out.length;
        if (inflated > MAX_TOTAL_BYTES) throw new XlsxError('The file is too big to be a purchase book');
        return out;
    };
    return { read, names: [...index.keys()] };
}

// no entities (door for expansion attacks): the 5 basic ones and numeric references are decoded by hand
const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true,
    processEntities: false, parseAttributeValue: false, parseTagValue: false, trimValues: false,
    // always arrays, so a one-row sheet doesn't change shape
    isArray: name => ['row', 'c', 'si', 'r', 'sheet', 'Relationship', 'xf', 'numFmt'].includes(name),
});

const decode = s => String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const toList = x => x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];

/** Text of a <t> node: string, or { '#text', '@_xml:space' }. */
const textOf = t => {
    if (t === undefined || t === null) return '';
    if (typeof t === 'object') return t['#text'] === undefined ? '' : decode(t['#text']);
    return decode(t);
};

function parseXml(buf, what) {
    try { return parser.parse(buf.toString('utf8')); }
    catch { throw new XlsxError(`The file is damaged (${what})`); }
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
/** Is the custom format a date or time? Ignores quoted text and colors. */
const isDateFormat = code => {
    const c = String(code).toLowerCase().replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[dmyhs]/.test(c) && !/^[#0.,%?\s]+$/.test(c);
};
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const toDate = days => new Date(EXCEL_EPOCH + Math.round(days * 86400000));

/** 'C9' -> 2 (column, 0-based). */
const columnOf = ref => {
    let n = 0;
    for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
};

function readXlsx(buffer) {
    const zip = openZip(buffer);
    const required = name => {
        const b = zip.read(name);
        if (!b) throw new XlsxError('The file is not an Excel workbook (.xlsx)');
        return b;
    };

    const workbook = parseXml(required('xl/workbook.xml'), 'workbook');
    const rels = parseXml(required('xl/_rels/workbook.xml.rels'), 'relationships');
    const targets = new Map(toList(rels.Relationships?.Relationship).map(r => [r['@_Id'], r['@_Target']]));

    // each <si> is one text, or several <r> (mixed formatting) joined
    const strings = [];
    const sharedBuf = zip.read('xl/sharedStrings.xml');
    if (sharedBuf) {
        for (const si of toList(parseXml(sharedBuf, 'strings').sst?.si)) {
            strings.push(si.t !== undefined ? textOf(si.t) : toList(si.r).map(r => textOf(r.t)).join(''));
        }
    }

    const isDate = [];
    const stylesBuf = zip.read('xl/styles.xml');
    if (stylesBuf) {
        const st = parseXml(stylesBuf, 'styles').styleSheet;
        const custom = new Map(toList(st?.numFmts?.numFmt).map(f => [Number(f['@_numFmtId']), f['@_formatCode']]));
        for (const xf of toList(st?.cellXfs?.xf)) {
            const id = Number(xf['@_numFmtId'] ?? 0);
            isDate.push(BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(decode(custom.get(id)))));
        }
    }

    const sheetsXml = toList(workbook.workbook?.sheets?.sheet);
    if (sheetsXml.length === 0) throw new XlsxError('The workbook has no sheets');
    if (sheetsXml.length > MAX_SHEETS) throw new XlsxError('The workbook has too many sheets');

    const sheets = [];
    for (const sh of sheetsXml) {
        const target = targets.get(sh['@_id']);
        if (!target) throw new XlsxError('The file is damaged (a sheet has no content)');
        const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
        const sheet = parseXml(required(path), 'sheet').worksheet;
        const rows = [];
        for (const row of toList(sheet?.sheetData?.row)) {
            const n = Number(row['@_r']);
            if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) throw new XlsxError('The sheet has too many rows');
            const cells = [];
            for (const c of toList(row.c)) {
                const type = c['@_t'];
                const style = Number(c['@_s'] ?? 0);
                let value;
                if (type === 'inlineStr') value = c.is?.t !== undefined ? textOf(c.is.t) : toList(c.is?.r).map(r => textOf(r.t)).join('');
                else if (c.v === undefined || c.v === null || c.v === '') continue;
                else if (type === 's') value = strings[Number(c.v)] ?? null;
                else if (type === 'str' || type === 'e') value = decode(c.v);
                else if (type === 'b') value = String(c.v) === '1';
                else {
                    const num = Number(c.v);
                    if (!Number.isFinite(num)) continue;
                    value = isDate[style] ? toDate(num) : num;
                }
                cells[columnOf(c['@_r'] ?? 'A1')] = value;
            }
            if (cells.some(v => v !== undefined)) {
                rows[n - 1] = Array.from(cells, v => v === undefined ? null : v);
            }
        }
        sheets.push({ name: decode(sh['@_name'] ?? ''), rows: Array.from(rows, r => r ?? null) });
    }
    return { sheets };
}

module.exports = { readXlsx, XlsxError };
