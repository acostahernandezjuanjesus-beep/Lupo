// What GET /api/requisition returns.

export type Suggestion = {
    id: number
    code: string
    name: string
    quantity: number
    minimum: number | null
    target_level: number | null
    status: 'order_now' | 'order_soon'
    /** Why there's no quantity to order (today only 'no_target'); null when there is one. */
    reason: string | null
    order: number | null
    unit: string
    why: string
}

export type NoDataReason = 'no_stock_tracking' | 'not_counted' | 'no_minimum' | 'invalid_target'

export type Requisition = {
    order: Suggestion[]
    summary: {
        order_now: number
        order_soon: number
        up_to_date: number
        no_data: Partial<Record<NoDataReason, number>>
    }
}
