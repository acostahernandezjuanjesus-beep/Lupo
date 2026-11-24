// When a purchases month counts as "high". A month total alone doesn't say whether too much was
// bought, so:
// 1. Incomplete books are left out of the median: a book is incomplete if its first purchase is
//    after day 10 or its last is before day 20.
// 2. High = more than 30% above the median of the complete ones. A starting point to tune, not statistics.
// Median and not mean: one equipment purchase would move the mean.

export const HIGH_MARGIN = 0.3;

type SeriesMonth = { period: string; amount: string | null; first_date: string | null; last_date: string | null };

const dayOf = (date: string | null) => date === null ? null : Number(date.slice(8, 10));

/** The book doesn't cover the whole month: starts after the 10th or ends before the 20th. */
export function bookIncomplete(m: SeriesMonth): boolean {
    const first = dayOf(m.first_date), last = dayOf(m.last_date);
    // The last date can fall in the next month (June's book runs to July 3rd): that's a book that
    // extends, not a short one.
    const lastSameMonth = m.last_date !== null && m.last_date.slice(0, 7) === m.period;
    return first === null || first > 10 || (lastSameMonth && last !== null && last < 20);
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const o = [...values].sort((a, b) => a - b), m = Math.floor(o.length / 2);
    return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

/** The median of the complete months and the "high" threshold. null if there's no complete month: no base, no flag. */
export function highThreshold(series: SeriesMonth[]): { median: number; threshold: number; complete: number } | null {
    const complete = series.filter(m => !bookIncomplete(m)).map(m => Number(m.amount ?? 0));
    const med = median(complete);
    return med === null ? null : { median: med, threshold: med * (1 + HIGH_MARGIN), complete: complete.length };
}
