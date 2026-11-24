import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Button, InlineLoading, InlineNotification, Modal, RadioButton, RadioButtonGroup,
    RadioTile, Select, SelectItem, TextInput, TileGroup,
} from '@carbon/react';
import type { Category, Product, ProductsResponse } from '../../types';
import type {
    NewFromPurchase, RecurringGroup, LinkResponse, BringResponse,
} from '../../purchases/types';
import { toProduct, requestJson, ApiError } from '../../api';
import { fetchJson } from '../../queries';
import { codeOnCategoryChange } from '../../codePrefix';
import { CodeField } from '../CodeField';
import { CategoryField } from '../CategoryField';
import { toCents, quantityText, money, unitPriceText } from '../../money';
import {
    VALID_QUANTITY, MAX_LENGTH, VALID_PRICE, UNITS, WHOLE_UNITS, badFormat, invalidNumber,
} from '../../newProduct';
import { type Notice, linkNotice, clashesWith, linkedLines } from '../../purchases/link';

// Bring a purchase description to the catalog: link it to an existing item or create a new one.
// The server's rules are repeated here only to warn before sending, like in ProductForm. The
// server stays the guarantee, so its messages are shown as they come.

/** How many matches to show. With gloves on, a list of 50 isn't scrolled: you type more. */
const MAX_CANDIDATES = 10;

type Path = 'link' | 'create';
type CreateType = NewFromPurchase['control_type'];

/** The usual text of this modal, with its final period. */
const messageOf = (e: unknown) => e instanceof ApiError ? e.message : 'Could not connect to the API.';

/**
 * Candidates are cached as the server sends them and converted on read: the ['products', { q }]
 * key can be shared with another screen searching the same thing, and must find the same shape there.
 */
const toCandidates = (r: ProductsResponse): { products: Product[]; total: number } =>
    ({ products: r.products.map(toProduct), total: r.total });

type Failure = {
    /** To refocus the notice even if the message repeats. */
    id: number;
    message: string;
    errorCode: string | null;
    /** The item a description that's already linked clashes with. */
    clash: { code: string; name: string } | null;
};

const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

function failureOf(e: unknown): Failure {
    const id = Date.now();
    if (!(e instanceof ApiError)) {
        return { id, message: 'Could not connect to the API.', errorCode: null, clash: null };
    }
    const body = typeof e.body === 'object' && e.body !== null
        ? e.body as { error_code?: string }
        : {};
    return { id, message: e.message, errorCode: body.error_code ?? null, clash: clashesWith(e) };
}

/**
 * The minimum proposed for a unit. The suggestion is the average purchase size and is almost never
 * a whole number. In a unit without fractions it rounds UP: with an average of 5.6 pieces,
 * reordering when 5 are left is too late. Proposing 5.6 as is would leave the field in an input
 * error, and the server would reject it anyway.
 */
function proposedMinimum(suggested: RecurringGroup['suggested'], unit: string) {
    if (!suggested) return '';
    const n = Number(suggested.minimum);
    return WHOLE_UNITS.includes(unit) && !Number.isInteger(n)
        ? String(Math.ceil(n))
        : quantityText(suggested.minimum);
}

type Props = {
    group: RecurringGroup;
    onClose: () => void;
    /**
     * Finished fine: the parent closes and shows the notice. Reloading isn't its job: the modal
     * already invalidated what changed, so the reader and dashboard find out on their own.
     */
    onDone: (notice: Notice) => void;
};

export function BringModal({ group, onClose, onDone }: Props) {
    // Opens on "link" on purpose: searching first is what keeps someone from creating, under
    // another name, an item the catalog already has. A duplicate splits the purchase history in two
    // and nobody notices.
    const [path, setPath] = useState<Path>('link');
    const [sending, setSending] = useState(false);
    // Carbon's Escape handler is registered once on open and keeps that moment's `sending`. The ref
    // is what stops the modal closing mid-request, whichever way the close comes.
    const busy = useRef(false);
    const [failure, setFailure] = useState<Failure | null>(null);

    // Link to an existing item. Starts empty even with a suggestion: this modal is reached from
    // "Other product or new", i.e. after discarding it. Preloading it would re-propose what was rejected.
    const [search, setSearch] = useState('');
    const [chosen, setChosen] = useState<Product | null>(null);

    // New item. Name, minimum and price come proposed from the books; the control type does NOT, see below.
    const [code, setCode] = useState('');
    const [rejectedCode, setRejectedCode] = useState<string | null>(null);
    const [name, setName] = useState(group.description);
    const [unit, setUnit] = useState('piece');
    const [categoryId, setCategoryId] = useState('');
    // A typed category name that hasn't been created: saving now would leave the product without the one wanted.
    const [categoryPending, setCategoryPending] = useState(false);
    const [type, setType] = useState<CreateType | null>(null);
    // null = nobody has touched it: the proposal for the chosen unit is shown, derived on every
    // render. So switching from piece to kg redoes the rounding without an effect to sync it;
    // what the person types is never touched.
    const [typedMinimum, setTypedMinimum] = useState<string | null>(null);
    // Proposed in cents: the catalog doesn't store thousandths, and proposing 0.258 for the server to reject would be a trap.
    const [price, setPrice] = useState(group.last_price !== null ? quantityText(toCents(group.last_price)) : '');
    const [location, setLocation] = useState('');
    const categoriesQuery = useQuery({
        queryKey: ['categories'],
        queryFn: fetchJson<Category[]>('/api/categories'),
    });
    const categories = categoriesQuery.data ?? null;
    const categoriesError = categoriesQuery.error && !categoriesQuery.isFetching
        ? messageOf(categoriesQuery.error) : null;
    const queryClient = useQueryClient();

    const text = search.trim();

    // Wait until typing stops. A query per letter over the workshop wifi arrives out of order.
    // Query drops the previous one when the key changes, and comparing the requested text with the
    // typed one stops results for something no longer typed from showing.
    const [requested, setRequested] = useState(text);
    useEffect(() => {
        const wait = setTimeout(() => setRequested(text), 300);
        return () => clearTimeout(wait);
    }, [text]);
    const searchQuery = useQuery({
        queryKey: ['products', { q: requested }],
        queryFn: fetchJson<ProductsResponse>(`/api/products?q=${encodeURIComponent(requested)}`),
        enabled: requested.length >= 2,
        select: toCandidates,
    });

    // Stable on purpose: a new function on every render would make React call it again on each
    // keystroke and the modal would jump to the notice.
    const showFailure = useCallback((node: HTMLDivElement | null) => {
        node?.scrollIntoView({ block: 'nearest' });
    }, []);

    // What matches what's typed now; null while waiting or searching.
    const upToDate = text.length >= 2 && requested === text;
    const current: { products?: Product[]; total?: number; error?: string } | null = !upToDate ? null
        : searchQuery.error ? (searchQuery.isFetching ? null : { error: messageOf(searchQuery.error) })
            : searchQuery.data ?? null;

    const proposal = proposedMinimum(group.suggested, unit);
    const minimum = typedMinimum ?? proposal;
    const suggestedText = group.suggested ? quantityText(group.suggested.minimum) : '';
    const rounded = group.suggested !== null && proposal !== suggestedText;
    // An item without stock has no minimum: the field is emptied and locked. What was typed is kept in case the person changes their mind.
    const visibleMinimum = type === 'no_balance' ? '' : minimum;
    const badMinimum = invalidNumber(visibleMinimum) || badFormat(visibleMinimum, VALID_QUANTITY);
    const invalidFraction = !badMinimum && visibleMinimum.trim() !== ''
        && WHOLE_UNITS.includes(unit) && !Number.isInteger(Number(visibleMinimum));
    const negativePrice = invalidNumber(price);
    const badPrice = negativePrice || badFormat(price, VALID_PRICE);

    const missing = [
        code.trim() === '' && 'code',
        name.trim() === '' && 'name',
        categoryId === '' && 'category',
        type === null && 'control type',
    ].filter((x): x is string => typeof x === 'string');

    const ready = path === 'link'
        ? chosen !== null
        : missing.length === 0 && !badMinimum && !invalidFraction && !badPrice
            && code.trim() !== rejectedCode && !categoryPending;

    function changePath(next: Path) {
        setPath(next);
        setFailure(null);
    }

    async function submit() {
        if (busy.current || !ready) return;
        busy.current = true;
        setSending(true);
        setFailure(null);
        try {
            if (path === 'link' && chosen) {
                const r = await requestJson<LinkResponse>('/api/purchases/link', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // The description goes as the book wrote it. The server normalizes it, in SQL:
                    // one definition of "same description" for the link and for the list.
                    body: JSON.stringify({ description: group.description, product_id: chosen.id }),
                });
                // Linking changes what shows in purchases (this list, the reader and the dashboard
                // coverage) and the catalog too: its "Last purchase" comes from the links.
                void queryClient.invalidateQueries({ queryKey: ['purchases'] });
                void queryClient.invalidateQueries({ queryKey: ['products'] });
                onDone(linkNotice(r));
            } else if (path === 'create' && type) {
                const product: NewFromPurchase = {
                    code: code.trim(),
                    name: name.trim(),
                    unit,
                    category_id: Number(categoryId),
                    control_type: type,
                    minimum: type === 'no_balance' || minimum.trim() === '' ? null : minimum.trim(),
                    price: price.trim() === '' ? null : price.trim(),
                    location: location.trim() === '' ? null : location.trim(),
                };
                // No `quantity`: it always comes in uncounted, the server decides.
                const r = await requestJson<BringResponse>('/api/purchases/bring', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ description: group.description, product }),
                });
                // Besides purchases, a new item came in: inventory and the home summary (which counts the uncounted) change.
                void queryClient.invalidateQueries({ queryKey: ['purchases'] });
                void queryClient.invalidateQueries({ queryKey: ['products'] });
                void queryClient.invalidateQueries({ queryKey: ['summary'] });
                onDone({
                    title: linkedLines(r.purchases, r.amount, r.product.code),
                    detail: `${r.product.code} entered the catalog uncounted: it will show — until someone counts it.`,
                });
            }
        } catch (e) {
            const f = failureOf(e);
            setFailure(f);
            if (f.errorCode === 'duplicate_code') setRejectedCode(code.trim());
            // Someone else linked it while this modal was open: the list behind is stale, reload it.
            if (f.errorCode === 'description_linked') {
                void queryClient.invalidateQueries({ queryKey: ['purchases'] });
            }
        } finally {
            busy.current = false;
            setSending(false);
        }
    }

    const candidates = current?.products?.slice(0, MAX_CANDIDATES) ?? [];

    return <Modal open size="md" hasScrollingContent preventCloseOnClickOutside
        className="bring-modal"
        modalLabel="Bring to catalog" modalHeading={group.description}
        closeButtonLabel="Close"
        primaryButtonText={path === 'link' ? 'Link' : 'Create and link'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={!ready || sending}
        loadingStatus={sending ? 'active' : 'inactive'} loadingDescription="Saving…"
        onRequestClose={() => { if (!busy.current) onClose(); }}
        onRequestSubmit={submit}>
        <div className="stack">
            <p className="muted">
                {group.purchases} {group.purchases === 1 ? 'purchase' : 'purchases'} in {group.months} {group.months === 1 ? 'month' : 'months'} of the
                period · {money(group.amount)} · last price {unitPriceText(group.last_price)}
            </p>
            {/* The link is by normalized description: case and spaces don't count. Saying so avoids thinking only one form gets linked. */}
            {group.variants > 1 && <p className="muted">
                Includes {group.variants} written forms that differ only in capitalization or spaces.
            </p>}

            <TileGroup name="bring-path" legend="Action"
                className="cds--tile-group bring-path"
                valueSelected={path} disabled={sending}
                onChange={changePath}>
                <RadioTile id="bring-path-link" value="link">
                    <strong>Link to existing item</strong>
                </RadioTile>
                <RadioTile id="bring-path-create" value="create">
                    <strong>Create new item</strong>
                </RadioTile>
            </TileGroup>

            {path === 'link' && <div className="stack">
                <TextInput id="bring-search" type="search" autoComplete="off"
                    labelText="Search catalog" placeholder="Name or code"
                    value={search} disabled={sending}
                    onChange={e => setSearch(e.target.value)} />
                {text.length >= 2 && current === null && <InlineLoading description="Searching…" />}
                {current?.error && <InlineNotification kind="error" lowContrast hideCloseButton
                    title="Could not search" subtitle={current.error} />}
                {current?.products && current.products.length === 0 && <div className="stack">
                    <p>No matches for "{text}".</p>
                    <div><Button kind="tertiary" size="md" onClick={() => changePath('create')}>Create as new</Button></div>
                </div>}
                {candidates.length > 0 && <>
                    <ul className="bring-candidates" aria-label="Matching items">
                        {candidates.map(p => <li key={p.id}>
                            <button type="button" className="bring-candidate" disabled={sending}
                                aria-pressed={chosen?.id === p.id} onClick={() => setChosen(p)}>
                                <span className="mono">{p.code}</span>
                                <span>{p.name}</span>
                                <span className="muted">
                                    {[p.unit, p.category, p.control_type === 'no_balance' ? 'no stock' : null]
                                        .filter(Boolean).join(' · ')}
                                </span>
                            </button>
                        </li>)}
                    </ul>
                    {(current?.total ?? 0) > candidates.length && <p className="muted">
                        Showing {candidates.length} of {current?.total}.
                    </p>}
                </>}
                {chosen && <p className="bring-chosen">
                    Link to <span className="mono">{chosen.code}</span> — {chosen.name}
                </p>}
            </div>}

            {path === 'create' && <div className="stack">
                <CodeField id="bring-code" labelText="Code" required className="mono" category={(categories ?? []).find(c => String(c.id) === categoryId)}
                    value={code} disabled={sending} maxLength={MAX_LENGTH.code} autoComplete="off"
                    onChange={e => setCode(e.target.value.toUpperCase())}
                    invalid={rejectedCode !== null && code.trim() === rejectedCode}
                    invalidText="That code already exists" />
                <TextInput id="bring-name" labelText="Name" required
                    value={name} disabled={sending} maxLength={MAX_LENGTH.name}
                    onChange={e => setName(e.target.value)} />
                <div className="form-grid">
                    <Select id="bring-unit" labelText="Unit" value={unit} disabled={sending}
                        onChange={e => setUnit(e.target.value)}>
                        {UNITS.map(u => <SelectItem key={u} value={u} text={u} />)}
                    </Select>
                    <CategoryField id="bring-category" categories={categories} value={categoryId} disabled={sending}
                        onPending={setCategoryPending}
                        onChange={next => { setCode(c => codeOnCategoryChange(c, categories ?? [], categoryId, next)); setCategoryId(next); }} />
                </div>
                {categoriesError && <div className="stack">
                    <InlineNotification kind="error" lowContrast hideCloseButton
                        title="Could not load the categories" subtitle={categoriesError} />
                    <div><Button kind="tertiary" size="md" onClick={() => { void categoriesQuery.refetch(); }}>
                        Retry</Button></div>
                </div>}

                <RadioButtonGroup name="bring-type" legendText="Control type" orientation="vertical"
                    valueSelected={type ?? ''} disabled={sending}
                    onChange={v => setType(v as CreateType)}>
                    <RadioButton id="bring-type-stock" value="stock" labelText="Tracks stock" />
                    <RadioButton id="bring-type-no-balance" value="no_balance" labelText="Cost only, no stock" />
                </RadioButtonGroup>

                <div className="form-grid">
                    <TextInput id="bring-minimum" labelText="Minimum" type="number" min={0} step="any" inputMode="decimal"
                        value={visibleMinimum} disabled={sending || type === 'no_balance'}
                        onChange={e => setTypedMinimum(e.target.value)}
                        invalid={badMinimum || invalidFraction}
                        invalidText={invalidNumber(visibleMinimum) ? 'Must be a non-negative number.'
                            : badMinimum ? 'Up to 9 digits and 3 decimals.' : `No fractions of "${unit}".`}
                        helperText={type !== 'no_balance' && group.suggested ? `Suggested: ${rounded ? proposal : suggestedText}` : undefined} />
                    <TextInput id="bring-price" labelText="Price" type="number" min={0} step="0.01" inputMode="decimal"
                        value={price} disabled={sending}
                        onChange={e => setPrice(e.target.value)}
                        invalid={badPrice}
                        invalidText={negativePrice ? 'Must be a non-negative number' : 'Up to 8 digits and 2 decimals (cents)'} />
                </div>
                <TextInput id="bring-location" labelText="Location" value={location} disabled={sending} maxLength={MAX_LENGTH.location}
                    onChange={e => setLocation(e.target.value)} />

                {missing.length > 0 && <p className="muted">Missing: {LIST.format(missing)}.</p>}
            </div>}

            {/* The server's message goes as is; if the description already has an owner, the item is named so it can be checked. */}
            {failure && <div key={failure.id} ref={showFailure} className="stack">
                <InlineNotification kind="error" hideCloseButton
                    title={path === 'link' ? 'Could not link' : 'Could not create'}
                    subtitle={failure.message} />
                {failure.clash && <p>
                    Clashes with <span className="mono">{failure.clash.code}</span> — {failure.clash.name}.
                    If that link is wrong, remove it from the linked list and bring it again.
                </p>}
            </div>}
        </div>
    </Modal>;
}
