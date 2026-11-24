import { ApiError } from '../api';
import { money } from '../money';
import type { DescriptionLinkedError, LinkResponse } from './types';

// The text shown when linking a description, wherever it comes from (Bring to catalog modal or the
// suggestion button), so both give the same numbers.

/** What the parent shows when everything went fine. */
export type Notice = { title: string; detail: string };

/** "N lines ($X) were linked to CODE". Lines of all books, not just the period: the link is by description. */
export function linkedLines(purchases: number, amount: string | null, code: string) {
    return purchases === 1
        ? `1 line (${money(amount)}) was linked to ${code}`
        : `${purchases} lines (${money(amount)}) were linked to ${code}`;
}

/** If it was already linked, say nothing changed: saying "now" would be false. */
export function linkNotice(r: LinkResponse): Notice {
    return r.already_linked
        ? {
            title: `Already linked to ${r.product.code}`,
            detail: `${linkedLines(r.purchases, r.amount, r.product.code)}. Nothing was changed.`,
        }
        : {
            title: linkedLines(r.purchases, r.amount, r.product.code),
            detail: `${r.product.code} — ${r.product.name}. The link applies to all books, not just the period you're viewing.`,
        };
}

/** The item a description clashes with when someone else already linked it (409), if the server said which. */
export function clashesWith(e: unknown): { code: string; name: string } | null {
    if (!(e instanceof ApiError) || e.status !== 409) return null;
    const body = typeof e.body === 'object' && e.body !== null
        ? e.body as Partial<DescriptionLinkedError>
        : {};
    return body.error_code === 'description_linked' && body.product ? body.product : null;
}
