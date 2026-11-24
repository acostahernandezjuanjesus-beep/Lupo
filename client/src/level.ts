import type { Product } from './types'
import { stockLevel } from './theme'

// The stock scale lives here because the table, the product card and the movement screen must agree.
// "Not counted" is its own state: a zero claims there is none, "not counted" admits nobody knows.

export type Level = 'ample' | 'restock' | 'below_min' | 'uncounted' | 'no_minimum'

// There is no reorder point column, so it's derived: the amber band starts this far above the minimum.
export const REORDER_MARGIN = 0.25

/** Background per level, shared by the table swatch and the dashboard chart. "No minimum" is hatched, not a colour. */
export const LEVEL_BACKGROUND: Record<Level, string> = {
    ample: stockLevel.ample,
    restock: stockLevel.restock,
    below_min: stockLevel.belowMin,
    uncounted: stockLevel.uncounted,
    no_minimum: stockLevel.noMin,
}

export type LevelState = {
    level: Level
    label: string
    /** Short version for the table, where people sweep 50 rows without reading. */
    short: string
    color: string | null      // null = this state has no colour
    /** Position on the bar, 0–1. null = no bar to draw. */
    proportion: number | null
    /** Where the minimum falls on the bar, 0–1. */
    minMark: number | null
}

export function levelStateOf(p: Product): LevelState {
    // What isn't known comes first: an uncounted product may have a minimum but we can't say if it's under it.
    if (p.count_pending) {
        return {
            level: 'uncounted',
            label: 'Not counted',
            short: 'Not counted',
            color: null,
            proportion: null,
            minMark: null,
        }
    }

    if (p.minimum === null) {
        // A no_balance item has no minimum because it isn't stock-tracked, not because one is missing.
        // Still counts as 'no_minimum' for filters and the dashboard.
        const untracked = p.control_type === 'no_balance'
        return {
            level: 'no_minimum',
            label: untracked ? 'Not stock-tracked' : 'No minimum set',
            short: untracked ? 'Untracked' : 'No min.',
            color: null,
            proportion: null,
            minMark: null,
        }
    }

    const minimum = p.minimum
    const reorder = minimum * (1 + REORDER_MARGIN)

    // The bar scales up to twice the minimum; without a cap, 400 pieces at minimum 2 would look like 3 at minimum 2.
    const cap = Math.max(minimum * 2, 1)
    const proportion = Math.max(0, Math.min(p.quantity / cap, 1))
    const minMark = Math.min(minimum / cap, 1)

    if (p.quantity <= minimum) {
        return {
            level: 'below_min',
            label: 'Below minimum',
            short: 'Below min.',
            color: stockLevel.belowMin,
            proportion,
            minMark,
        }
    }
    if (p.quantity <= reorder) {
        return {
            level: 'restock',
            label: 'Restock needed',
            short: 'Restock',
            color: stockLevel.restock,
            proportion,
            minMark,
        }
    }
    return {
        level: 'ample',
        label: 'Sufficient',
        short: 'Sufficient',
        color: stockLevel.ample,
        proportion,
        minMark,
    }
}

/** numeric(12,3) comes back as "12.000"; String(n) trims the zeros without rounding (kilos of electrode need decimals). */
export function formatQuantity(n: number): string {
    return String(n)
}

/**
 * Whether the balance is a fact we can show or compute a "will be" from. It isn't when the
 * product is uncounted (zero means "nobody counted") or when it's no_balance (the server still
 * moves its quantity, so a gas could read "−1").
 */
export function balanceKnown(p: Pick<Product, 'count_pending' | 'control_type'>): boolean {
    return !p.count_pending && p.control_type !== 'no_balance'
}
