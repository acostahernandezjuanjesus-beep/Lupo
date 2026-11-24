import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Button, InlineLoading, InlineNotification, Search, Tag } from '@carbon/react'
import { Add } from '@carbon/icons-react'
import { fetchJson, errorMessage } from '../queries'
import { money, shortDate } from '../money'
import { PURCHASE_TYPE_LABEL, localToday, type InvoiceGroup, type InvoiceFacets, type Invoice, type InvoicesResponse } from '../invoices/types'
import { InvoiceModal } from './invoices/InvoiceModal'
import { NewInvoiceModal } from './invoices/NewInvoiceModal'
import { Pagination } from './Pagination'

// Search and filters live in the URL, so reloading or sharing the link keeps what you were looking at and
// "back" works. The categories are set by the server when capturing and are used here as filters with their
// count. "No project" and "No category" are real categories: an unclassified invoice must not vanish from the filters.

const CARD = 'rounded-2xl bg-layer p-4 md:p-5 min-w-0'

const FILTERS = ['status', 'supplier', 'month', 'spend_category', 'project', 'purchase_type'] as const
type Filter = typeof FILTERS[number]

const STATUS_LABEL: Record<string, string> = { to_pay: 'To pay', overdue: 'Overdue', paid: 'Paid' }

function Group({ title, filter, items, current, onPick }: {
    title: string; filter: Filter; items: InvoiceGroup[]; current: string | null; onPick: (f: Filter, v: string | null) => void
}) {
    if (items.length === 0) return null
    return <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-2">{title}</span>
        <div className="flex flex-wrap gap-1.5">
            {items.map(c => <Tag key={c.key} size="md" type={current === c.key ? 'blue' : 'outline'}
                onClick={() => onPick(filter, current === c.key ? null : c.key)} className="cursor-pointer" role="button"
                title={c.amount ? `${c.invoices} invoices, ${money(c.amount)}` : undefined}>
                {c.name} · {c.invoices}</Tag>)}
        </div>
    </div>
}

function Row({ f, onOpen }: { f: Invoice; onOpen: () => void }) {
    const today = localToday()
    const overdue = !f.paid_at && !!f.due_on && f.due_on.slice(0, 10) < today
    return <li>
        <button type="button" onClick={onOpen} className="flex w-full min-w-0 flex-col gap-1 py-3 text-left hover:bg-background md:flex-row md:items-center md:gap-4">
            <span className="min-w-0 flex-1">
                <strong className="block truncate">{f.issuer_name ?? f.issuer_rfc ?? '(no issuer)'}</strong>
                <span className="text-sm text-text-2">{f.series ?? ''}{f.folio ? `-${f.folio}` : ''} · {shortDate(f.invoice_date?.slice(0, 10) ?? null)}{f.project ? ` · ${f.project}` : ''}</span>
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
                {f.spend_category && <Tag size="sm" type="blue">{f.spend_category}</Tag>}
                {f.purchase_type !== 'unclassified' && <Tag size="sm" type="gray">{PURCHASE_TYPE_LABEL[f.purchase_type]}</Tag>}
                {f.lines_total > 0 && f.lines_reconciled < f.lines_total && <Tag size="sm" type="warm-gray" title="Lines linked to inventory">{f.lines_reconciled}/{f.lines_total} reconciled</Tag>}
                {f.paid_at ? <Tag size="sm" type="green">Paid</Tag> : overdue ? <Tag size="sm" type="red">Overdue</Tag> : null}
            </span>
            <strong className="md:w-32 md:text-right">{money(f.total)}</strong>
        </button>
    </li>
}

export function InvoicesScreen() {
    const [params, setParams] = useSearchParams()
    const q = params.get('q') ?? ''
    const page = Math.max(1, Number(params.get('page')) || 1)
    const [text, setText] = useState(q)
    const [creating, setCreating] = useState(false)
    const open = Number(params.get('open')) || null

    // The search goes out when typing pauses, not on every letter.
    useEffect(() => {
        if (text === q) return
        const t = setTimeout(() => setParams(p => { const n = new URLSearchParams(p); if (text) n.set('q', text); else n.delete('q'); n.delete('page'); return n }, { replace: true }), 300)
        return () => clearTimeout(t)
    }, [text, q, setParams])

    const pick = (f: Filter, v: string | null) => setParams(p => { const n = new URLSearchParams(p); if (v) n.set(f, v); else n.delete(f); n.delete('page'); return n })
    const active = FILTERS.filter(f => params.get(f))
    const queryParams = new URLSearchParams(params)
    queryParams.delete('open')
    const qs = queryParams.toString()
    const url = `/api/invoices${qs ? `?${qs}` : ''}`

    const list = useQuery({ queryKey: ['invoices', 'list', qs], queryFn: fetchJson<InvoicesResponse>(url), placeholderData: keepPreviousData })
    const facets = useQuery({ queryKey: ['invoices', 'categories'], queryFn: fetchJson<InvoiceFacets>('/api/invoices/categories') })

    const r = list.data
    const c = facets.data

    return <section className="page flex flex-col gap-4">
        <div className="page-heading">
            <div><h1>Invoices</h1></div>
            <Button renderIcon={Add} onClick={() => setCreating(true)}>New invoice</Button>
        </div>

        {r && <div className="grid gap-3 sm:grid-cols-2">
            <article className={CARD}>
                <p className="text-sm text-text-2">To pay</p>
                <p className="text-2xl font-semibold">{r.summary.to_pay_amount ? money(r.summary.to_pay_amount) : '—'}</p>
                <p className="text-sm text-text-2">{r.summary.to_pay} invoices</p>
            </article>
            <article className={CARD}>
                <p className="text-sm text-text-2">Overdue</p>
                <p className="text-2xl font-semibold" style={r.summary.overdue ? { color: 'var(--chart-alert)' } : undefined}>{r.summary.overdue_amount ? money(r.summary.overdue_amount) : '—'}</p>
                <p className="text-sm text-text-2">{r.summary.overdue} {r.summary.overdue === 1 ? 'invoice' : 'invoices'}</p>
            </article>
        </div>}

        <div className={`${CARD} flex flex-col gap-3`}>
            <Search size="lg" labelText="Search invoices" placeholder="Supplier, folio, UUID, line, project, amount…" value={text}
                onChange={e => setText(e.target.value)} onClear={() => setText('')} />
            {c && <>
                <Group title="Status" filter="status" current={params.get('status')} onPick={pick}
                    items={(['to_pay', 'overdue', 'paid'] as const).map(k => ({ key: k, name: STATUS_LABEL[k], invoices: c.statuses[k], amount: null }))} />
                <Group title="Supplier" filter="supplier" items={c.suppliers} current={params.get('supplier')} onPick={pick} />
                <Group title="Month" filter="month" items={c.months} current={params.get('month')} onPick={pick} />
                <Group title="Category" filter="spend_category" items={c.spend_categories} current={params.get('spend_category')} onPick={pick} />
                <Group title="Project" filter="project" items={c.projects} current={params.get('project')} onPick={pick} />
                <Group title="Purchase type" filter="purchase_type" items={c.types.map(t => ({ ...t, name: PURCHASE_TYPE_LABEL[t.key as keyof typeof PURCHASE_TYPE_LABEL] ?? t.name }))} current={params.get('purchase_type')} onPick={pick} />
            </>}
            {(active.length > 0 || q) && <div><Button kind="ghost" size="sm" onClick={() => { setText(''); setParams({}) }}>Clear all filters</Button></div>}
        </div>

        <div className={CARD}>
            {list.error && !r && <InlineNotification kind="error" title="Could not load the invoices" subtitle={errorMessage(list.error)} hideCloseButton />}
            {!r && !list.error && <InlineLoading description="Loading the invoices…" />}
            {r && r.total === 0 && <p className="py-6 text-center text-text-2">{active.length || q
                ? 'No invoice matches this search.'
                : 'No invoices yet.'}</p>}
            {r && r.total > 0 && <>
                <p className="pb-2 text-sm text-text-2">{r.total} {r.total === 1 ? 'invoice' : 'invoices'}{list.isFetching ? ' · updating…' : ''}</p>
                <ul className="flex flex-col divide-y divide-border">
                    {r.invoices.map(f => <Row key={f.id} f={f} onOpen={() => setParams(p => { const n = new URLSearchParams(p); n.set('open', String(f.id)); return n })} />)}
                </ul>
                <Pagination total={r.total} page={page} disabled={list.isFetching} onChange={n => setParams(p => { const s = new URLSearchParams(p); s.set('page', String(n)); return s })} />
            </>}
        </div>

        <NewInvoiceModal open={creating} onClose={() => setCreating(false)} />
        <InvoiceModal id={open} onClose={() => setParams(p => { const n = new URLSearchParams(p); n.delete('open'); return n })} />
    </section>
}
