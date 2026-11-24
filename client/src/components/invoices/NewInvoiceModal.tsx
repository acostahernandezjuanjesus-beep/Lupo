import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, InlineLoading, InlineNotification, Modal, Tag } from '@carbon/react'
import { ApiError, requestJson, uploadFile } from '../../api'
import { errorMessage } from '../../queries'
import { money, shortDate } from '../../money'
import { findQr, canvasToJpeg, cutStrips, pdfPages, imageToCanvas, qrFromPages } from '../../invoices/reader'
import { BlobViewer } from './FileViewer'
import { PURCHASE_TYPE_LABEL, type AiDraft, type Classification, type InvoiceForm, type QrRead, type XmlRead, type PurchaseType } from '../../invoices/types'
import { EMPTY_FORM, formFromDraft } from '../../invoices/form'
import { AiReadingForm } from './AiReadingForm'

// Capturing an invoice: XML, PDF or photo.
//  - XML: read on the server, brings everything (lines included) and is the most exact.
//  - PDF / photo: look for the CFDI QR (exact UUID, RFC and total). Without a QR nothing is made up; the person
//    is told. No AI in this step: the UUID can't come from an "approximate" reading.
// Several files of the same invoice can be picked (its XML and its PDF): the XML wins, the PDF/photo are kept
// as the original.

type Prepared = {
    xml?: { text: string; read: XmlRead }
    qr?: { text: string; read: QrRead }
    originals: { name: string; blob: Blob }[]
    /** The pages (max 3) as canvases, to cut into strips if read with AI. */
    sheets: HTMLCanvasElement[]
    notices: string[]
}

const MAX_AI_SHEETS = 3
const cleanAmount = (v: string) => v.replace(/[$,\s]/g, '')

/**
 * Body of POST /api/invoices for an invoice without XML, from the form. Empty values are left out (no "" where
 * the server expects an amount) and the UUID only goes if the person typed it: it never comes from the AI.
 */
function bodyFromForm(f: InvoiceForm, qrText: string | null) {
    const t = (v: string) => v.trim()
    const put = <T extends object>(o: T, k: string, v: string) => { if (t(v) !== '') (o as Record<string, unknown>)[k] = t(v); return o }
    const c: Record<string, unknown> = qrText ? { source: 'qr', qr: qrText } : { source: 'photo' }
    put(c, 'issuer_name', f.issuer_name); put(c, 'folio', f.folio); put(c, 'invoice_date', f.invoice_date)
    if (t(f.invoice_date) !== '') c.date_confirmed = f.date_ok
    // With a QR, the RFC and total come from the QR; sending the typed ones only risks a pointless 409.
    if (!qrText) { put(c, 'issuer_rfc', f.issuer_rfc); put(c, 'total', cleanAmount(f.total)); put(c, 'manual_uuid', f.manual_uuid) }
    put(c, 'subtotal', cleanAmount(f.subtotal)); put(c, 'vat', cleanAmount(f.vat))
    c.lines = f.lines.filter(l => t(l.description) !== '').map(l => {
        const o: Record<string, string> = { description: t(l.description) }
        for (const k of ['quantity', 'unit_value', 'amount'] as const) if (t(l[k]) !== '') o[k] = cleanAmount(l[k])
        if (t(l.unit) !== '') o.unit = t(l.unit)
        return o
    })
    return c
}

const typeOf = (f: File) => f.type || (/\.xml$/i.test(f.name) ? 'text/xml' : /\.pdf$/i.test(f.name) ? 'application/pdf' : '')
const JSON_HEADERS = { 'Content-Type': 'application/json' }

export function NewInvoiceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const qc = useQueryClient()
    const fileInput = useRef<HTMLInputElement>(null)
    const [reading, setReading] = useState(false)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [p, setP] = useState<Prepared | null>(null)
    const [type, setType] = useState<PurchaseType | ''>('')
    const [due, setDue] = useState('')
    const [saved, setSaved] = useState(false)
    const [form, setForm] = useState<InvoiceForm | null>(null)
    const [draft, setDraft] = useState<AiDraft | null>(null)
    const [readingAi, setReadingAi] = useState(false)

    function reset() { setP(null); setError(null); setType(''); setDue(''); setSaved(false); setForm(null); setDraft(null) }
    function close() { reset(); onClose() }

    async function read(files: File[]) {
        setReading(true); setError(null); setP(null); setForm(null); setDraft(null)
        const originals: Prepared['originals'] = []
        const sheets: HTMLCanvasElement[] = []
        const notices: string[] = []
        let xmlText: string | null = null
        try {
            let qrText: string | null = null
            for (const f of files) {
                const t = typeOf(f)
                if (t.includes('xml')) {
                    xmlText = await f.text()
                } else if (t === 'application/pdf') {
                    const fromThis = await pdfPages(await f.arrayBuffer())
                    qrText ??= await qrFromPages(fromThis)
                    sheets.push(...fromThis)
                    originals.push({ name: f.name, blob: f })
                } else if (t.startsWith('image/')) {
                    // To JPEG, 2400 px max: covers iPhone HEIC and shrinks 6 MB photos.
                    const canvas = await imageToCanvas(f)
                    qrText ??= await findQr(canvas)
                    sheets.push(canvas)
                    originals.push({ name: f.name.replace(/\.\w+$/, '') + '.jpg', blob: await canvasToJpeg(canvas) })
                } else {
                    throw new Error(`"${f.name}": unsupported format (XML, PDF, JPG, PNG or WEBP)`)
                }
            }
            const prep: Prepared = { originals, notices, sheets: sheets.slice(0, MAX_AI_SHEETS) }
            if (xmlText !== null) {
                prep.xml = {
                    text: xmlText,
                    read: await requestJson<XmlRead>('/api/invoices/read-xml', {
                        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ xml: xmlText, ...(qrText ? { qr: qrText } : {}) }),
                    }),
                }
                if (qrText) prep.qr = { text: qrText, read: null as unknown as QrRead }
            } else if (qrText) {
                prep.qr = {
                    text: qrText,
                    read: await requestJson<QrRead>('/api/invoices/read-qr', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ text: qrText }) }),
                }
            } else {
                notices.push('No readable QR was found. Also upload the XML, take the photo closer and in even light, or read it with AI.')
            }
            setP(prep)
        } catch (e) { setError(errorMessage(e)) } finally { setReading(false) }
    }

    const already = p?.xml?.read.already_registered ?? p?.qr?.read?.already_registered ?? null
    const discrepancies = p?.xml?.read.discrepancies
    const qr = p?.qr?.read?.qr
    // Without XML and with the form open: the total rules (the QR's, if any) and a date that's filled in
    // needs its "compared it with the paper" checkbox.
    const formTotal = qr ? qr.total : cleanAmount(form?.total ?? '')
    const formOk = !!form && /^\d{1,12}(\.\d{1,2})?$/.test(formTotal) && (form.invoice_date === '' || form.date_ok)
    const canSave = !!p && !already && !discrepancies?.length && (!!p.xml || (form ? formOk : !!p.qr))

    async function readWithAi() {
        if (!p) return
        setReadingAi(true); setError(null)
        try {
            // One page: 8 strips. Several: 5 per page, to stay under 16 in total.
            const strips = p.sheets.flatMap(h => cutStrips(h, p.sheets.length === 1 ? 8 : 5))
            const b = await requestJson<AiDraft>('/api/invoices/read-photo', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ strips }) })
            setDraft(b); setForm(formFromDraft(b))
        } catch (e) { setError(errorMessage(e)) } finally { setReadingAi(false) }
    }

    async function save() {
        if (!p) return
        setSaving(true); setError(null)
        try {
            const base = p.xml
                ? { xml: p.xml.text, ...(p.qr ? { qr: p.qr.text } : {}) }
                : form ? bodyFromForm(form, p.qr?.text ?? null)
                : { source: 'qr', qr: p.qr!.text }
            const r = await requestJson<{ id: number }>('/api/invoices', {
                method: 'POST', headers: JSON_HEADERS,
                body: JSON.stringify({ ...base, ...(type ? { purchase_type: type } : {}), ...(due ? { due_on: due } : {}) }),
            })
            void qc.invalidateQueries({ queryKey: ['invoices'] })
            // The server already stores the XML; the PDFs/photos go here. If an upload fails the invoice
            // already exists: the person is told and can upload it later from the detail.
            for (const o of p.originals) {
                try { await uploadFile(r.id, o.blob, o.name) }
                catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw new Error(`The invoice was saved, but "${o.name}" could not be uploaded: ${errorMessage(e)}`, { cause: e }) }
            }
            setSaved(true)
        } catch (e) { setError(errorMessage(e)) } finally { setSaving(false) }
    }

    const classification: Classification | undefined = p?.xml?.read.classification
    const f = p?.xml?.read.invoice

    return <Modal open={open} size="lg" hasScrollingContent modalHeading="New invoice"
        primaryButtonText={saved ? 'Done' : saving ? 'Saving…' : 'Save invoice'}
        secondaryButtonText={saved ? 'Capture another' : 'Cancel'}
        primaryButtonDisabled={saved ? false : !canSave || saving}
        onRequestSubmit={() => saved ? close() : void save()}
        onSecondarySubmit={() => saved ? reset() : close()}
        onRequestClose={close}>
        <div className="flex flex-col gap-4">
            {saved ? <InlineNotification kind="success" title="Invoice saved" hideCloseButton /> : <>
                <input ref={fileInput} type="file" multiple hidden accept=".xml,.pdf,image/*"
                    onChange={e => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) void read(fs) }} />
                <div className="flex flex-wrap gap-2">
                    <Button kind="primary" disabled={reading || saving} onClick={() => fileInput.current?.click()}>Choose XML, PDF or photo</Button>
                    {p && <Button kind="ghost" onClick={reset}>Remove</Button>}
                </div>
                {reading && <InlineLoading description="Reading…" />}
                {error && <InlineNotification kind="error" title="Something went wrong" subtitle={error} hideCloseButton />}
                {p?.notices.map(a => <InlineNotification key={a} kind="warning" title="No QR" subtitle={a} hideCloseButton />)}
                {already && <InlineNotification kind="info" hideCloseButton title="Already registered"
                    subtitle={`${shortDate(already.invoice_date?.slice(0, 10) ?? null)} · ${money(already.total)}`} />}
                {already && <Link to={`/invoices?open=${already.id}`} onClick={close}>Open invoice</Link>}
                {discrepancies && discrepancies.length > 0 && <InlineNotification kind="error" hideCloseButton title="XML and QR mismatch"
                    subtitle={discrepancies.join(' · ')} />}
                {p && !already && (f || qr) && <div className="flex flex-col gap-1 rounded-lg bg-layer p-3 text-sm">
                    {f ? <>
                        <strong>{f.issuer_name ?? f.issuer_rfc ?? '(no issuer)'}</strong>
                        <span>{f.series ?? ''}{f.folio ? `-${f.folio}` : ''} · {shortDate(f.invoice_date?.slice(0, 10) ?? null)} · {money(f.total)}</span>
                        <span className="text-text-2">{f.lines.length} lines · {f.payment_method ?? '—'}</span>
                    </> : qr && <>
                        <strong>QR only: {money(qr.total)}</strong>
                        <span className="text-text-2">Issuer {qr.issuer_rfc}</span>
                    </>}
                    <span className="break-all text-xs text-text-2">UUID {f?.uuid ?? qr?.uuid}</span>
                </div>}
                {classification && <div className="flex flex-wrap gap-2">
                    <Tag type="blue" title={classification.spend_category.reason}>{classification.spend_category.value ?? 'No category'}</Tag>
                    <Tag type="purple" title={classification.project.reason}>{classification.project.value ?? 'No project'}</Tag>
                    <Tag type="gray" title={classification.purchase_type.reason}>{PURCHASE_TYPE_LABEL[classification.purchase_type.value as PurchaseType] ?? 'Unclassified'}</Tag>
                </div>}
                {p && p.originals.length > 0 && <div className="flex flex-col gap-2">
                    {p.originals.map(o => <BlobViewer key={o.name} blob={o.blob} name={o.name} mime={o.blob.type || 'application/pdf'} height="45vh" />)}
                </div>}
                {p && !already && !p.xml && p.sheets.length > 0 && !form && <div className="flex flex-col gap-2 rounded-lg bg-layer p-3">
                    <div className="flex flex-wrap gap-2">
                        <Button kind="tertiary" disabled={readingAi} onClick={() => void readWithAi()}>Read with AI</Button>
                        <Button kind="ghost" disabled={readingAi} onClick={() => setForm(EMPTY_FORM)}>Enter manually</Button>
                    </div>
                    {readingAi && <InlineLoading description="Reading…" />}
                </div>}
                {p && !already && !p.xml && form && <AiReadingForm draft={draft} form={form} onChange={setForm} qrTotal={qr?.total} qrRfc={qr?.issuer_rfc} />}
                {canSave && <div className="flex flex-wrap gap-4">
                    <label className="text-sm">Purchase type<br />
                        <select className="mt-1 h-10 border bg-layer px-2" value={type} onChange={e => setType(e.target.value as PurchaseType | '')}>
                            <option value="">Automatic</option>
                            {(Object.keys(PURCHASE_TYPE_LABEL) as PurchaseType[]).map(t => <option key={t} value={t}>{PURCHASE_TYPE_LABEL[t]}</option>)}
                        </select></label>
                    <label className="text-sm">Due<br />
                        <input type="date" className="mt-1 h-10 border bg-layer px-2" value={due} onChange={e => setDue(e.target.value)} /></label>
                </div>}
            </>}
            {saved && error && <InlineNotification kind="warning" title="Heads up" subtitle={error} hideCloseButton />}
        </div>
    </Modal>
}
