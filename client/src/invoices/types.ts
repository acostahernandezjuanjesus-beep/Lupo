// What /api/invoices returns. Amounts travel as text (numeric in the database) and are never
// converted to Number: they're shown with `money()`, which uses BigInt.

export type PurchaseType = 'stock' | 'direct_to_job' | 'unclassified'

export type AutoLabel = { value: string | null; source: 'auto' | 'manual'; reason: string }
export type Classification = Record<'spend_category' | 'project' | 'purchase_type', AutoLabel>

export type Invoice = {
    id: number
    source: 'xml' | 'qr' | 'photo' | 'manual'
    uuid: string | null
    uuid_source: 'xml' | 'qr' | 'manual' | null
    supplier: string | null
    issuer_rfc: string | null
    issuer_name: string | null
    receiver_rfc: string | null
    series: string | null
    folio: string | null
    invoice_date: string | null
    date_confirmed: boolean
    stamped_at: string | null
    captured_at: string
    captured_by_name: string | null
    subtotal: string | null
    vat: string | null
    total: string
    currency: string
    payment_method: 'PUE' | 'PPD' | null
    payment_form: string | null
    cfdi_use: string | null
    purchase_type: PurchaseType
    due_on: string | null
    paid_at: string | null
    supplier_ids: Record<string, string>
    pages: number
    sat_status: string | null
    note: string | null
    spend_category: string | null
    project: string | null
    classification: Partial<Classification>
    lines_total: number
    lines_reconciled: number
}

export type InvoiceLine = {
    sort_order: number
    description: string
    quantity: string | null
    unit: string | null
    prod_serv_key: string | null
    identification_no: string | null
    unit_value: string | null
    amount: string | null
}

export type InvoiceFile = { id: number; name: string; mime: string; bytes: number; uploaded_at: string }

export type InvoiceDetail = Invoice & { lines: InvoiceLine[]; files: InvoiceFile[] }

export type PaymentSummary = {
    to_pay: number
    to_pay_amount: string | null
    overdue: number
    overdue_amount: string | null
}

export type InvoicesResponse = {
    invoices: Invoice[]
    total: number
    page: number
    pages: number
    summary: PaymentSummary
}

export type InvoiceGroup = { key: string; name: string; invoices: number; amount: string | null }

export type InvoiceFacets = {
    suppliers: InvoiceGroup[]
    months: InvoiceGroup[]
    spend_categories: InvoiceGroup[]
    projects: InvoiceGroup[]
    types: InvoiceGroup[]
    statuses: { to_pay: number; overdue: number; paid: number }
    available_spend_categories: string[]
}

export type QrData = {
    uuid: string
    issuer_rfc: string
    receiver_rfc: string
    total: string
    seal_tail: string | null
}

export type AlreadyRegistered = { id: number; invoice_date: string | null; total: string; issuer_name: string | null } | null

export type QrRead = { qr: QrData; already_registered: AlreadyRegistered }

export type XmlInvoice = {
    uuid: string
    series: string | null
    folio: string | null
    invoice_date: string | null
    issuer_rfc: string | null
    issuer_name: string | null
    receiver_rfc: string | null
    subtotal: string | null
    vat: string | null
    total: string | null
    payment_method: string | null
    lines: { sort_order: number; description: string | null; quantity: string | null; unit: string | null; amount: string | null }[]
}

export type XmlRead = {
    invoice: XmlInvoice
    discrepancies: string[] | null
    classification: Classification
    already_registered: AlreadyRegistered
}

export const PURCHASE_TYPE_LABEL: Record<PurchaseType, string> = {
    stock: 'Stock',
    direct_to_job: 'Direct to job',
    unclassified: 'Unclassified',
}

/** Local calendar date (YYYY-MM-DD) in the browser's time zone. */
export function localToday(): string {
    return new Intl.DateTimeFormat('en-CA').format(new Date())
}

// ---- AI reading: a DRAFT the person confirms ----

export type AiField = {
    value: string | null
    readings: number
    agreement: 'none' | 'single_reading' | 'confirmed' | 'majority' | 'conflict'
    conflict?: { value: string; count: number }[]
    others?: { value: string; count: number }[]
}

export type FormLine = { description: string; quantity: string; unit: string; unit_value: string; amount: string }

export type AiDraft = {
    fields: Record<'folio' | 'issuer_name' | 'issuer_rfc' | 'invoice_date' | 'subtotal' | 'vat' | 'total' | 'pages', AiField>
    lines: { description: string; quantity: string | null; unit: string | null; unit_value: string | null; amount: string | null; strips: number }[]
    strips: { total: number; read: number; failures: Record<string, number> }
}

/** What is shown and edited before saving an invoice without XML. All text: what's printed is what's shown and sent. */
export type InvoiceForm = {
    issuer_name: string
    issuer_rfc: string
    folio: string
    invoice_date: string
    date_ok: boolean
    subtotal: string
    vat: string
    total: string
    manual_uuid: string
    lines: FormLine[]
}

// ---- Reconciliation with inventory ----

export type ProductCard = {
    id: number; code: string; name: string; unit: string
    control_type: 'unit' | 'stock' | 'no_balance'
    count_pending: boolean; quantity: number
}

export type ReconciliationLine = {
    sort_order: number; description: string; quantity: string | null; unit: string | null
    unit_value: string | null; amount: string | null; identification_no: string | null
    reconciliation: 'pending' | 'stock_in' | 'no_stock_in'
    movement_id: number | null
    product: ProductCard | null
    suggestion: { product: { id: number; code: string; name: string }; reason: 'same_form' | 'similar' | 'supplier_code'; via: 'link' | 'name' | 'code'; similarity: number; has_numbers: boolean } | null
}

export type Reconciliation = {
    invoice: { id: number; purchase_type: PurchaseType }
    summary: { total: number; reconciled: number }
    lines: ReconciliationLine[]
}

export type StockInResponse = { movement: { id: number }; learned: boolean; new_balance: number | null; count_pending: boolean }
