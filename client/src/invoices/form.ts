import type { AiDraft, InvoiceForm } from './types'

export const EMPTY_FORM: InvoiceForm = {
    issuer_name: '', issuer_rfc: '', folio: '', invoice_date: '', date_ok: false,
    subtotal: '', vat: '', total: '', manual_uuid: '', lines: [],
}

/** The AI draft as form fields. A field that wasn't read stays empty, not invented. */
export function formFromDraft(b: AiDraft): InvoiceForm {
    const f = b.fields
    return {
        issuer_name: f.issuer_name.value ?? '', issuer_rfc: f.issuer_rfc.value ?? '', folio: f.folio.value ?? '',
        invoice_date: f.invoice_date.value ?? '', date_ok: false,
        subtotal: f.subtotal.value ?? '', vat: f.vat.value ?? '', total: f.total.value ?? '', manual_uuid: '',
        lines: b.lines.map(p => ({
            description: p.description, quantity: p.quantity ?? '', unit: p.unit ?? '',
            unit_value: p.unit_value ?? '', amount: p.amount ?? '',
        })),
    }
}
