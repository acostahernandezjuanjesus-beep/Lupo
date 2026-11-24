// Pure logic for the stock-count control in the inventory table (StockControl).
// Quantities travel as text: what the person types is what gets validated and sent.

import { WHOLE_UNITS } from './newProduct'

const round = (n: number) => Math.round(n * 1000) / 1000

/**
 * The value after stepping up (1) or down (-1). Never goes below zero. With no value (uncounted
 * product), up starts at 1 and down at 0: zero is a count the person makes on purpose.
 */
export function adjust(current: string, direction: 1 | -1, unit: string): string {
    const n = Number(current.trim())
    if (current.trim() === '' || !Number.isFinite(n)) return direction === 1 ? '1' : '0'
    const base = WHOLE_UNITS.includes(unit) ? Math.round(n) : n
    return String(Math.max(0, round(base + direction)))
}

/** The difference against the balance, signed ("+3", "−2"); null if there's none or no balance to compare. */
export function difference(balance: number | null, draft: string): string | null {
    const n = Number(draft.trim())
    if (balance === null || draft.trim() === '' || !Number.isFinite(n)) return null
    const d = round(n - balance)
    return d === 0 ? null : `${d > 0 ? '+' : '−'}${Math.abs(d)}`
}
