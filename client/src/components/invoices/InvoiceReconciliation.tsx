import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, InlineLoading, InlineNotification, Tag } from '@carbon/react'
import { requestJson, toProduct } from '../../api'
import { fetchJson, errorMessage } from '../../queries'
import { quantityText, money, unitPriceText } from '../../money'
import { formatQuantity, balanceKnown } from '../../level'
import type { Reconciliation, ProductCard, ReconciliationLine, StockInResponse } from '../../invoices/types'
import type { Product, ProductApi } from '../../types'

// Rules that beat convenience:
//  - A suggestion only SUGGESTS. Nothing is linked or recorded on its own.
//  - Recording a stock-in asks for a second confirmation and can't be undone from here: the balance already
//    changed, and a mistake is fixed with an adjustment.
//  - The quantity is confirmed with BOTH units in view (the invoice says "6 METRO LINEAL", the product may be
//    counted in pieces). Nothing is converted for the person.
//  - The balance of an uncounted (or no_balance) product shows as —, never as a number nobody knows.

const balanceOf = (p: ProductCard) => balanceKnown(p) ? formatQuantity(p.quantity) : '—'

function Line({ l, invoiceId, directToJob, onChange }: { l: ReconciliationLine; invoiceId: number; directToJob: boolean; onChange: () => void }) {
    const [chosen, setChosen] = useState<ProductCard | null>(null)
    const [quantity, setQuantity] = useState(quantityText(l.quantity))
    const [learn, setLearn] = useState(true)
    const [confirming, setConfirming] = useState(false)
    const [text, setText] = useState('')
    const [query, setQuery] = useState('')
    const [error, setError] = useState<string | null>(null)

    // The search goes out when typing pauses, not on every letter.
    useEffect(() => {
        const t = setTimeout(() => setQuery(text.trim()), 300)
        return () => clearTimeout(t)
    }, [text])
    const search = useQuery({
        queryKey: ['products', 'search', query],
        queryFn: fetchJson<{ products: Product[] }>(`/api/products?q=${encodeURIComponent(query)}`),
        enabled: l.reconciliation === 'pending' && query.length >= 2,
    })

    const path = `/api/invoices/${invoiceId}/lines/${l.sort_order}`
    const post = (suffix: string, body: unknown) => requestJson<StockInResponse>(`${path}/${suffix}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const record = useMutation({
        mutationFn: () => post('stock-in', { product_id: chosen!.id, quantity, learn }),
        onSuccess: () => { setError(null); onChange() },
        onError: e => { setError(errorMessage(e)); setConfirming(false) },
    })
    const noStockIn = useMutation({
        mutationFn: () => post('no-stock-in', chosen ? { product_id: chosen.id } : {}),
        onSuccess: () => { setError(null); onChange() },
        onError: e => setError(errorMessage(e)),
    })
    const undo = useMutation({
        mutationFn: () => post('undo', {}),
        onSuccess: () => { setError(null); onChange() },
        onError: e => setError(errorMessage(e)),
    })

    const sug = l.suggestion
    const busy = record.isPending || noStockIn.isPending || undo.isPending
    const quantityOk = /^\d+(\.\d{1,3})?$/.test(quantity) && Number(quantity) > 0
    const differentUnit = chosen !== null && l.unit !== null && l.unit.toLowerCase() !== chosen.unit.toLowerCase()

    return <li className="flex flex-col gap-2 py-3 text-sm">
        <div className="flex justify-between gap-3">
            <span className="min-w-0"><strong>{l.description}</strong><br />
                <span className="text-xs text-text-2">{quantityText(l.quantity)} {l.unit ?? ''} × {unitPriceText(l.unit_value)}</span></span>
            <span className="shrink-0">{money(l.amount)}</span>
        </div>

        {l.reconciliation === 'stock_in' && <div className="flex flex-wrap items-center gap-2">
            <Tag type="green">Stock-in recorded</Tag>
            {l.product && <span>{l.product.code} · {l.product.name}</span>}
        </div>}

        {l.reconciliation === 'no_stock_in' && <div className="flex flex-wrap items-center gap-2">
            <Tag type="gray">No stock-in</Tag>
            {l.product && <span>{l.product.code} · {l.product.name}</span>}
            <Button kind="ghost" size="sm" disabled={busy} onClick={() => undo.mutate()}>Back to pending</Button>
        </div>}

        {l.reconciliation === 'pending' && <>
            {!chosen && sug && <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background p-2">
                <Tag type="blue" title={sug.reason === 'supplier_code' ? "The line's supplier number is the one linked to this product"
                    : sug.reason === 'same_form' ? 'The same description was linked before' : `Similarity ${sug.similarity}, same measurements`}>
                    {sug.reason === 'supplier_code' ? 'Supplier code' : sug.reason === 'same_form' ? 'Already linked' : 'Suggested'}</Tag>
                <span className="min-w-0">{sug.product.code} · {sug.product.name}</span>
                <Button kind="tertiary" size="sm" onClick={() => { setChosen({ ...sug.product, unit: '', control_type: 'stock', count_pending: true, quantity: 0 }); setText('') }}>Use</Button>
            </div>}

            {!chosen && <>
                <input className="h-10 w-full border bg-layer px-2" aria-label={`Search a product for line ${l.sort_order}`} placeholder="Search the product by code or name…"
                    value={text} onChange={e => setText(e.target.value)} />
                {search.isFetching && <InlineLoading description="Searching…" />}
                {search.data && query.length >= 2 && <ul className="flex max-h-48 flex-col overflow-auto border border-border">
                    {search.data.products.length === 0 && <li className="p-2 text-text-2">No product matches.</li>}
                    {search.data.products.slice(0, 8).map(p => <li key={p.id}>
                        <button type="button" className="flex w-full justify-between gap-2 p-2 text-left hover:bg-background"
                            onClick={() => { setChosen({ id: p.id, code: p.code, name: p.name, unit: p.unit, control_type: p.control_type, count_pending: p.count_pending, quantity: Number(p.quantity) }); setText('') }}>
                            <span className="min-w-0 truncate">{p.code} · {p.name}</span><span className="shrink-0 text-xs text-text-2">{p.unit}</span>
                        </button></li>)}
                </ul>}
            </>}

            {chosen && <ChosenWithUnit chosen={chosen} onCard={setChosen}>
                <div className="flex flex-col gap-2 rounded-lg bg-background p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong>{chosen.code} · {chosen.name}</strong>
                        <Button kind="ghost" size="sm" onClick={() => { setChosen(null); setConfirming(false) }}>Change</Button>
                    </div>
                    <span className="text-xs text-text-2">Product unit: {chosen.unit || '…'} · current balance: {chosen.unit ? balanceOf(chosen) : '…'}</span>
                    {directToJob && <InlineNotification kind="warning" hideCloseButton title="Direct to job" subtitle="Mark “No stock-in” or change the purchase type." />}
                    <label className="flex flex-wrap items-center gap-2">Quantity coming in
                        <input className="h-10 w-28 border bg-layer px-2" inputMode="decimal" value={quantity} onChange={e => { setQuantity(e.target.value); setConfirming(false) }} />
                        <span className="text-text-2">{chosen.unit}</span></label>
                    {differentUnit && <span className="text-xs" style={{ color: 'var(--chart-alert)' }}>Invoice unit: {l.unit} · product unit: {chosen.unit}.</span>}
                    <label className="flex items-center gap-2 text-xs"><input type="checkbox" className="h-4 w-4" checked={learn} onChange={e => setLearn(e.target.checked)} />
                        Remember this mapping</label>
                    <div className="flex flex-wrap gap-2">
                        {!confirming
                            ? <Button size="sm" disabled={!quantityOk || busy || directToJob || !chosen.unit} onClick={() => setConfirming(true)}>Record stock-in</Button>
                            : <><Button size="sm" kind="danger" disabled={busy} onClick={() => record.mutate()}>Confirm +{quantity} {chosen.unit}</Button>
                                <Button size="sm" kind="ghost" onClick={() => setConfirming(false)}>Cancel</Button></>}
                        <Button size="sm" kind="tertiary" disabled={busy} onClick={() => noStockIn.mutate()}>No stock-in</Button>
                    </div>
                </div>
            </ChosenWithUnit>}
            {!chosen && <div><Button kind="ghost" size="sm" disabled={busy} onClick={() => noStockIn.mutate()}>No stock-in</Button></div>}
        </>}
        {error && <InlineNotification kind="error" title="Something went wrong" subtitle={error} hideCloseButton />}
    </li>
}

/** A suggestion only carries id, code and name: the unit and balance are needed before recording anything, so the card is completed on choosing it. */
function ChosenWithUnit({ chosen, onCard, children }: { chosen: ProductCard; onCard: (c: ProductCard) => void; children: React.ReactNode }) {
    const complete = chosen.unit !== ''
    const lookup = useQuery({
        queryKey: ['products', 'by-code', chosen.code],
        queryFn: fetchJson<ProductApi>(`/api/products/by-code?code=${encodeURIComponent(chosen.code)}`),
        enabled: !complete,
    })
    const p = lookup.data ? toProduct(lookup.data) : undefined
    useEffect(() => {
        if (!complete && p) onCard({ id: p.id, code: p.code, name: p.name, unit: p.unit, control_type: p.control_type, count_pending: p.count_pending, quantity: p.quantity })
    }, [complete, p, onCard])
    return <>{children}</>
}

export function InvoiceReconciliation({ id }: { id: number }) {
    const qc = useQueryClient()
    const c = useQuery({ queryKey: ['invoices', 'reconciliation', id], queryFn: fetchJson<Reconciliation>(`/api/invoices/${id}/reconciliation`) })
    const refresh = () => {
        void qc.invalidateQueries({ queryKey: ['invoices'] })
        void qc.invalidateQueries({ queryKey: ['products'] })
        void qc.invalidateQueries({ queryKey: ['movements'] })
        void qc.invalidateQueries({ queryKey: ['summary'] })
        void qc.invalidateQueries({ queryKey: ['requisition'] })
    }
    if (c.isLoading) return <InlineLoading description="Preparing the reconciliation…" />
    if (c.error) return <InlineNotification kind="error" title="Could not prepare the reconciliation" subtitle={errorMessage(c.error)} hideCloseButton />
    if (!c.data) return null
    return <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">Lines ({c.data.summary.reconciled} of {c.data.summary.total} reconciled)</h3>
        {c.data.lines.length === 0
            ? <p className="text-sm text-text-2">No lines.</p>
            : <ul className="flex flex-col divide-y divide-border">
                {c.data.lines.map(l => <Line key={`${l.sort_order}-${l.reconciliation}`} l={l} invoiceId={id} directToJob={c.data!.invoice.purchase_type === 'direct_to_job'} onChange={refresh} />)}
            </ul>}
    </div>
}
