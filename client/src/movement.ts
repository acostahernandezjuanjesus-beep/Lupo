import type { Product } from './types'
import { formatQuantity, balanceKnown } from './level'

// What the Record movement screen knows, without React: the five types, their quick reasons and the
// sentence that says what is about to be recorded.

export type MovementType = 'out' | 'loan' | 'in' | 'return' | 'adjustment'

type TypeDefinition = {
    type: MovementType
    title: string
    /** One line saying when it's used, in floor language. */
    hint: string
    /** Which way it moves the balance; an adjustment SETS it to what was counted. */
    sign: -1 | 0 | 1
    /** The "who" question: null for an adjustment, which is done by whoever counts. */
    question: string | null
    /** How the summary sentence says it, with the person's name. */
    who: ((person: string) => string) | null
}

// No type is preselected on purpose: a preselected one becomes the one nobody looks at,
// and an "in" recorded as an "out" throws the balance off silently.
export const TYPES: readonly TypeDefinition[] = [
    { type: 'out', title: 'Out', hint: 'Taken away', sign: -1, question: 'Who is taking it?', who: p => `Taken by ${p}` },
    { type: 'loan', title: 'Loan', hint: 'Leaves and must come back', sign: -1, question: 'Who is borrowing it?', who: p => `Borrowed by ${p}` },
    { type: 'in', title: 'In', hint: 'Material arrived', sign: 1, question: 'Who is delivering it?', who: p => `Delivered by ${p}` },
    { type: 'return', title: 'Return', hint: 'Loaned item is back', sign: 1, question: 'Who is returning it?', who: p => `Returned by ${p}` },
    { type: 'adjustment', title: 'Adjustment', hint: "I counted and it doesn't match", sign: 0, question: null, who: null },
]

export const definitionOf = (type: MovementType): TypeDefinition => TYPES.find(t => t.type === type)!

// Shortcuts for the note (typing with gloves is the slowest part). They only fill in the free-text note.
export const REASONS: Record<MovementType, readonly string[]> = {
    out: ['For a work order', 'Shift consumption', 'Tool replacement', 'Damaged or lost'],
    loan: ['For a job site', 'To another shift', 'To another shop'],
    in: ['A purchase arrived', 'Leftover material', 'Gas refill'],
    return: ['Returned complete', 'Returned damaged', 'Returned with a shortfall'],
    adjustment: ['Monthly count', 'Count for a shortage', 'Material found'],
}

const PLURAL: Record<string, string> = { piece: 'pieces', pair: 'pairs', box: 'boxes', pack: 'packs', meter: 'meters', liter: 'liters', kg: 'kg' }

/** "1 piece", "3 pieces", "2.5 kg". */
export function quantityWithUnit(n: number, unit: string): string {
    const u = n === 1 ? unit : (PLURAL[unit] ?? unit)
    return `${formatQuantity(n)} ${u}`
}

export type SummaryInput = {
    type: MovementType
    product: Pick<Product, 'unit' | 'quantity' | 'count_pending' | 'control_type'>
    /** null = no valid quantity yet. */
    quantity: number | null
    /** Who takes / delivers / returns it; null = not chosen. */
    responsible: string | null
    /** Whoever runs the system: the movement is always recorded under their name. */
    operator: string
}

export type MovementSummary = {
    /** "Out: 3 pieces" */
    action: string
    /** "Will be 12 pieces", or why there's no number. null until there's a quantity. */
    result: string | null
    /** The resulting balance is negative: it's recorded, but flagged. */
    negative: boolean
    /** "Taken by Ana"; null for an adjustment, or until someone is chosen. */
    who: string | null
    recordedBy: string
}

/**
 * The sentence for what's about to be recorded. If the starting balance means nothing (uncounted, or
 * not stock-tracked) it does NOT compute a "will be −3": it says why there's no number. An adjustment
 * does have a resulting balance, since whoever counts sets it.
 */
export function movementSummary(e: SummaryInput): MovementSummary {
    const def = definitionOf(e.type)
    const hasQuantity = e.quantity !== null && Number.isFinite(e.quantity)
    const action = !hasQuantity
        ? def.title
        : e.type === 'adjustment' ? `Count: ${quantityWithUnit(e.quantity!, e.product.unit)}` : `${def.title}: ${quantityWithUnit(e.quantity!, e.product.unit)}`

    let result: string | null = null
    let negative = false
    if (hasQuantity) {
        if (e.type === 'adjustment') {
            result = e.product.control_type === 'no_balance'
                ? 'It will start tracking stock, using your count'
                : `Will be ${quantityWithUnit(e.quantity!, e.product.unit)}`
        } else if (e.product.control_type === 'no_balance') {
            result = 'Not stock-tracked: it is logged without changing a balance'
        } else if (!balanceKnown(e.product)) {
            result = 'Not counted: the balance is unknown until someone counts it'
        } else {
            const resulting = e.product.quantity + def.sign * e.quantity!
            negative = resulting < 0
            result = `Will be ${quantityWithUnit(resulting, e.product.unit)}`
        }
    }

    return {
        action, result, negative,
        who: def.who && e.responsible ? def.who(e.responsible) : null,
        recordedBy: `Recorded by ${e.operator}`,
    }
}
