const INTEGERS = new Intl.NumberFormat('en-US');

/**
 * A PostgreSQL numeric (as text) as $ with two decimals (the symbol, not a currency claim). Rounds with BigInt because
 * going through Number can lose cents. Sums happen in PostgreSQL, not here.
 */
export function money(value: string | null): string {
    if (value === null) return '—';
    const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
        + (fraction[2] >= '5' ? 1n : 0n);
    return `${value.startsWith('-') ? '-' : ''}$${INTEGERS.format(cents / 100n)}.${String(cents % 100n).padStart(2, '0')}`;
}

/**
 * A unit price: like `money` but keeps the third decimal. Books have prices like 0.258, and
 * showing $0.26 next to an amount of $25.80 would make the multiplication look wrong.
 */
export function unitPriceText(value: string | null): string {
    if (value === null) return '—';
    const dot = value.indexOf('.');
    const thousandths = dot === -1 ? '' : value.slice(dot + 3).replace(/0+$/, '');
    return thousandths ? `${money(value.slice(0, dot + 3))}${thousandths}` : money(value);
}

/** A numeric text rounded to cents, no symbol ('0.258' → '0.26'). The catalog price column only takes 2 decimals. */
export function toCents(value: string): string {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
    const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
        + (fraction[2] >= '5' ? 1n : 0n);
    return `${negative ? '-' : ''}${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** A numeric as a quantity, without padding zeros ('5.000' → '5', '2.500' → '2.5'). */
export function quantityText(value: string | null): string {
    if (value === null) return '—';
    if (!value.includes('.')) return value;
    return value.replace(/0+$/, '').replace(/\.$/, '');
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY'. Skips Date so the time zone can't shift the day. */
export const shortDate = (value: string | null) => value === null ? '—' : value.split('-').reverse().join('/');

const MONTHS = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** 'YYYY-MM' → 'August 2025'. */
export const longMonth = (period: string) => MONTHS.format(new Date(`${period}-01T12:00:00Z`));

const SHORT_MONTHS = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** 'YYYY-MM' → 'Aug 2025'. */
export const shortMonth = (period: string) => SHORT_MONTHS.format(new Date(`${period}-01T12:00:00Z`)).replace('.', '');

/** Percentage of a part over a total, both numeric text; null if it can't be computed. */
export function percentage(part: string | null, total: string | null): number | null {
    if (part === null || total === null) return null;
    const t = Number(total);
    if (!Number.isFinite(t) || t === 0) return null;
    return (Number(part) / t) * 100;
}
