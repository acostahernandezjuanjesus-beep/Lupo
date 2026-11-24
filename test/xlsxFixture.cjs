const zlib = require('node:zlib');

// Builds .xlsx files with the same zip + XML layout Excel writes. All data is made up.

function zip(files) {
    const parts = [], central = [];
    let off = 0, n = 0;
    for (const [name, content] of Object.entries(files)) {
        const data = Buffer.from(content), packed = zlib.deflateRawSync(data), crc = zlib.crc32(data) >>> 0, nameBuf = Buffer.from(name);
        const loc = Buffer.alloc(30);
        loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(8, 8);
        loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(packed.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(nameBuf.length, 26);
        parts.push(loc, nameBuf, packed);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 10);
        cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(packed.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
        cen.writeUInt32LE(off, 42);
        central.push(cen, nameBuf);
        off += 30 + nameBuf.length + packed.length; n++;
    }
    const cd = Buffer.concat(central), fin = Buffer.alloc(22);
    fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(n, 8); fin.writeUInt16LE(n, 10); fin.writeUInt32LE(cd.length, 12); fin.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cd, fin]);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colLetter = i => String.fromCharCode(65 + i);
const SERIAL_BASE = Date.UTC(1899, 11, 30);

/** sheets: [{ name, rows: [[cell, ...] | null] }]. A cell is a string, number, Date, boolean, null, `{ f, v }` (formula) or `{ inline }`. */
function xlsx(sheets) {
    const strings = [], idx = new Map();
    const shared = t => { if (!idx.has(t)) { idx.set(t, strings.length); strings.push(t); } return idx.get(t); };
    const files = {
        'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
            sheets.map((h, i) => `<sheet name="${esc(h.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
        'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
            sheets.map((h, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
        'xl/styles.xml': '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    };
    sheets.forEach((h, i) => {
        const rows = h.rows.map((f, r) => {
            if (!f) return '';
            const cells = f.map((v, c) => {
                const ref = `${colLetter(c)}${r + 1}`;
                if (v === null || v === undefined) return '';
                if (v instanceof Date) return `<c r="${ref}" s="${c % 2 === 0 ? 1 : 2}"><v>${(v.getTime() - SERIAL_BASE) / 86400000}</v></c>`;
                if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
                if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
                if (v && typeof v === 'object' && 'f' in v) return `<c r="${ref}"><f>${esc(v.f)}</f><v>${v.v}</v></c>`;
                if (v && typeof v === 'object' && 'inline' in v) return `<c r="${ref}" t="inlineStr"><is><t>${esc(v.inline)}</t></is></c>`;
                return `<c r="${ref}" t="s"><v>${shared(v)}</v></c>`;
            }).join('');
            return `<row r="${r + 1}">${cells}</row>`;
        }).join('');
        files[`xl/worksheets/sheet${i + 1}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
    });
    files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${
        strings.map(t => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('')}</sst>`;
    return zip(files);
}
const F = (y, m, d) => new Date(Date.UTC(y, m - 1, d));

const HEADER = ['FECHA', 'N° FOLIO/REMISION', 'MATERIAL', 'CANTIDAD', 'PRECIO', 'SUBTOTAL', 'SUBTOTAL', 'TOTAL', 'O.C./QUIEN SOLICITO?', 'PROVEEDOR', 'COMENTARIO'];
// Same layout as the real books: title, header on row 8, purchase blocks below.
const sheetOf = (name, blocks) => ({ name, rows: [['REPORTE SEMANAL DE GASTOS'], null, null, null, null, ['PERIODO'], ['RESUMEN'], HEADER, ...blocks] });

module.exports = { zip, xlsx, F, HEADER, sheetOf };
