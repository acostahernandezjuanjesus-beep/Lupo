// Pure functions over `purchases` rows (type 'purchase', with a date), so they run without a database.
// Prices are compared between purchases with the exact same description, not the same linked product:
// one product can group different sizes and comparing those would invent price changes.

const DAY = 86400000;
const MIN_CHANGE = 0.02;        // under 2% is rounding or a discount

const toMoney = n => n.toFixed(2);
const timeOf = date => Date.parse(`${date}T12:00:00Z`);

/** The `n` most recent purchases. A purchase is one folio from one supplier on one date; its lines are summed. */
function latestPurchases(rows, n = 5) {
    const purchases = new Map();
    for (const r of rows) {
        // no folio means no way to group lines, so each one counts alone
        const k = r.folio === null ? `no-folio-${r.id}` : `${r.supplier}\u0001${r.folio}\u0001${r.date}`;
        const p = purchases.get(k) ?? { date: r.date, folio: r.folio, supplier: r.supplier, amount: 0, lines: 0, id: 0 };
        p.amount += Number(r.amount ?? 0);
        p.lines += 1;
        p.id = Math.max(p.id, r.id);
        purchases.set(k, p);
    }
    return [...purchases.values()]
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
        .slice(0, n)
        .map(p => ({ date: p.date, folio: p.folio, supplier: p.supplier, lines: p.lines, amount: toMoney(p.amount) }));
}

/**
 * Price changes between the last and the previous purchase of a description, newest first. Only purchases within
 * `days` of the latest date on record count (not of today, so the last known data still shows if nobody imports).
 */
function priceChanges(rows, { n = 5, days = 45, today = new Date() } = {}) {
    const cap = today.toISOString().slice(0, 10);
    const priced = rows.filter(r => Number(r.unit_price) > 0 && r.date <= cap);
    if (priced.length === 0) return [];
    const latestDate = priced.reduce((m, r) => r.date > m ? r.date : m, '');
    const since = timeOf(latestDate) - days * DAY;

    const byDescription = new Map();
    for (const r of priced) {
        if (!byDescription.has(r.description_norm)) byDescription.set(r.description_norm, []);
        byDescription.get(r.description_norm).push(r);
    }

    const changes = [];
    for (const purchases of byDescription.values()) {
        purchases.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
        // same item twice in one folio and date: the last line wins
        const events = new Map();
        for (const r of purchases) events.set(`${r.date}\u0001${r.folio ?? `id${r.id}`}`, r);
        const [previous, latest] = [...events.values()].slice(-2);
        if (!previous || !latest || timeOf(latest.date) < since) continue;
        const change = (Number(latest.unit_price) - Number(previous.unit_price)) / Number(previous.unit_price);
        if (Math.abs(change) < MIN_CHANGE) continue;
        const side = r => ({ price: String(Number(r.unit_price)), date: r.date, supplier: r.supplier });
        changes.push({
            name: latest.product ?? latest.description, code: latest.code ?? null,
            previous: side(previous), latest: side(latest), change: Math.round(change * 1000) / 10,
        });
    }
    return changes
        .sort((a, b) => b.latest.date.localeCompare(a.latest.date) || Math.abs(b.change) - Math.abs(a.change))
        .slice(0, n);
}

module.exports = { latestPurchases, priceChanges };
