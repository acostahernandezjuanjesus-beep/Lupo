// What to reorder and why, computed in code so the numbers are readable and testable. Min-max method:
// order up to `target_level` once `quantity` drops to `minimum`. Thresholds match `levelSql` and the client's level
// helper, otherwise the dashboard and this list would disagree about the same product.
//
// Never invent a zero: when the balance means nothing (not counted, or a product that doesn't track stock)
// there is no suggestion, only a 'no_data' status with a reason.

const REORDER_MARGIN = 0.25;                       // same as the client's level helper
const WHOLE_UNITS = ['piece', 'box', 'pack', 'pair'];

/** 50 -> "50", 12.5 -> "12.5". Up to 3 decimals, no trailing zeros. */
const num = n => String(Number(Number(n).toFixed(3)));

/**
 * `status`: 'order_now' (quantity <= minimum), 'order_soon' (quantity <= minimum x 1.25), 'up_to_date',
 * or 'no_data' (balance says nothing, `reason` explains). `order` is how much to order, or null.
 */
function suggestOrder(p) {
    const unit = p.unit || 'piece';
    const none = (reason, why) => ({ status: 'no_data', reason, order: null, unit, why });

    // first on purpose: products that don't track stock are the ones with the most flow
    if (p.control_type === 'no_balance') {
        return none('no_stock_tracking', 'Stock is not tracked: there is no way yet to know when to reorder it.');
    }
    if (p.count_pending) {
        return none('not_counted', 'Nobody has counted it: the quantity on hand is unknown.');
    }
    const quantity = Number(p.quantity);
    const minimum = p.minimum === null || p.minimum === undefined ? null : Number(p.minimum);
    if (minimum === null || !Number.isFinite(minimum)) {
        return none('no_minimum', 'No minimum set: nothing to measure when to reorder against.');
    }
    if (!Number.isFinite(quantity)) return none('not_counted', 'The balance is not a number.');

    const target = p.target_level === null || p.target_level === undefined ? null : Number(p.target_level);
    const status = quantity <= minimum ? 'order_now'
        : quantity <= minimum * (1 + REORDER_MARGIN) ? 'order_soon' : 'up_to_date';

    const have = `There are ${num(quantity)} ${unit}; the minimum is ${num(minimum)}`;

    if (status === 'up_to_date') {
        return { status, reason: null, order: null, unit,
            why: `${have}. It is above the reorder point (${num(minimum * (1 + REORDER_MARGIN))}).` };
    }
    if (target === null || !Number.isFinite(target)) {
        return { status, reason: 'no_target', order: null, unit,
            why: `${have}. Set a target level to know how much to order.` };
    }
    if (target <= minimum) {
        // a target that doesn't exceed the minimum leaves nothing to order: bad data
        return none('invalid_target', `The target level (${num(target)}) does not exceed the minimum (${num(minimum)}): check which one is wrong.`);
    }

    let order = Math.max(target - quantity, 0);
    // half a pair of gloves can't be bought: round up to whole units
    order = WHOLE_UNITS.includes(unit) ? Math.ceil(order) : Number(order.toFixed(3));
    return { status, reason: null, order, unit,
        why: `${have} and the target level is ${num(target)}. Order ${num(order)} ${unit} to reach ${num(target)}.` };
}

const STATUS_ORDER = { order_now: 0, order_soon: 1, up_to_date: 2, no_data: 3 };

/**
 * Suggestions for a product list, most urgent first. 'no_data' products are only counted by reason, not listed:
 * listing them would drown the alert.
 */
function requisition(products) {
    const summary = { order_now: 0, order_soon: 0, up_to_date: 0, no_data: {} };
    const order = [];
    for (const p of products) {
        const s = suggestOrder(p);
        if (s.status === 'no_data') {
            summary.no_data[s.reason] = (summary.no_data[s.reason] ?? 0) + 1;
        } else {
            summary[s.status]++;
            // minimum and target_level go on every row so they can be fixed in place (null = never set)
            if (s.status !== 'up_to_date') order.push({ id: p.id, code: p.code, name: p.name, quantity: Number(p.quantity),
                minimum: p.minimum ?? null, target_level: p.target_level ?? null, ...s });
        }
    }
    order.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.code.localeCompare(b.code));
    return { order, summary };
}

module.exports = { suggestOrder, requisition, REORDER_MARGIN };
