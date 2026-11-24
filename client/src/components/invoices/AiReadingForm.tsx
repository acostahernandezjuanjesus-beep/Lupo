import { Button, Tag } from '@carbon/react'
import type { AiDraft, AiField, InvoiceForm, FormLine } from '../../invoices/types'

// The review step for an invoice without XML: what the AI read (or nothing, if typed by hand) in editable
// fields next to the paper preview. The date gets its own checkbox because the model misreads it consistently
// (2025 for 2026) and a reviewer who sees five hits in a row signs off the sixth without looking.

function Badge({ field }: { field?: AiField }) {
    if (!field) return null
    switch (field.agreement) {
        case 'confirmed': return <Tag size="sm" type="green" title="Two or more strips of the page read the same thing">{field.readings} readings agree</Tag>
        case 'majority': return <Tag size="sm" type="gray" title={`Also read: ${field.others?.map(o => o.value).join(', ')}`}>most readings agree</Tag>
        case 'single_reading': return <Tag size="sm" type="warm-gray" title="Only one strip saw it: compare it with the paper">1 reading only: check it</Tag>
        case 'conflict': return <Tag size="sm" type="red" title="The strips read different things; none was picked">no agreement: {field.conflict?.map(o => o.value).join(' / ')}</Tag>
        default: return <Tag size="sm" type="outline">not read</Tag>
    }
}

const INPUT_CLASS = 'mt-1 h-10 w-full border bg-layer px-2'

function Field({ label, field, children }: { label: string; field?: AiField; children: React.ReactNode }) {
    return <label className="flex min-w-0 flex-col text-sm">
        <span className="flex flex-wrap items-center gap-2">{label}<Badge field={field} /></span>
        {children}
    </label>
}

export function AiReadingForm({ draft, form, onChange, qrTotal, qrRfc }: {
    draft: AiDraft | null
    form: InvoiceForm
    onChange: (f: InvoiceForm) => void
    /** With a QR the total and the RFC are already exact: not editable. */
    qrTotal?: string
    qrRfc?: string
}) {
    const f = draft?.fields
    const set = (field: keyof InvoiceForm) => (e: { target: { value: string } }) => onChange({ ...form, [field]: e.target.value })
    const setLine = (i: number, k: keyof FormLine, v: string) => onChange({ ...form, lines: form.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) })
    const total = qrTotal ?? form.total
    // If the AI read a different total than the QR, the QR wins, but we say so.
    const aiTotal = f?.total.value
    const mismatch = qrTotal !== undefined && aiTotal != null && Math.abs(parseFloat(aiTotal) - parseFloat(qrTotal)) >= 0.005

    return <div className="flex flex-col gap-3">
        {draft && <p className="text-xs text-text-2">AI draft ({draft.strips.read}/{draft.strips.total} strips)</p>}
        <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Supplier" field={f?.issuer_name}><input className={INPUT_CLASS} value={form.issuer_name} maxLength={200} onChange={set('issuer_name')} /></Field>
            <Field label="Supplier RFC" field={qrRfc ? undefined : f?.issuer_rfc}>
                <input className={INPUT_CLASS} value={qrRfc ?? form.issuer_rfc} maxLength={13} readOnly={!!qrRfc} onChange={set('issuer_rfc')} />
            </Field>
            <Field label="Folio" field={f?.folio}><input className={INPUT_CLASS} value={form.folio} maxLength={40} onChange={set('folio')} /></Field>
            <Field label="Invoice date" field={f?.invoice_date}>
                <input type="date" className={INPUT_CLASS} value={form.invoice_date} onChange={e => onChange({ ...form, invoice_date: e.target.value, date_ok: false })} />
            </Field>
            <Field label="Subtotal" field={f?.subtotal}><input className={INPUT_CLASS} inputMode="decimal" value={form.subtotal} onChange={set('subtotal')} /></Field>
            <Field label="VAT" field={f?.vat}><input className={INPUT_CLASS} inputMode="decimal" value={form.vat} onChange={set('vat')} /></Field>
            <Field label={qrTotal !== undefined ? 'Total (QR)' : 'Total'} field={qrTotal !== undefined ? undefined : f?.total}>
                <input className={INPUT_CLASS} inputMode="decimal" value={total} readOnly={qrTotal !== undefined} onChange={set('total')} />
            </Field>
            {qrTotal === undefined && <Field label="UUID (optional)">
                <input className={INPUT_CLASS} value={form.manual_uuid} maxLength={36} onChange={e => onChange({ ...form, manual_uuid: e.target.value.toUpperCase() })} />
            </Field>}
        </div>
        {mismatch && <p className="text-sm" style={{ color: 'var(--chart-alert)' }}>AI total ({aiTotal}) differs from QR ({qrTotal}).</p>}
        {form.invoice_date && <label className="flex items-center gap-2 rounded-lg bg-background p-3 text-sm">
            <input type="checkbox" className="h-5 w-5" checked={form.date_ok} onChange={e => onChange({ ...form, date_ok: e.target.checked })} />
            <span>Date verified</span>
        </label>}

        <div className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">Lines ({form.lines.length})</h3>
            {form.lines.length === 0 && <p className="text-sm text-text-2">No lines.</p>}
            {form.lines.map((l, i) => <div key={i} className="grid grid-cols-[1fr_auto] gap-2 border-b border-border py-2">
                <input className={INPUT_CLASS} aria-label={`Description of line ${i + 1}`} value={l.description} maxLength={500} onChange={e => setLine(i, 'description', e.target.value)} />
                <Button kind="ghost" size="sm" onClick={() => onChange({ ...form, lines: form.lines.filter((_, j) => j !== i) })}>Remove</Button>
                <div className="col-span-2 grid grid-cols-4 gap-2 text-xs">
                    {([['quantity', 'Qty'], ['unit', 'Unit'], ['unit_value', 'Unit price'], ['amount', 'Amount']] as const).map(([k, label]) =>
                        <label key={k}>{label}<input className="mt-0.5 h-9 w-full border bg-layer px-2" inputMode={k === 'unit' ? 'text' : 'decimal'} value={l[k]} onChange={e => setLine(i, k, e.target.value)} /></label>)}
                </div>
            </div>)}
            <div><Button kind="ghost" size="sm" onClick={() => onChange({ ...form, lines: [...form.lines, { description: '', quantity: '', unit: '', unit_value: '', amount: '' }] })}>Add line</Button></div>
        </div>
    </div>
}
