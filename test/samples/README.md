# Sample invoices

**Everything here is fake.** They let you try the invoices module without a real supplier invoice
(which carries real RFCs and prices). The invoice content is in Spanish on purpose: it imitates Mexican CFDI invoices.

| File | What it is | Good for |
|---|---|---|
| `f1-steel.xml` / `.pdf` | raw material, on credit (PPD, 60 days), **2-page PDF** with the QR on the last page | XML, PDF, due date, project `OT-2215` in the lines |
| `f2-consumables.xml` / `.pdf` / `-photo.jpg` | consumables, paid up front (PUE), one page; the photo is crooked, shadowed and grainy | reading the QR from an image; the rounded-price case (`$0.258` printed as `$0.26`, amount `$25.80`) |
| `f3-gases.xml` | gases, paid up front, **XML only** | capture without a paper file |
| `generate.py` | produces them | regenerating them (`pip install qrcode reportlab pymupdf pillow numpy`) |

## Why they are fake, and how

- The RFCs are the test ones from the SAT documentation; none belongs to a real company or supplier.
- UUIDs, seals and certificates are made from a fixed seed: they do not exist at the SAT, so checking
  their status gives "No Encontrado".
- Suppliers, items and prices are fiction, shaped like what a metalworking shop buys. SAT product keys are illustrative.
- The Comprobante structure follows the public CFDI 4.0 example; the stamp is built here, because that example has none.
- Each PDF says so on the page: "documento ficticio sin valor fiscal".
