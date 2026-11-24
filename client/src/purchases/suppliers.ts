import { useMutation, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '../api'
import type { SupplierAlias, SupplierSummary } from './types'

// What the Suppliers screen shares between its pieces.

export const rowKey = (p: SupplierSummary) => p.id === null ? `text:${p.name}` : `id:${p.id}`

export const detailUrl = (p: SupplierSummary) =>
    `/api/suppliers/detail?${p.id === null ? `text=${encodeURIComponent(p.name)}` : `id=${p.id}`}`

/** Link to that supplier's lines in Purchases (the server filters by id or by the exact text). */
export const purchasesLink = (p: SupplierSummary) =>
    `/purchases?${new URLSearchParams({ supplier: p.name, ...(p.id === null ? {} : { supplier_id: String(p.id) }) })}`

export const plural = (n: number, one: string, many: string) => n === 1 ? `1 ${one}` : `${n.toLocaleString('en-US')} ${many}`

export const linesText = (n: number) => plural(n, 'line', 'lines')

export const ALIAS_ORIGIN_LABEL: Record<SupplierAlias['origin'], string> = {
    manual: 'Written by hand',
    equivalence: 'Chosen when linking a purchase',
    rename: 'Previous name',
    merge: 'From a merged supplier',
}

/** What a write linked without anyone asking line by line, in one sentence. */
export function linkedSummary(linked: { purchases: number; invoices: number } | number | undefined): string | null {
    if (linked === undefined) return null
    const purchases = typeof linked === 'number' ? linked : linked.purchases
    const invoices = typeof linked === 'number' ? 0 : linked.invoices
    const parts = [purchases > 0 && linesText(purchases), invoices > 0 && plural(invoices, 'invoice', 'invoices')].filter(Boolean)
    return parts.length ? `Linked ${parts.join(' and ')}.` : null
}

type Write = { path: string; method?: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown }

/**
 * Any change to a supplier. It changes who owns lines and invoices, so the list, the book reader,
 * the dashboard and invoices are refetched.
 */
export function useWriteSupplier<T = unknown>() {
    const client = useQueryClient()
    return useMutation({
        mutationFn: ({ path, method = 'POST', body }: Write) => requestJson<T>(`/api/suppliers${path}`, {
            method,
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        }),
        onSuccess: () => Promise.all(['suppliers', 'purchases', 'invoices'].map(k => client.invalidateQueries({ queryKey: [k] }))),
    })
}

// Tag and phone limits; the server and the database say the same.
export const MAX_TAGS = 8
export const MAX_TAG_LENGTH = 30
export const MAX_PHONES = 5

/** How to name a contact on a button or notice: by the first thing it has. */
export const contactName = (c: { name: string | null; phones: string[]; email: string | null; address: string | null }) =>
    c.name ?? c.phones[0] ?? c.email ?? c.address ?? ''

/**
 * The number the phone dials: only what comes before any text ("871 333 4444 ext. 12" dials 8713334444;
 * gluing the extension on would dial another number). null if it doesn't start with a number: shown without a link.
 */
export function dialNumber(phone: string): string | null {
    const number = (/^[+\d\s().-]+/.exec(phone)?.[0] ?? '').replace(/[^\d+]/g, '')
    return number.length >= 3 ? number : null
}

export type SupplierSort = { by: 'name' | 'lines' | 'amount' | 'last_date'; direction: 'ASC' | 'DESC' }

/** The list in the requested order. Whatever lacks the value (no amount, no date) always goes last, up or down. */
export function sortSuppliers(suppliers: SupplierSummary[], sort: SupplierSort | null): SupplierSummary[] {
    if (sort === null) return suppliers   // as the server sends it: most purchased to least
    const sign = sort.direction === 'ASC' ? 1 : -1
    const value = (p: SupplierSummary) => sort.by === 'name' ? p.name
        : sort.by === 'lines' ? (p.lines === 0 ? null : p.lines)
            : sort.by === 'amount' ? (p.amount === null ? null : Number(p.amount)) : p.last_date
    return [...suppliers].sort((a, b) => {
        const x = value(a), y = value(b)
        if (x === null || y === null) return (x === null ? 1 : 0) - (y === null ? 1 : 0) || a.name.localeCompare(b.name, 'en')
        const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { sensitivity: 'base' })
        return d * sign || a.name.localeCompare(b.name, 'en')
    })
}

const TAG_COLORS = ['blue', 'teal', 'purple', 'cyan', 'green', 'magenta', 'warm-gray', 'cool-gray'] as const

/** A tag's colour comes from its name: the same tag always looks the same, nobody picks it. */
export function tagColor(tag: string): typeof TAG_COLORS[number] {
    let sum = 0
    for (const letter of tag.toLowerCase()) sum = (sum * 31 + letter.codePointAt(0)!) % 9973
    return TAG_COLORS[sum % TAG_COLORS.length]
}

/** The tags any supplier in the list carries, with how many carry each, alphabetical. */
export function tagsInUse(suppliers: SupplierSummary[]): { tag: string; suppliers: number }[] {
    const count = new Map<string, number>()
    for (const p of suppliers) for (const t of p.tags ?? []) count.set(t, (count.get(t) ?? 0) + 1)
    return [...count].map(([tag, n]) => ({ tag, suppliers: n })).sort((a, b) => a.tag.localeCompare(b.tag, 'en'))
}
