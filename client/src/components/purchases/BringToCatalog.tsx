import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Button, ContentSwitcher, InlineLoading, InlineNotification, Modal, Switch, Tag, Tile, Toggle,
} from '@carbon/react';
import type {
    RecurringStatus, RecurringGroup, Month, LinkResponse, RecurringResponse, LinkSuggestion,
} from '../../purchases/types';
import { requestJson, ApiError } from '../../api';
import { fetchJson } from '../../queries';
import { money, shortDate, unitPriceText } from '../../money';
import { type Notice, linkNotice, clashesWith } from '../../purchases/link';
import { Pagination } from '../Pagination';
import { BringModal } from './BringModal';
import './bring.scss';

// Bring to catalog: what's bought often and the catalog doesn't know yet. Over half the book lines
// aren't linked to any item, so that money falls in no category and the dashboard can't say where
// it went. Not every line deserves an item (a part bought once needs no stock), hence the list
// starts from the recurring ones: what the warehouse will have to reorder.

const STATUSES: { value: RecurringStatus; text: string }[] = [
    { value: 'unlinked', text: 'Not linked' },
    // Unlinked ones that look like something in the catalog with the same measurements: the
    // shortcut to clear loose ends without searching.
    { value: 'with_suggestion', text: 'With suggestion' },
    { value: 'linked', text: 'Linked' },
    { value: 'all', text: 'All' },
];

/** Why that product is suggested, so a person can judge it: the compared text is in view. A suggestion without its why gets accepted blind. */
function reasonOf(s: LinkSuggestion) {
    const against = s.via === 'link' ? `"${s.text}", already linked to it` : 'its name in the catalog';
    const similarity = `${Math.round(s.similarity * 100)} % text similarity`;
    // "Same measurements" only if there were measurements to compare: two texts with no numbers would be an unchecked guarantee.
    return s.reason === 'same_form'
        ? `Same description as ${against}, written with different punctuation.`
        : `Looks like ${against}: ${s.has_numbers ? `same measurements, ${similarity}` : `${similarity}; neither has measurements`}.`;
}

/** The usual text of this screen, with its final period. */
const messageOf = (e: unknown) => e instanceof ApiError ? e.message : 'Could not connect to the API.';

/** Linking the last group of the last page makes that page disappear. The server repeats the requested page, so the response alone says whether this is one. */
const pageMissing = (d: RecurringResponse) =>
    d.groups.length === 0 && d.page > Math.max(1, d.pages);

const LINK_ORIGIN: Record<string, string> = {
    equivalence: 'Equivalence from the initial load.',
    manual: 'Linked from this screen.',
};

function dateRange(first: string | null, last: string | null) {
    if (first === null && last === null) return '—';
    if (first === last) return shortDate(first);
    return `${shortDate(first)} – ${shortDate(last)}`;
}

function countText(total: number, status: RecurringStatus, onlyRecurring: boolean) {
    const one = total === 1;
    const base = `${total} ${one ? 'description' : 'descriptions'}`;
    const which = status === 'unlinked' ? ' not linked'
        : status === 'with_suggestion' ? ' not linked, with a suggestion'
            : status === 'linked' ? ' linked' : '';
    return base + which + (onlyRecurring ? (one ? ' that meets the criterion' : ' that meet the criterion') : '');
}

function emptyText(status: RecurringStatus, onlyRecurring: boolean, months: number, minMonths: number | null) {
    // With fewer book months than the criterion asks, no description can be recurring. Saying
    // "none is unlinked" would be a reassuring zero that's false.
    if (onlyRecurring && minMonths !== null && months < minMonths) {
        return `The period has ${months} ${months === 1 ? 'month' : 'months'} of books and the criterion asks for ${minMonths}: `
            + 'no description can meet it. Widen the period or turn off "Only recurring".';
    }
    const what = onlyRecurring ? 'No recurring purchase in the period' : 'No purchase in the period';
    if (status === 'unlinked') return `${what} is unlinked.`;
    // Most suggestions are for purchases made only a few times; saying so avoids thinking there's nothing to link.
    if (status === 'with_suggestion') return onlyRecurring
        ? 'No unlinked recurring purchase has a suggestion. Turn off "Only recurring": most suggestions are for purchases made only a few times.'
        : 'No unlinked description in the period looks enough like something in the catalog, with the same measurements.';
    if (status === 'linked') return `${what} is linked to an item.`;
    return onlyRecurring ? 'No description in the period meets the criterion.' : 'No purchases in the period.';
}

export function BringToCatalog({ from, to, monthsWithBook }: {
    from: Month | null; to: Month | null;
    /** Distinct months with a book in the period; decides whether the recurrence criterion is reachable. */
    monthsWithBook: number;
}) {
    const period = `${from ?? ''}/${to ?? ''}`;
    const [status, setStatus] = useState<RecurringStatus>('unlinked');
    const [onlyRecurring, setOnlyRecurring] = useState(true);
    // The page belongs to the period it was picked in: page 4 of one period means nothing in another.
    // If the period changes from above it goes back to the first by derivation, with no effect to reset it.
    const [chosenPage, setChosenPage] = useState({ period, page: 1 });
    const page = chosenPage.period === period ? chosenPage.page : 1;
    // The server fixes the criterion and it doesn't change between queries; kept apart so it doesn't flicker on every filter change.
    const [criteria, setCriteria] = useState<RecurringResponse['criteria'] | null>(null);
    const queryClient = useQueryClient();

    // One place on top for what happened, good or bad: after linking, the row disappears from the
    // list (or reloads), and an error drawn inside it would vanish with it.
    const [notice, setNotice] = useState<(Notice & { id: number; error?: true }) | null>(null);
    const [toBring, setToBring] = useState<RecurringGroup | null>(null);
    const [toRemove, setToRemove] = useState<RecurringGroup | null>(null);
    const [removing, setRemoving] = useState(false);
    // Same reason as in BringModal: Carbon's Escape handler keeps the first render's state.
    const removingNow = useRef(false);
    const [removeError, setRemoveError] = useState<string | null>(null);
    // Closing a modal dropped focus on the body, so keyboard users had to tab through the screen again. Remember who opened it.
    const returnFocus = useRef<HTMLElement | null>(null);
    const modalOpen = toBring !== null || toRemove !== null;
    useEffect(() => {
        if (modalOpen) return;
        const target = returnFocus.current;
        returnFocus.current = null;
        if (target && document.contains(target)) target.focus();
    }, [modalOpen]);
    function open(action: () => void) {
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        action();
    }

    const params = new URLSearchParams({ status, only_recurring: String(onlyRecurring), page: String(page) });
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    // Dropping the previous response when the filter or period changes avoids pinning its groups on
    // the new query: with another key, Query doesn't show it. When the same query repeats (after
    // linking or removing, which invalidate ['purchases']) or only the page changes (placeholder),
    // the list stays in view, without actions, while the new one arrives: no jumping, and keyboard
    // users keep focus in the pagination.
    const query = useQuery({
        queryKey: ['purchases', 'recurring', { status, onlyRecurring, from, to, page }] as const,
        queryFn: fetchJson<RecurringResponse>(`/api/purchases/recurring?${params}`),
        placeholderData: (previous, previousQuery) => {
            const before = previousQuery?.queryKey[2];
            return before && previous && !pageMissing(previous)
                && before.status === status && before.onlyRecurring === onlyRecurring && before.from === from && before.to === to
                ? previous : undefined;
        },
    });
    const response = query.data;

    // Step back instead of showing an empty list that would look like "nothing left to do".
    // Adjusted during render and only on a confirmed response: a stale cached copy can claim the
    // page is gone while refetching and turn out fine.
    if (response && !query.isPlaceholderData && !query.isFetching && pageMissing(response)) {
        setChosenPage({ period, page: Math.max(1, response.pages) });
    }
    if (response && (criteria?.min_purchases !== response.criteria.min_purchases
        || criteria?.min_months !== response.criteria.min_months)) {
        setCriteria(response.criteria);
    }

    const loading = query.isFetching;
    // After an error the list isn't drawn, not even while retrying.
    const data = query.error || !response || pageMissing(response) ? null : response;
    const error = query.error && !loading ? messageOf(query.error) : null;

    function filter(change: () => void) {
        change();
        setChosenPage({ period, page: 1 });
    }

    function finish(n: Notice) {
        // The group's button disappears once linked: focus goes to the notice.
        // BringModal already invalidated what changed.
        returnFocus.current = null;
        setNotice({ ...n, id: Date.now() });
        setToBring(null);
    }

    // A link changes this list, the book reader ("Linked to ...") and the dashboard coverage: it
    // all lives under ['purchases'], and open tabs refetch themselves. It also changes the catalog:
    // its "Last purchase" comes from the links, and removing one would leave another purchase's price in inventory.
    function reloadPurchases() {
        void queryClient.invalidateQueries({ queryKey: ['purchases'] });
        void queryClient.invalidateQueries({ queryKey: ['products'] });
    }

    async function removeLink() {
        const link = toRemove?.product;
        if (!toRemove || !link || removingNow.current) return;
        removingNow.current = true;
        setRemoving(true);
        setRemoveError(null);
        try {
            await requestJson<null>(`/api/purchases/links/${link.alias_id}`, { method: 'DELETE' });
            returnFocus.current = null;
            setToRemove(null);
            setNotice({
                id: Date.now(),
                title: `Link removed from ${link.code}`,
                detail: `"${toRemove.description}" is unlinked again. ${link.code} is still in the catalog.`,
            });
            reloadPurchases();
        } catch (e) {
            setRemoveError(messageOf(e));
            // A 404 means someone else already removed it: what's on screen is stale.
            if (e instanceof ApiError && e.status === 404) reloadPurchases();
        } finally {
            removingNow.current = false;
            setRemoving(false);
        }
    }

    // Link with the suggestion in one tap: the suggestion and its why are in view, so the click IS
    // the confirmation. Undone with "Remove link" like any other. Never linked without that click.
    const [linkingSuggested, setLinkingSuggested] = useState<string | null>(null);
    // The notice key only has to change on each new notice (to remount it and move focus to it);
    // a counter is enough. Negative so it doesn't clash with the Date.now() ones.
    const suggestedNotices = useRef(0);
    async function linkSuggested(g: RecurringGroup) {
        const s = g.suggestion;
        if (!s || linkingSuggested !== null) return;
        setLinkingSuggested(g.description_norm);
        try {
            const r = await requestJson<LinkResponse>('/api/purchases/link', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // The description as is; the server normalizes it (see BringModal).
                body: JSON.stringify({ description: g.description, product_id: s.product.id }),
            });
            returnFocus.current = null;
            // Same text as the modal: the figures cover all books.
            const n = linkNotice(r);
            setNotice({
                id: -(++suggestedNotices.current),
                title: n.title,
                detail: `"${g.description}". ${n.detail}${r.already_linked ? '' : ' If it was wrong, remove it under "Linked".'}`,
            });
            reloadPurchases();
        } catch (e) {
            // A 409 means someone else linked it meanwhile, and to what: the list reloads, the row
            // goes, and the notice stays on top naming the item so it can be checked.
            const clash = clashesWith(e);
            setNotice({
                id: -(++suggestedNotices.current),
                error: true,
                title: `Could not link "${g.description}"`,
                detail: clash
                    ? `It's already linked to ${clash.code} — ${clash.name}, not to ${s.product.code}. `
                        + 'If that link is wrong, remove it under "Linked".'
                    : messageOf(e),
            });
            if (e instanceof ApiError && e.status === 409) reloadPurchases();
        } finally {
            setLinkingSuggested(null);
        }
    }

    // After linking, the person is mid-list and the notice sits on top, out of view on a phone.
    // Stable so it only scrolls when a new notice appears (the `key` remounts it).
    const showNotice = useCallback((node: HTMLDivElement | null) => {
        node?.scrollIntoView({ block: 'nearest' });
        node?.focus({ preventScroll: true });
    }, []);

    const busy = loading || removing || linkingSuggested !== null;

    return <section className="bring stack">
        {notice && <div key={notice.id} ref={showNotice} tabIndex={-1} className="bring-notice">
            <InlineNotification kind={notice.error ? 'error' : 'success'} title={notice.title} subtitle={notice.detail}
                onCloseButtonClick={() => setNotice(null)} />
        </div>}

        <Tile className="panel stack">
            <div className="bring-filters">
                <div className="bring-filter">
                    <span className="cds--label" id="bring-status-label">Show</span>
                    <ContentSwitcher aria-labelledby="bring-status-label" size="md"
                        selectedIndex={STATUSES.findIndex(s => s.value === status)}
                        onChange={({ name }) => {
                            const next = STATUSES.find(s => s.value === name);
                            if (next && next.value !== status) filter(() => setStatus(next.value));
                        }}>
                        {STATUSES.map(s => <Switch key={s.value} name={s.value} text={s.text} />)}
                    </ContentSwitcher>
                </div>
                <Toggle id="bring-only" labelText="Only recurring" labelA="No" labelB="Yes"
                    toggled={onlyRecurring} onToggle={v => filter(() => setOnlyRecurring(v))} />
            </div>
        </Tile>

        {loading && <InlineLoading description={data ? 'Updating…' : 'Looking for recurring purchases…'} />}
        {error && <div className="stack">
            <InlineNotification kind="error" hideCloseButton title="Could not load" subtitle={error} />
            <div><Button kind="tertiary" onClick={() => { void query.refetch(); }}>Retry</Button></div>
        </div>}

        {data && <Tile className="panel stack">
            <p><strong>{countText(data.total, status, onlyRecurring)}</strong>
                {data.pages > 1 && <span className="muted"> · page {page} of {data.pages}</span>}</p>

            {data.groups.length === 0 && <p className="muted">{emptyText(status, onlyRecurring, monthsWithBook, criteria?.min_months ?? null)}</p>}

            {data.groups.length > 0 && <ul className="bring-list" aria-busy={loading}>
                {data.groups.map(g => <li key={g.description_norm} className="bring-group">
                    <div className="bring-group__body">
                        <div className="bring-group__head">
                            <h3 className="bring-group__description">{g.description}</h3>
                            {!g.recurring && <Tag type="outline" size="sm">Doesn't meet the criterion</Tag>}
                        </div>
                        <dl className="bring-data">
                            <div><dt>Purchases</dt><dd>{g.purchases}</dd></div>
                            <div><dt>Months</dt><dd>{g.months}</dd></div>
                            <div><dt>Variants</dt><dd>{g.variants}</dd></div>
                            <div><dt>First – last</dt><dd>{dateRange(g.first_date, g.last_date)}</dd></div>
                            <div><dt>Amount</dt><dd>{money(g.amount)}</dd></div>
                            <div><dt>Last price</dt><dd>{unitPriceText(g.last_price)}</dd></div>
                            {/* As written in the book: suppliers aren't merged by similarity. */}
                            <div className="bring-data__wide"><dt>Suppliers</dt>
                                <dd>{g.suppliers.length > 0 ? g.suppliers.join(' · ') : '—'}</dd></div>
                        </dl>
                        {g.product && <div className="bring-link">
                            <p>Linked to <span className="mono">{g.product.code}</span> — {g.product.name}</p>
                            <p className="muted">{LINK_ORIGIN[g.product.alias_origin] ?? `Origin: ${g.product.alias_origin}.`}</p>
                        </div>}
                        {!g.product && g.suggestion && <div className="bring-suggestion">
                            <p>Suggested: <span className="mono">{g.suggestion.product.code}</span> — {g.suggestion.product.name}</p>
                            <p className="muted">{reasonOf(g.suggestion)}</p>
                        </div>}
                    </div>
                    <div className="bring-group__actions">
                        {/* Remove isn't red: red is the brand color, and the confirmation already acts as the brake. */}
                        {g.product
                            ? <Button kind="tertiary" disabled={busy} onClick={() => open(() => { setRemoveError(null); setToRemove(g); })}>
                                Remove link</Button>
                            : <>
                                {g.suggestion && <Button disabled={busy} onClick={() => { void linkSuggested(g); }}>
                                    {linkingSuggested === g.description_norm ? 'Linking…' : `Link to ${g.suggestion.product.code}`}</Button>}
                                {/* With a suggestion, bring stays as the other option: another
                                    product, or create one if the suggestion was wrong. */}
                                <Button kind={g.suggestion ? 'tertiary' : 'primary'} disabled={busy}
                                    onClick={() => open(() => setToBring(g))}>
                                    {g.suggestion ? 'Other product or new' : 'Bring to catalog'}</Button>
                            </>}
                    </div>
                </li>)}
            </ul>}

            {data.pages > 1 && <Pagination total={data.total} page={page} disabled={busy}
                onChange={p => setChosenPage({ period, page: p })} />}
        </Tile>}

        {toBring && <BringModal group={toBring}
            onClose={() => setToBring(null)} onDone={finish} />}

        {/* A wrong link is worse than none: removing it has to be possible, but not in one gloved tap. */}
        {toRemove?.product && <Modal open size="sm" preventCloseOnClickOutside
            modalLabel="Remove link" modalHeading="Remove this link?" closeButtonLabel="Close"
            primaryButtonText="Remove link" secondaryButtonText="Cancel"
            primaryButtonDisabled={removing}
            loadingStatus={removing ? 'active' : 'inactive'} loadingDescription="Removing…"
            onRequestClose={() => { if (!removingNow.current) setToRemove(null); }}
            onRequestSubmit={removeLink}>
            <div className="stack">
                <p>"{toRemove.description}" will be unlinked from <span className="mono">{toRemove.product.code}</span> — {toRemove.product.name}.</p>
                {removeError && <InlineNotification kind="error" hideCloseButton title="Could not remove" subtitle={removeError} />}
            </div>
        </Modal>}
    </section>;
}
