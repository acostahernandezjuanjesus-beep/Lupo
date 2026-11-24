"""
Generates the FAKE sample invoices in this folder (XML, PDF with QR and a "photo").

Everything is made up:
  - The RFCs are the test ones from the SAT documentation; none belongs to a real
    company or supplier.
  - UUIDs, seals and certificates come from a fixed seed: they do not exist at the
    SAT, so a status check answers "No Encontrado".
  - Suppliers, items and prices are fiction, shaped like what a metalworking shop
    buys (raw material, consumables, gases). The invoice text is Spanish on purpose.

The structure follows a stamped CFDI 4.0 (the public example for the Comprobante;
the stamp is built here, because that example has none).

Usage (from the repo root, after `pip install qrcode reportlab pymupdf pillow numpy`):
    python test/samples/generate.py
"""
import base64
import io
import os
import random
from decimal import Decimal, ROUND_HALF_UP
from xml.sax.saxutils import quoteattr

import fitz  # pymupdf
import numpy as np
import qrcode
from PIL import Image, ImageFilter
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import cm
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

HERE = os.path.dirname(os.path.abspath(__file__))
RND = random.Random(20260930)          # fixed seed: same UUIDs every time
D = lambda x: Decimal(str(x))
c2 = lambda x: D(x).quantize(Decimal('0.01'), ROUND_HALF_UP)

RECEIVER = dict(rfc='CACX7605101P8', name='TALLER METALMECANICO DE PRUEBA SA DE CV', use='G03', zip='27000', regime='601')

INVOICES = [
    dict(key='f1-steel', series='A', folio='1187', date='2026-09-14T10:32:00', method='PPD', terms='Credito a 60 dias', pages=2,
         issuer=dict(rfc='EKU9003173C9', name='ACEROS Y PLASTICOS DEL NORTE (PRUEBA) SA DE CV'),
         lines=[
             ('11101700', 'TUBO INOXIDABLE 304 2 1/2" CED 10 PARA OT-2215', '6', 'MTR', 'METRO LINEAL', '1485.50'),
             ('11101700', 'BARRA REDONDA INOXIDABLE 304 1 1/4" OT-2215', '12', 'KGM', 'KG', '118.40'),
             ('13102000', 'REDONDO DE NYLON 3" X 50 CM', '2', 'H87', 'PIEZA', '842.15'),
         ]),
    dict(key='f2-consumables', series='FC', folio='90412', date='2026-09-22T16:05:00', method='PUE', terms=None, pages=1,
         issuer=dict(rfc='URE180429TM6', name='SOLDADURAS Y CONSUMIBLES DE LA LAGUNA (PRUEBA)'),
         lines=[
             ('23171500', 'MICROALAMBRE ER70S-6 0.035 CARRETE 15 KG', '4', 'H87', 'PIEZA', '1390.00'),
             ('23171500', 'ELECTRODO E6010 3/32 CAJA 5 KG', '6', 'H87', 'CAJA', '412.75'),
             ('27112000', 'DISCO DE CORTE 7" X 1/16" PARA METAL', '50', 'H87', 'PIEZA', '36.40'),
             ('31161500', 'TAQUETE DE PLASTICO 1/4"', '100', 'H87', 'PIEZA', '0.258'),
         ]),
    dict(key='f3-gases', series='G', folio='5530', date='2026-09-25T09:10:00', method='PUE', terms=None, pages=0,   # 0 = XML only
         issuer=dict(rfc='IIA040805DZ4', name='GASES INDUSTRIALES DE TORREON (PRUEBA)'),
         lines=[
             ('12141500', 'RECARGA DE GAS OXIGENO INDUSTRIAL 9.5 M3', '8', 'H87', 'CILINDRO', '395.68'),
             ('12141500', 'RECARGA DE GAS ARGON INDUSTRIAL 9.5 M3', '4', 'H87', 'CILINDRO', '1428.13'),
         ]),
]

def random_b64(n):
    return base64.b64encode(RND.randbytes(n)).decode()

def fake_uuid():
    h = RND.randbytes(16).hex().upper()
    return f'{h[:8]}-{h[8:12]}-4{h[13:16]}-8{h[17:20]}-{h[20:32]}'

def compute(f):
    parts, sub = [], D(0)
    for key, desc, qty, unit_key, unit, unit_value in f['lines']:
        amount = c2(D(qty) * D(unit_value))                    # the PRINTED amount: rounded per line
        parts.append(dict(key=key, desc=desc, qty=qty, unit_key=unit_key, unit=unit, unit_value=unit_value, amount=amount))
        sub += amount
    vat = c2(sub * D('0.16'))
    f.update(parts=parts, subtotal=sub, vat=vat, total=sub + vat,
             uuid=fake_uuid(), seal=random_b64(256), sat_seal=random_b64(256))
    # Stamp time: one minute after the invoice.
    f['stamped'] = f['date'][:14] + f"{int(f['date'][14:16]) + 1:02d}" + f['date'][16:]

def xml(f):
    e = f['issuer']
    concepts = ''.join(
        f'<cfdi:Concepto ClaveProdServ="{p["key"]}" Cantidad="{p["qty"]}" ClaveUnidad="{p["unit_key"]}" Unidad={quoteattr(p["unit"])} '
        f'Descripcion={quoteattr(p["desc"])} ValorUnitario="{p["unit_value"]}" Importe="{p["amount"]}" ObjetoImp="02">'
        f'<cfdi:Impuestos><cfdi:Traslados><cfdi:Traslado Base="{p["amount"]}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="{c2(p["amount"] * D("0.16"))}"/>'
        f'</cfdi:Traslados></cfdi:Impuestos></cfdi:Concepto>' for p in f['parts'])
    terms = f' CondicionesDePago={quoteattr(f["terms"])}' if f['terms'] else ''
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:schemaLocation="http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd" '
        f'Version="4.0" Serie="{f["series"]}" Folio="{f["folio"]}" Fecha="{f["date"]}" Sello="{f["seal"]}" FormaPago="99" '
        f'NoCertificado="30001000000400002434" Certificado="{random_b64(120)}"{terms} SubTotal="{f["subtotal"]}" Moneda="MXN" '
        f'Total="{f["total"]}" TipoDeComprobante="I" MetodoPago="{f["method"]}" LugarExpedicion="27000" Exportacion="01">'
        f'<cfdi:Emisor Rfc="{e["rfc"]}" Nombre={quoteattr(e["name"])} RegimenFiscal="601"/>'
        f'<cfdi:Receptor Rfc="{RECEIVER["rfc"]}" Nombre={quoteattr(RECEIVER["name"])} UsoCFDI="{RECEIVER["use"]}" '
        f'DomicilioFiscalReceptor="{RECEIVER["zip"]}" RegimenFiscalReceptor="{RECEIVER["regime"]}"/>'
        f'<cfdi:Conceptos>{concepts}</cfdi:Conceptos>'
        f'<cfdi:Impuestos TotalImpuestosTrasladados="{f["vat"]}"><cfdi:Traslados>'
        f'<cfdi:Traslado Base="{f["subtotal"]}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="{f["vat"]}"/></cfdi:Traslados></cfdi:Impuestos>'
        '<cfdi:Complemento>'
        '<tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" '
        'xsi:schemaLocation="http://www.sat.gob.mx/TimbreFiscalDigital http://www.sat.gob.mx/sitio_internet/cfd/TimbreFiscalDigital/TimbreFiscalDigitalv11.xsd" '
        f'Version="1.1" UUID="{f["uuid"]}" FechaTimbrado="{f["stamped"]}" RfcProvCertif="AAA010101AAA" SelloCFD="{f["seal"]}" '
        f'NoCertificadoSAT="30001000000500003456" SelloSAT="{f["sat_seal"]}"/>'
        '</cfdi:Complemento></cfdi:Comprobante>\n')

def qr_url(f):
    tt = f'{f["total"]:017.6f}'          # 10 integer digits and 6 decimals, as the SAT prints it
    return ('https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx?'
            f'id={f["uuid"]}&re={f["issuer"]["rfc"]}&rr={RECEIVER["rfc"]}&tt={tt}&fe={f["seal"][-8:]}')

def money(x):
    return f'${x:,.2f}'

def pdf(f, path):
    e = f['issuer']
    c = canvas.Canvas(path, pagesize=letter)
    W, H = letter
    qr = qrcode.make(qr_url(f), box_size=6, border=2)
    buf = io.BytesIO(); qr.save(buf, format='PNG'); buf.seek(0)
    parts = f['parts']
    # With 2 pages: the first holds the lines, the last has the totals and the QR.
    pages = [parts[:2], parts[2:]] if f['pages'] == 2 else [parts]

    def header(n):
        c.setFont('Helvetica-Bold', 13); c.drawString(2 * cm, H - 2 * cm, e['name'])
        c.setFont('Helvetica', 9)
        c.drawString(2 * cm, H - 2.6 * cm, f'RFC: {e["rfc"]}   Regimen fiscal: 601 General de Ley Personas Morales')
        c.drawString(2 * cm, H - 3.1 * cm, 'FACTURA DE PRUEBA - DOCUMENTO FICTICIO SIN VALOR FISCAL')
        c.setFont('Helvetica-Bold', 11); c.drawRightString(W - 2 * cm, H - 2 * cm, f'FACTURA {f["series"]}-{f["folio"]}')
        c.setFont('Helvetica', 9)
        c.drawRightString(W - 2 * cm, H - 2.6 * cm, f'Fecha de emision: {f["date"].replace("T", " ")}')
        c.drawRightString(W - 2 * cm, H - 3.1 * cm, f'Pagina {n} de {len(pages)}')
        c.line(2 * cm, H - 3.5 * cm, W - 2 * cm, H - 3.5 * cm)
        c.setFont('Helvetica-Bold', 9); c.drawString(2 * cm, H - 4.1 * cm, 'CLIENTE')
        c.setFont('Helvetica', 9)
        c.drawString(2 * cm, H - 4.6 * cm, f'{RECEIVER["name"]}   RFC: {RECEIVER["rfc"]}   Uso CFDI: {RECEIVER["use"]}')
        c.drawString(2 * cm, H - 5.1 * cm, f'Metodo de pago: {f["method"]}   Forma de pago: 99 Por definir   Moneda: MXN'
                     + (f'   Condiciones: {f["terms"]}' if f['terms'] else ''))

    def table(rows, y):
        c.setFont('Helvetica-Bold', 8)
        for x, t in ((2, 'CANT'), (3.4, 'UNIDAD'), (6, 'DESCRIPCION'), (15, 'P. UNIT'), (17.4, 'IMPORTE')):
            c.drawString(x * cm, y, t)
        c.line(2 * cm, y - 0.15 * cm, W - 2 * cm, y - 0.15 * cm)
        c.setFont('Helvetica', 8); y -= 0.7 * cm
        for p in rows:
            c.drawString(2 * cm, y, p['qty']); c.drawString(3.4 * cm, y, p['unit']); c.drawString(6 * cm, y, p['desc'][:62])
            c.drawRightString(16.6 * cm, y, money(D(p['unit_value']))); c.drawRightString(W - 2 * cm, y, money(p['amount']))
            y -= 0.7 * cm
        return y

    for n, rows in enumerate(pages, 1):
        header(n)
        y = table(rows, H - 6.2 * cm)
        if n == len(pages):
            y -= 0.6 * cm
            c.setFont('Helvetica', 9)
            c.drawRightString(W - 2 * cm, y, f'Subtotal: {money(f["subtotal"])}')
            c.drawRightString(W - 2 * cm, y - 0.5 * cm, f'IVA 16%: {money(f["vat"])}')
            c.setFont('Helvetica-Bold', 10)
            c.drawRightString(W - 2 * cm, y - 1.1 * cm, f'TOTAL: {money(f["total"])}')
            base = y - 2.2 * cm
            c.drawImage(ImageReader(buf), 2 * cm, base - 3.6 * cm, 3.6 * cm, 3.6 * cm)
            c.setFont('Helvetica', 6.5)
            c.drawString(6.2 * cm, base - 0.4 * cm, f'Folio fiscal (UUID): {f["uuid"]}')
            c.drawString(6.2 * cm, base - 0.9 * cm, f'Fecha y hora de certificacion: {f["stamped"]}')
            c.drawString(6.2 * cm, base - 1.4 * cm, 'Sello digital del CFDI:')
            for i in range(0, 200, 100):
                c.drawString(6.2 * cm, base - (1.8 + i / 100 * 0.4) * cm, f['seal'][i:i + 100])
            c.drawString(2 * cm, base - 4.3 * cm, 'Este documento es una representacion impresa de un CFDI ficticio, generado para probar el sistema.')
        c.showPage()
    c.save()

def photo(pdf_path, jpg_path):
    """A 'photo' of the last page: slightly crooked, shadowed and grainy, like a phone shot."""
    page = fitz.open(pdf_path)[-1]
    pix = page.get_pixmap(dpi=170)
    img = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
    backdrop = Image.new('RGB', (img.width + 160, img.height + 160), (74, 70, 66))       # a table
    backdrop.paste(img, (80, 80))
    backdrop = backdrop.rotate(1.6, resample=Image.BICUBIC, expand=True, fillcolor=(74, 70, 66))
    a = np.asarray(backdrop).astype(np.float32)
    h, w = a.shape[:2]
    shadow = np.linspace(1.0, 0.82, w)[None, :, None]                                    # light falling off to one side
    a = a * shadow + np.random.default_rng(7).normal(0, 6, a.shape)                      # grain
    backdrop = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
    backdrop.save(jpg_path, quality=82)

def main():
    for f in INVOICES:
        compute(f)
        path = lambda ext: os.path.join(HERE, f'{f["key"]}.{ext}')
        open(path('xml'), 'w', encoding='utf-8', newline='\n').write(xml(f))
        if f['pages']:
            pdf(f, path('pdf'))
        if f['key'] == 'f2-consumables':
            photo(path('pdf'), os.path.join(HERE, f'{f["key"]}-photo.jpg'))
        print(f'{f["key"]}: {f["uuid"]}  total {f["total"]}  {f["method"]}')

if __name__ == '__main__':
    main()
