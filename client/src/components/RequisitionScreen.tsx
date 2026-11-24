import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Button, InlineLoading, InlineNotification, Tag } from '@carbon/react'
import { fetchJson, errorMessage } from '../queries'
import { formatQuantity, balanceKnown } from '../level'
import type { Product } from '../types'
import type { NoDataReason, Requisition, Suggestion } from '../requisition/types'
import type { User } from '../types'
import { LevelEditor } from './requisition/LevelEditor'
import { PickWithStock } from './requisition/PickWithStock'

// What to order and WHY, computed in code. The first thing shown is how many products could be evaluated and why
// the rest couldn't: "0 to order" without that would be reassuring and false.

const CARD = 'rounded-2xl bg-layer p-4 md:p-5 min-w-0'

const NO_DATA: Record<NoDataReason, { title: string; action?: { to: string; text: string } }> = {
    no_minimum: { title: 'No minimum set' },
    not_counted: { title: 'Not counted', action: { to: '/inventory?status=uncounted&control=stock', text: 'View uncounted' } },
    no_stock_tracking: { title: 'No stock tracking' },
    invalid_target: { title: 'Target below minimum' },
}

const REASON_ORDER: NoDataReason[] = ['no_minimum', 'not_counted', 'no_stock_tracking', 'invalid_target']

function Row({ s }: { s: Suggestion }) {
    const [editing, setEditing] = useState(false)
    return <li className="flex flex-col gap-2 py-3 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
            <span className="min-w-0"><strong>{s.code} · {s.name}</strong><br />
                <span className="text-text-2">{formatQuantity(s.quantity)} {s.unit} on hand · minimum {s.minimum === null ? '—' : formatQuantity(s.minimum)} · target {s.target_level === null ? '—' : formatQuantity(s.target_level)}</span></span>
            <span className="flex items-center gap-2">
                <Tag size="sm" type={s.status === 'order_now' ? 'red' : 'warm-gray'}>{s.status === 'order_now' ? 'Order now' : 'Order soon'}</Tag>
                {s.order !== null
                    ? <strong className="text-base">Order {formatQuantity(s.order)} {s.unit}</strong>
                    : <span className="text-text-2">Target level missing</span>}
            </span>
        </div>
        <span className="text-xs text-text-2">{s.why}</span>
        <div><Button kind="ghost" size="sm" onClick={() => setEditing(e => !e)}>{editing ? 'Close' : s.order === null ? 'Set levels' : 'Change levels'}</Button></div>
        {editing && <LevelEditor product={{ id: s.id, unit: s.unit, minimum: s.minimum, target_level: s.target_level }} />}
    </li>
}

/** Any product, to set its levels even if it isn't on the order list. */
function SetLevels() {
    const [text, setText] = useState('')
    const [search, setSearch] = useState('')
    const [chosen, setChosen] = useState<Product | null>(null)
    useEffect(() => {
        const t = setTimeout(() => setSearch(text.trim()), 300)
        return () => clearTimeout(t)
    }, [text])
    const results = useQuery({
        queryKey: ['products', 'search', search],
        queryFn: fetchJson<{ products: Product[] }>(`/api/products?q=${encodeURIComponent(search)}`),
        enabled: search.length >= 2,
    })

    return <div className={`${CARD} flex flex-col gap-3`}>
        <h2 className="text-base font-semibold">Set levels</h2>
        {!chosen && <>
            <input className="h-10 w-full border bg-layer px-2" aria-label="Search product" placeholder="Search by code or name…" value={text} onChange={e => setText(e.target.value)} />
            {results.isFetching && <InlineLoading description="Searching…" />}
            {results.data && search.length >= 2 && <ul className="flex max-h-56 flex-col overflow-auto border border-border">
                {results.data.products.length === 0 && <li className="p-2 text-text-2">No product matches.</li>}
                {results.data.products.slice(0, 10).map(p => <li key={p.id}>
                    <button type="button" className="flex w-full justify-between gap-2 p-2 text-left hover:bg-background" onClick={() => setChosen(p)}>
                        <span className="min-w-0 truncate">{p.code} · {p.name}</span><span className="shrink-0 text-xs text-text-2">{p.unit}</span>
                    </button></li>)}
            </ul>}
        </>}
        {chosen && <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{chosen.code} · {chosen.name}</strong>
                <Button kind="ghost" size="sm" onClick={() => setChosen(null)}>Change</Button>
            </div>
            <span className="text-xs text-text-2">Current balance: {balanceKnown(chosen) ? `${formatQuantity(Number(chosen.quantity))} ${chosen.unit}` : '—'}</span>
            {chosen.control_type === 'no_balance'
                ? <InlineNotification kind="info" hideCloseButton title="No stock tracking" />
                : <LevelEditor key={chosen.id} product={{ id: chosen.id, unit: chosen.unit, minimum: chosen.minimum === null ? null : Number(chosen.minimum),
                    target_level: chosen.target_level == null ? null : Number(chosen.target_level) }} />}
        </div>}
    </div>
}

export function RequisitionScreen({ user }: { user: User }) {
    const [picking, setPicking] = useState(false)
    const q = useQuery({ queryKey: ['requisition'], queryFn: fetchJson<Requisition>('/api/requisition') })
    const [copied, setCopied] = useState(false)
    const r = q.data

    const noData = r ? REASON_ORDER.map(m => ({ m, n: r.summary.no_data[m] ?? 0 })).filter(x => x.n > 0) : []
    const totalNoData = noData.reduce((a, x) => a + x.n, 0)
    const evaluated = r ? r.summary.order_now + r.summary.order_soon + r.summary.up_to_date : 0
    const total = evaluated + totalNoData
    const withQuantity = r?.order.filter(s => s.order !== null) ?? []

    async function copy() {
        const lines = withQuantity.map(s => `${s.code} · ${s.name} — order ${formatQuantity(s.order!)} ${s.unit}`)
        try { await navigator.clipboard.writeText(lines.join('\n')); setCopied(true); setTimeout(() => setCopied(false), 2500) } catch { /* no clipboard: the list is still on screen */ }
    }

    return <section className="page flex flex-col gap-4">
        <div className="page-heading">
            <div><h1>Requisition</h1></div>
        </div>

        {q.isLoading && <InlineLoading description="Loading…" />}
        {q.error && !r && <InlineNotification kind="error" title="Could not calculate the requisition" subtitle={errorMessage(q.error)} hideCloseButton />}

        {r && <>
            <div className={`${CARD} flex flex-col gap-3`}>
                <p className="text-base">
                    <strong>{evaluated} of {total}</strong> evaluated
                </p>
                {noData.length > 0 && <div className="grid gap-3 sm:grid-cols-2">
                    {noData.map(({ m, n }) => <div key={m} className="flex flex-col gap-1 rounded-lg bg-background p-3 text-sm">
                        <strong>{n} · {NO_DATA[m].title}</strong>
                        {NO_DATA[m].action && <Link to={NO_DATA[m].action!.to}>{NO_DATA[m].action!.text}</Link>}
                        {m === 'no_stock_tracking' && user.role === 'admin' && (
                            <div><Button kind="tertiary" size="sm" onClick={() => setPicking(v => !v)}>{picking ? 'Close' : 'Enable stock tracking'}</Button></div>
                        )}
                    </div>)}
                </div>}
            </div>

            {picking && user.role === 'admin' && <div className={CARD}><PickWithStock /></div>}

            <div className="grid gap-3 sm:grid-cols-3">
                {([['Order now', r.summary.order_now], ['Order soon', r.summary.order_soon], ['Up to date', r.summary.up_to_date]] as const).map(([title, n]) =>
                    <article key={title} className={CARD}>
                        <p className="text-sm text-text-2">{title}</p>
                        <p className="text-2xl font-semibold">{n}</p>
                    </article>)}
            </div>

            {r.order.length > 0 && <div className={CARD}>
                <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                    <h2 className="text-base font-semibold">To order ({r.order.length})</h2>
                    {withQuantity.length > 0 && <Button kind="tertiary" size="sm" onClick={() => void copy()}>{copied ? 'Copied' : `Copy list (${withQuantity.length})`}</Button>}
                </div>
                <ul className="flex flex-col divide-y divide-border">{r.order.map(s => <Row key={s.id} s={s} />)}</ul>
            </div>}
        </>}

        <SetLevels />
    </section>
}
