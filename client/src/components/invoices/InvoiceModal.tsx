import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, InlineLoading, InlineNotification, Modal, Tag } from '@carbon/react'
import { requestJson, uploadFile } from '../../api'
import { fetchJson, errorMessage } from '../../queries'
import { money, shortDate } from '../../money'
import { canvasToJpeg, imageToCanvas } from '../../invoices/reader'
import { PURCHASE_TYPE_LABEL, localToday, type InvoiceFacets, type InvoiceDetail, type PurchaseType } from '../../invoices/types'
import { InvoiceReconciliation } from './InvoiceReconciliation'
import { FileViewer } from './FileViewer'

// A category the person corrects is saved as `manual` on the server and auto-classification never overwrites
// it again. The tags show why (title): a category nobody knows the origin of can't be trusted or corrected.

const LABEL_NAME: Record<string, string> = { spend_category: 'Category', project: 'Project', purchase_type: 'Purchase type' }

export function InvoiceModal({ id, onClose }: { id: number | null; onClose: () => void }) {
    const qc = useQueryClient()
    const fileInput = useRef<HTMLInputElement>(null)
    const [viewId, setViewId] = useState<number | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [project, setProject] = useState<string | null>(null)
    const [removing, setRemoving] = useState(false)

    const detail = useQuery({
        queryKey: ['invoices', 'detail', id],
        queryFn: fetchJson<InvoiceDetail>(`/api/invoices/${id}`),
        enabled: id !== null,
    })
    const facets = useQuery({ queryKey: ['invoices', 'categories'], queryFn: fetchJson<InvoiceFacets>('/api/invoices/categories'), enabled: id !== null })

    const f = detail.data
    const files = f?.files ?? []
    const open = files.find(a => a.id === viewId) ?? files.find(a => a.mime !== 'application/xml') ?? files[0]

    const change = useMutation({
        mutationFn: (changes: Record<string, unknown>) => requestJson(`/api/invoices/${id}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) }),
        onSuccess: () => { setError(null); void qc.invalidateQueries({ queryKey: ['invoices'] }) },
        onError: e => setError(errorMessage(e)),
    })

    // Removing takes the lines and files with it and leaves a trail of who did it. If the invoice already
    // generated stock-ins the server refuses (409) and says why.
    const remove = useMutation({
        mutationFn: () => requestJson(`/api/invoices/${id}`, { method: 'DELETE' }),
        onSuccess: () => { setRemoving(false); void qc.invalidateQueries({ queryKey: ['invoices'] }); onClose() },
        onError: e => { setRemoving(false); setError(errorMessage(e)) },
    })

    async function upload(fs: File[]) {
        setError(null)
        try {
            for (const a of fs) {
                if (a.type.startsWith('image/')) await uploadFile(id!, await canvasToJpeg(await imageToCanvas(a)), a.name.replace(/\.\w+$/, '') + '.jpg')
                else await uploadFile(id!, a, a.name)
            }
        } catch (e) { setError(errorMessage(e)) }
        void qc.invalidateQueries({ queryKey: ['invoices'] })
    }

    const today = localToday()
    const overdue = !!f && !f.paid_at && !!f.due_on && f.due_on.slice(0, 10) < today

    return <Modal open={id !== null} passiveModal size="lg" hasScrollingContent
        modalHeading={f ? `${f.issuer_name ?? f.issuer_rfc ?? 'Invoice'} ${f.series ?? ''}${f.folio ? `-${f.folio}` : ''}` : 'Invoice'}
        onRequestClose={() => { setViewId(null); setError(null); onClose() }}>
        {detail.isLoading && <InlineLoading description="Opening the invoice…" />}
        {detail.error && <InlineNotification kind="error" title="Could not open it" subtitle={errorMessage(detail.error)} hideCloseButton />}
        {error && <InlineNotification kind="error" title="Something went wrong" subtitle={error} hideCloseButton />}
        {f && <div className="grid gap-5 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-4">
                <div className="flex flex-col gap-1 text-sm">
                    <span className="text-2xl font-semibold">{money(f.total)}</span>
                    <span>{[`Date ${shortDate(f.invoice_date?.slice(0, 10) ?? null)}${f.invoice_date && !f.date_confirmed && f.source !== 'xml' ? ' (unconfirmed)' : ''}`,
                        f.payment_method, f.due_on ? `due ${shortDate(f.due_on.slice(0, 10))}` : null].filter(Boolean).join(' · ')}</span>
                    <span className="text-text-2">RFC {f.issuer_rfc ?? '—'} · captured by {f.captured_by_name ?? '—'}</span>
                    <span className="break-all text-xs text-text-2">UUID {f.uuid ?? '—'}{f.uuid_source ? ` (from ${f.uuid_source})` : ''}</span>
                </div>

                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                        {(['spend_category', 'project', 'purchase_type'] as const).map(k => {
                            const e = f.classification[k]
                            const value = k === 'purchase_type' ? PURCHASE_TYPE_LABEL[f.purchase_type] : f[k] ?? (k === 'spend_category' ? 'No category' : 'No project')
                            return <Tag key={k} type={e?.source === 'manual' ? 'green' : 'gray'} title={e ? `${LABEL_NAME[k]}: ${e.reason} (${e.source === 'manual' ? 'corrected by hand' : 'automatic'})` : LABEL_NAME[k]}>{value}</Tag>
                        })}
                    </div>
                    <div className="flex flex-wrap gap-3 text-sm">
                        <label>Category<br />
                            <select className="mt-1 h-10 border bg-layer px-2" value={f.spend_category ?? ''} disabled={change.isPending}
                                onChange={e => change.mutate({ spend_category: e.target.value || null })}>
                                <option value="">No category</option>
                                {facets.data?.available_spend_categories.map(r => <option key={r} value={r}>{r}</option>)}
                            </select></label>
                        <label>Type<br />
                            <select className="mt-1 h-10 border bg-layer px-2" value={f.purchase_type} disabled={change.isPending}
                                onChange={e => change.mutate({ purchase_type: e.target.value as PurchaseType })}>
                                {(Object.keys(PURCHASE_TYPE_LABEL) as PurchaseType[]).map(t => <option key={t} value={t}>{PURCHASE_TYPE_LABEL[t]}</option>)}
                            </select></label>
                        <label>Project<br />
                            <input className="mt-1 h-10 w-32 border bg-layer px-2" value={project ?? f.project ?? ''} placeholder="WO-1234" maxLength={40}
                                onChange={e => setProject(e.target.value)}
                                onBlur={() => { if (project !== null && project.trim() !== (f.project ?? '')) change.mutate({ project: project.trim() || null }); setProject(null) }} /></label>
                        <label>Due<br />
                            <input type="date" className="mt-1 h-10 border bg-layer px-2" value={f.due_on?.slice(0, 10) ?? ''} disabled={change.isPending}
                                onChange={e => change.mutate({ due_on: e.target.value || null })} /></label>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {f.paid_at
                            ? <><Tag type="green">Paid on {shortDate(f.paid_at.slice(0, 10))}</Tag><Button kind="ghost" size="sm" onClick={() => change.mutate({ paid_at: null })}>Undo</Button></>
                            : <><Tag type={overdue ? 'red' : 'warm-gray'}>{overdue ? 'Overdue' : 'To pay'}</Tag><Button kind="tertiary" size="sm" disabled={change.isPending} onClick={() => change.mutate({ paid_at: today })}>Mark paid today</Button></>}
                    </div>
                </div>

                <InvoiceReconciliation id={f.id} />

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                    {!removing
                        ? <div><Button kind="danger--ghost" size="sm" onClick={() => setRemoving(true)}>Remove this invoice</Button></div>
                        : <div className="flex flex-col gap-2 rounded-lg bg-background p-3 text-sm">
                            <span>Remove the invoice from <strong>{f.issuer_name ?? f.issuer_rfc ?? 'no issuer'}</strong> for <strong>{money(f.total)}</strong>?</span>
                            <div className="flex flex-wrap gap-2">
                                <Button kind="danger" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? 'Removing…' : 'Yes, remove it'}</Button>
                                <Button kind="ghost" size="sm" disabled={remove.isPending} onClick={() => setRemoving(false)}>Cancel</Button>
                            </div>
                        </div>}
                </div>
            </div>

            <div className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">Originals ({files.length})</h3>
                    <input ref={fileInput} type="file" multiple hidden accept=".xml,.pdf,image/*"
                        onChange={e => { const fs = [...(e.target.files ?? [])]; e.target.value = ''; if (fs.length) void upload(fs) }} />
                    <Button kind="ghost" size="sm" onClick={() => fileInput.current?.click()}>Add file</Button>
                </div>
                {files.length > 1 && <div className="flex flex-wrap gap-2">
                    {files.map(a => <Button key={a.id} size="sm" kind={a.id === open?.id ? 'secondary' : 'tertiary'} onClick={() => setViewId(a.id)}>{a.name}</Button>)}
                </div>}
                {open ? <FileViewer key={open.id} file={open} /> : <p className="text-sm text-text-2">No files.</p>}
            </div>
        </div>}
    </Modal>
}
