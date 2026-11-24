import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, InlineLoading, InlineNotification } from '@carbon/react'
import { requestJson } from '../../api'
import { fetchJson, errorMessage } from '../../queries'
import type { Product } from '../../types'
import { Pagination } from '../Pagination'

// Lets an admin switch no-balance products to stock-tracked. They come in uncounted (a zero would be made up)
// until their first physical count, and from then on every out has to be recorded.

export function PickWithStock() {
    const qc = useQueryClient()
    const [page, setPage] = useState(1)
    const [marked, setMarked] = useState<ReadonlySet<number>>(new Set())
    const [working, setWorking] = useState(false)
    const [result, setResult] = useState<{ done: number; failures: string[] } | null>(null)

    const list = useQuery({
        queryKey: ['products', 'no_balance', page],
        queryFn: fetchJson<{ products: Product[]; total: number }>(`/api/products?control=no_balance&sort=category&page=${page}`),
    })
    const products = list.data?.products ?? []
    const groups = new Map<string, Product[]>()
    for (const p of products) groups.set(p.category ?? 'Uncategorized', [...(groups.get(p.category ?? 'Uncategorized') ?? []), p])

    const toggle = (ids: number[], on: boolean) => setMarked(m => { const n = new Set(m); for (const id of ids) { if (on) n.add(id); else n.delete(id) } return n })

    async function switchOver() {
        setWorking(true); setResult(null)
        const failures: string[] = []
        let done = 0
        // One at a time: few products, and each failure is reported by name.
        for (const id of marked) {
            const p = products.find(x => x.id === id)
            try {
                await requestJson(`/api/products/${id}/control`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ control_type: 'stock' }) })
                done++
            } catch (e) { failures.push(`${p?.code ?? id}: ${errorMessage(e)}`) }
        }
        setResult({ done, failures }); setMarked(new Set()); setWorking(false)
        void qc.invalidateQueries({ queryKey: ['requisition'] })
        void qc.invalidateQueries({ queryKey: ['products'] })
        void qc.invalidateQueries({ queryKey: ['summary'] })
    }

    return <div className="flex flex-col gap-3 text-sm">
        {list.isLoading && <InlineLoading description="Loading…" />}
        {list.error && <InlineNotification kind="error" title="Could not load" subtitle={errorMessage(list.error)} hideCloseButton />}
        {[...groups.entries()].map(([category, items]) => <div key={category} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{category} ({items.length})</strong>
                <Button kind="ghost" size="sm" onClick={() => toggle(items.map(p => p.id), !items.every(p => marked.has(p.id)))}>
                    {items.every(p => marked.has(p.id)) ? 'Unmark group' : 'Mark group'}</Button>
            </div>
            <ul className="flex flex-col">
                {items.map(p => <li key={p.id}><label className="flex items-center gap-2 py-1">
                    <input type="checkbox" className="h-5 w-5" checked={marked.has(p.id)} onChange={e => toggle([p.id], e.target.checked)} />
                    <span className="min-w-0 truncate">{p.code} · {p.name}</span><span className="shrink-0 text-xs text-text-2">{p.unit}</span>
                </label></li>)}
            </ul>
        </div>)}
        {(list.data?.total ?? 0) > 50 && <Pagination total={list.data!.total} page={page} disabled={list.isFetching} onChange={setPage} />}
        {products.length > 0 && <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={marked.size === 0 || working} onClick={() => void switchOver()}>{working ? 'Switching…' : `Track stock for ${marked.size}`}</Button>
        </div>}
        {result && <InlineNotification kind={result.failures.length ? 'warning' : 'success'} hideCloseButton title={`${result.done} updated`}
            subtitle={result.failures.length ? result.failures.join(' · ') : undefined} />}
    </div>
}
