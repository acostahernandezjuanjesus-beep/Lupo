// Reads a CFDI 4.0 invoice without AI, from the XML or from the printed SAT QR.
// Everything here is a copy of what the invoice says, never a reading, which is
// why the UUID can only come from these two sources.
//
// Amounts travel as TEXT (they are numeric in the database) and are never
// recomputed: printed line amounts can differ by a cent from quantity x price.
// A field the invoice lacks is null, not "" or 0.

const { XMLParser } = require('fast-xml-parser');

const SAT_HOST = 'verificacfdi.facturaelectronica.sat.gob.mx';

// 8-4-4-4-12 hex, uppercase as the SAT prints it.
const RE_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
// RFC of a company (12) or a person (13); also matches the generic XAXX/XEXX.
const RE_RFC = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const RE_AMOUNT = /^[0-9]{1,14}(\.[0-9]{1,6})?$/;

// A normal CFDI is tens of KB; megabytes of XML is a memory attack.
const MAX_XML_BYTES = 2 * 1024 * 1024;

/** Trimmed string, or null if it is not text or is empty. */
const clean = v => (typeof v === 'string' && v.trim() !== '') ? v.trim() : null;

// ---- Amounts: compare without Number ----

/** "0000007161.640000", "7161.64" and "7161.6400" are the same amount. BigInt millionths, or null. */
function toMillionths(text) {
    const t = clean(typeof text === 'number' ? String(text) : text);
    if (t === null || !RE_AMOUNT.test(t)) return null;
    const [whole, fraction = ''] = t.split('.');
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
}

/** Are two text amounts equal? null if either is not an amount. */
function sameAmount(a, b) {
    const x = toMillionths(a), y = toMillionths(b);
    return x === null || y === null ? null : x === y;
}

/** Amount as text rounded to two decimals ("7161.64"), or null. */
function amountText(text) {
    const m = toMillionths(text);
    if (m === null) return null;
    const cents = (m + 5_000n) / 10_000n;
    return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

// ---- 1. The QR ----

/**
 * The QR holds a SAT verification URL: id = UUID, re = issuer RFC, rr = receiver
 * RFC, tt = total, fe = last 8 chars of the seal. The URL is never fetched:
 * the data comes from the string, and the SAT page has a CAPTCHA anyway.
 * Returns { ok: true, qr } or { ok: false, error }.
 */
function readQr(text) {
    const raw = clean(text);
    if (raw === null) return { ok: false, error: 'The QR is empty' };
    if (raw.length > 2048) return { ok: false, error: 'The QR is too long to be from a CFDI' };

    let url;
    try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
        return { ok: false, error: 'The QR is not an address' };
    }
    if (url.hostname.toLowerCase() !== SAT_HOST) {
        return { ok: false, error: 'The QR is not from an electronic invoice (it does not point to the SAT)' };
    }

    // Printers disagree on parameter name casing.
    const p = {};
    for (const [k, v] of url.searchParams) p[k.toLowerCase()] = v.trim();

    const uuid = (p.id ?? '').toUpperCase();
    if (!RE_UUID.test(uuid)) return { ok: false, error: 'The QR fiscal folio is not shaped like a UUID' };

    const re = (p.re ?? '').toUpperCase(), rr = (p.rr ?? '').toUpperCase();
    if (!RE_RFC.test(re)) return { ok: false, error: 'The issuer RFC in the QR is not valid' };
    if (!RE_RFC.test(rr)) return { ok: false, error: 'The receiver RFC in the QR is not valid' };

    const total = amountText(p.tt);
    if (total === null) return { ok: false, error: 'The total in the QR is not an amount' };

    // Old QRs may lack fe; that is no reason to reject the rest.
    const fe = p.fe && p.fe.length >= 1 && p.fe.length <= 12 ? p.fe : null;

    return { ok: true, qr: { uuid, issuer_rfc: re, receiver_rfc: rr, total, seal_tail: fe } };
}

// ---- 2. The XML ----

const decode = s => s === null ? null : s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,           // cfdi:Comprobante -> Comprobante
    // No entities: a CFDI never uses them and processing them invites expansion
    // attacks. The 5 basic ones are decoded by hand above.
    processEntities: false,
    parseAttributeValue: false,     // everything stays text so amounts skip Number
    parseTagValue: false,
    trimValues: true,
});

const toArray = x => x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
const attr = (node, name) => node && typeof node === 'object' ? decode(clean(node[`@_${name}`])) : null;

/**
 * Reads a CFDI 4.0 (or 3.3) XML. Returns { ok: true, invoice } or { ok: false, error }.
 * The invoice has only what the XML says; nothing is derived.
 */
function readXml(xml) {
    if (typeof xml !== 'string' || xml.trim() === '') return { ok: false, error: 'The XML is empty' };
    if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) return { ok: false, error: 'The file is too large to be an invoice' };
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { ok: false, error: 'The XML has a definition that an invoice does not use' };

    let root;
    try {
        root = parser.parse(xml);
    } catch {
        return { ok: false, error: 'The file is not valid XML' };
    }
    const c = root?.Comprobante;
    if (!c || typeof c !== 'object') return { ok: false, error: 'Not a CFDI: the Comprobante node is missing' };

    const stamp = toArray(c.Complemento).flatMap(x => toArray(x?.TimbreFiscalDigital))[0] ?? null;
    const uuid = (attr(stamp, 'UUID') ?? '').toUpperCase();
    if (!RE_UUID.test(uuid)) return { ok: false, error: 'The invoice has no fiscal stamp (UUID): it is not stamped' };

    const issuer = c.Emisor, receiver = c.Receptor;
    const issuerRfc = (attr(issuer, 'Rfc') ?? '').toUpperCase();
    const receiverRfc = (attr(receiver, 'Rfc') ?? '').toUpperCase();

    const lines = toArray(c.Conceptos?.Concepto).map((k, i) => ({
        sort_order: i + 1,
        prod_serv_key: attr(k, 'ClaveProdServ'),
        identification_no: attr(k, 'NoIdentificacion'),
        description: attr(k, 'Descripcion'),
        quantity: attr(k, 'Cantidad'),
        unit_key: attr(k, 'ClaveUnidad'),
        unit: attr(k, 'Unidad'),
        unit_value: attr(k, 'ValorUnitario'),
        // The PRINTED amount, not quantity x unit value (rounding differs).
        amount: attr(k, 'Importe'),
        discount: attr(k, 'Descuento'),
    }));

    const seal = attr(stamp, 'SelloCFD');
    return {
        ok: true,
        invoice: {
            version: attr(c, 'Version'),
            voucher_type: attr(c, 'TipoDeComprobante'),
            series: attr(c, 'Serie'),
            folio: attr(c, 'Folio'),
            invoice_date: (attr(c, 'Fecha') ?? '').slice(0, 10) || null,   // YYYY-MM-DD; the time is in datetime
            datetime: attr(c, 'Fecha'),
            stamped_at: attr(stamp, 'FechaTimbrado'),
            uuid,
            seal_tail: seal ? seal.slice(-8) : null,
            issuer_rfc: RE_RFC.test(issuerRfc) ? issuerRfc : null,
            issuer_name: attr(issuer, 'Nombre'),
            receiver_rfc: RE_RFC.test(receiverRfc) ? receiverRfc : null,
            receiver_name: attr(receiver, 'Nombre'),
            cfdi_use: attr(receiver, 'UsoCFDI'),
            subtotal: attr(c, 'SubTotal'),
            discount: attr(c, 'Descuento'),
            vat: attr(c.Impuestos, 'TotalImpuestosTrasladados'),
            total: attr(c, 'Total'),
            currency: attr(c, 'Moneda'),
            payment_method: attr(c, 'MetodoPago'),     // PUE (paid at once) | PPD (credit)
            payment_form: attr(c, 'FormaPago'),
            lines,
        },
    };
}

// ---- 3. Cross-check ----

/**
 * Compares the XML against the QR of the SAME sheet. If they disagree they are
 * not the same invoice. Returns the mismatching field names (empty = they match);
 * a value missing on one side is not a mismatch.
 */
function crossCheck(invoice, qr) {
    const d = [];
    if (invoice.uuid && qr.uuid && invoice.uuid !== qr.uuid) d.push('uuid');
    if (invoice.issuer_rfc && qr.issuer_rfc && invoice.issuer_rfc !== qr.issuer_rfc) d.push('issuer_rfc');
    if (invoice.receiver_rfc && qr.receiver_rfc && invoice.receiver_rfc !== qr.receiver_rfc) d.push('receiver_rfc');
    if (sameAmount(invoice.total, qr.total) === false) d.push('total');
    if (invoice.seal_tail && qr.seal_tail && invoice.seal_tail !== qr.seal_tail) d.push('seal');
    return d;
}

module.exports = {
    readQr, readXml, crossCheck,
    sameAmount, amountText, toMillionths,
    RE_UUID, RE_RFC, SAT_HOST, MAX_XML_BYTES,
};
