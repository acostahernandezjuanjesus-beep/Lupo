const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readQr, readXml, crossCheck, sameAmount, amountText } = require('../cfdi');

// All made up: fake RFCs and UUIDs. No real tax data lives in the repo.
const UUID = 'A1B2C3D4-0000-4000-8000-0123456789AB';
const QR = `https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?id=${UUID}&re=AAA010101AAA&rr=BBB020202BB1&tt=0000007161.640000&fe=abcd1234`;
const SEAL = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxxxxxxxxxxabcd1234';

const XML = `<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
  Version="4.0" Serie="A" Folio="1234" Fecha="2026-09-01T10:30:00" SubTotal="6173.83" Total="7161.64"
  Moneda="MXN" MetodoPago="PPD" FormaPago="99" TipoDeComprobante="I">
  <cfdi:Emisor Rfc="AAA010101AAA" Nombre="ACEROS &amp; PLASTICOS DEL NORTE"/>
  <cfdi:Receptor Rfc="BBB020202BB1" Nombre="TALLER DE PRUEBA" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="30102300" NoIdentificacion="TB-112" Cantidad="10" ClaveUnidad="MTR" Unidad="METRO LINEAL"
      Descripcion="TUBO INOX 1 1/2" ValorUnitario="410.25" Importe="4102.50"/>
    <cfdi:Concepto ClaveProdServ="30102300" Cantidad="3" ClaveUnidad="KGM" Unidad="KG"
      Descripcion="BARRA REDONDA" ValorUnitario="690.4" Importe="2071.33"/>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="987.81"/>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="${UUID.toLowerCase()}" FechaTimbrado="2026-09-01T10:31:02" SelloCFD="${SEAL}"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

test('QR: pulls UUID, RFCs, total and seal from the text, no network', () => {
    const r = readQr(QR);
    assert.equal(r.ok, true);
    assert.deepEqual(r.qr, { uuid: UUID, issuer_rfc: 'AAA010101AAA', receiver_rfc: 'BBB020202BB1', total: '7161.64', seal_tail: 'abcd1234' });
});
test('QR: accepts no https, lowercase, and any casing of the parameter names', () => {
    const loose = QR.replace('https://', '').replace('id=', 'ID=').replace(UUID, UUID.toLowerCase());
    assert.equal(readQr(loose).qr.uuid, UUID);
});
test('QR: what is not from an invoice is rejected with its reason', () => {
    for (const [text, error] of [
        ['', /empty/], ['hello world', /address|SAT/], [QR.replace('sat.gob.mx', 'sat.gob.mx.fake.com'), /SAT/],
        ['https://example.com/?id=' + UUID, /SAT/], [QR.replace(UUID, 'NOT-A-UUID'), /UUID/],
        [QR.replace('AAA010101AAA', 'XX'), /issuer/], [QR.replace('BBB020202BB1', 'xx'), /receiver/],
        [QR.replace('0000007161.640000', 'lots'), /total/],
    ]) {
        const r = readQr(text);
        assert.equal(r.ok, false, text); assert.match(r.error, error, text);
    }
});
test('QR: an old QR without fe is not rejected, it just has no seal', () => {
    const r = readQr(QR.replace('&fe=abcd1234', ''));
    assert.equal(r.ok, true); assert.equal(r.qr.seal_tail, null);
});

test('amounts: same value with different zeros and decimals; never Number', () => {
    assert.equal(sameAmount('0000007161.640000', '7161.64'), true);
    assert.equal(sameAmount('7161.64', '7161.65'), false);
    assert.equal(sameAmount('abc', '7161.64'), null);
    assert.equal(amountText('0000007161.640000'), '7161.64');
    // An amount Number would round wrong: 14 integer digits + 6 decimals.
    assert.equal(sameAmount('12345678901234.000001', '12345678901234.000002'), false);
});

test('XML: reads the header, the lines and the stamp as they come', () => {
    const r = readXml(XML);
    assert.equal(r.ok, true);
    const inv = r.invoice;
    assert.equal(inv.uuid, UUID, 'the UUID comes out uppercase even if the XML has it lowercase');
    assert.equal(inv.invoice_date, '2026-09-01');
    assert.equal(inv.stamped_at, '2026-09-01T10:31:02');
    assert.equal(inv.series, 'A'); assert.equal(inv.folio, '1234');
    assert.equal(inv.total, '7161.64'); assert.equal(inv.subtotal, '6173.83'); assert.equal(inv.vat, '987.81');
    assert.equal(inv.payment_method, 'PPD'); assert.equal(inv.cfdi_use, 'G03');
    assert.equal(inv.issuer_name, 'ACEROS & PLASTICOS DEL NORTE', 'decodes &amp;');
    assert.equal(inv.seal_tail, 'abcd1234');
    assert.equal(inv.lines.length, 2);
    assert.equal(inv.lines[0].unit, 'METRO LINEAL');
});
test('XML: the amount is the PRINTED one, not quantity x unit value', () => {
    const k = readXml(XML).invoice.lines[1];
    // 3 x 690.4 = 2071.20, but the invoice prints 2071.33: what is printed is stored.
    assert.equal(k.amount, '2071.33');
});
test('XML: what the invoice does not carry is null, not empty or zero', () => {
    const inv = readXml(XML).invoice;
    assert.equal(inv.discount, null);
    assert.equal(inv.lines[1].identification_no, null);
    assert.equal(inv.lines[1].discount, null);
});
test('XML: rejects what is not a stamped invoice', () => {
    for (const [xml, error] of [
        ['', /empty/], ['<a><b></a>', /Comprobante|valid/], ['<Other/>', /Comprobante/],
        [XML.replace(/<cfdi:Complemento>[\s\S]*<\/cfdi:Complemento>/, ''), /stamp/],
        [XML.replace(UUID.toLowerCase(), 'no-uuid'), /stamp|UUID/],
        [`<!DOCTYPE x [<!ENTITY a "b">]>` + XML, /definition/],
    ]) {
        const r = readXml(xml);
        assert.equal(r.ok, false, xml.slice(0, 40)); assert.match(r.error, error);
    }
});
test('XML: a file of megabytes is not an invoice', () => {
    assert.equal(readXml('<x>' + 'a'.repeat(2 * 1024 * 1024 + 10) + '</x>').ok, false);
});

test('crossCheck: XML and QR of the same sheet match; if they disagree, it says on what', () => {
    const inv = readXml(XML).invoice, q = readQr(QR).qr;
    assert.deepEqual(crossCheck(inv, q), []);
    assert.deepEqual(crossCheck(inv, { ...q, total: '7161.65' }), ['total']);
    assert.deepEqual(crossCheck(inv, { ...q, uuid: 'B1B2C3D4-0000-4000-8000-0123456789AB', seal_tail: 'zzzz0000' }), ['uuid', 'seal']);
    assert.deepEqual(crossCheck({ ...inv, total: null }, q), [], 'what one source lacks is not a discrepancy');
});
