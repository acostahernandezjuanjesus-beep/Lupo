import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Button, InlineLoading, InlineNotification, Modal, RadioButton, RadioButtonGroup,
    RadioTile, Select, SelectItem, TextInput, TileGroup,
} from '@carbon/react';
import type { Category, Product, ProductsResponse } from '../../types';
import { toProduct, requestJson, ApiError } from '../../api';
import { fetchJson } from '../../queries';
import { codeOnCategoryChange } from '../../codePrefix';
import { CodeField } from '../CodeField';
import { CategoryField } from '../CategoryField';
import {
    VALID_QUANTITY, MAX_LENGTH, VALID_PRICE, UNITS, WHOLE_UNITS, badFormat, invalidNumber,
    type UncountedNewProduct, type UncountedProduct,
} from '../../newProduct';
// The path picker and the candidate list are the ones from "bring to catalog": same gesture, same look.
import '../purchases/bring.scss';

// An unknown scanned code: link it to a catalog product or create a new product with it. No movement
// is recorded here; the screen resolves the code again and asks the usual questions.

type Path = 'link' | 'create';
type CreateType = UncountedNewProduct['control_type'];

/** How many matches to show. With gloves a list of 50 can't be scrolled: type more instead. */
const MAX_CANDIDATES = 10;

/** What POST /api/products/with-code returns. */
type WithCodeResponse = { product: UncountedProduct; code: { id: number; code: string } };

/** What the modal tells the screen when it finishes fine. */
export type NewCodeResult = { title: string; detail: string };

type Failure = {
    /** To refocus the notice even when the message repeats. */
    id: number;
    message: string;
    errorCode: string | null;
    /** The product that already has this code, if someone linked it meanwhile. */
    owner: { code: string; name: string } | null;
};

function failureOf(e: unknown): Failure {
    const id = Date.now();
    if (!(e instanceof ApiError)) {
        return { id, message: 'Could not connect to the API.', errorCode: null, owner: null };
    }
    const body = typeof e.body === 'object' && e.body !== null
        ? e.body as { error_code?: string; product?: { code: string; name: string } }
        : {};
    return {
        id,
        message: e.message,
        errorCode: body.error_code ?? null,
        owner: body.error_code === 'code_taken' && body.product ? body.product : null,
    };
}

const messageOf = (e: unknown) => e instanceof ApiError ? e.message : 'Could not connect to the API.';

// Cached as the server sends it and converted on read: other screens share the ['products', { q }] key
// and must find the same shape there.
const toCandidates = (r: ProductsResponse): { products: Product[]; total: number } =>
    ({ products: r.products.map(toProduct), total: r.total });

const LIST = new Intl.ListFormat('en', { type: 'conjunction' });

type Props = {
    code: string;
    onClose: () => void;
    /** Finished fine: the code now has an owner. The screen closes this, shows the notice and resolves the code again. */
    onDone: (result: NewCodeResult) => void;
};

export function NewCodeModal({ code, onClose, onDone }: Props) {
    // Opens on "link" on purpose: searching first avoids creating, under another name, a product the
    // catalog already has. A duplicate splits the history in two and nobody notices.
    const [path, setPath] = useState<Path>('link');
    const [sending, setSending] = useState(false);
    // Carbon registers its Escape handler once, on open, with that moment's `sending`. The ref is what
    // stops the modal from closing mid-save however it is triggered.
    const busy = useRef(false);
    const [failure, setFailure] = useState<Failure | null>(null);
    const queryClient = useQueryClient();

    // Link to an existing one.
    const [search, setSearch] = useState('');
    const [chosen, setChosen] = useState<Product | null>(null);

    // Create new.
    const [internalCode, setInternalCode] = useState('');
    const [rejectedCode, setRejectedCode] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [unit, setUnit] = useState('piece');
    const [categoryId, setCategoryId] = useState('');
    // A category name is typed but not created: saving now would leave the product without the one wanted.
    const [categoryPending, setCategoryPending] = useState(false);
    // No default, as in Purchases: whether it tracks stock is the creator's call, and a preselected one
    // would be the one saved when someone is in a hurry.
    const [type, setType] = useState<CreateType | null>(null);
    const [minimum, setMinimum] = useState('');
    const [price, setPrice] = useState('');
    const [location, setLocation] = useState('');

    const categoriesQuery = useQuery({
        queryKey: ['categories'],
        queryFn: fetchJson<Category[]>('/api/categories'),
    });
    const categories = categoriesQuery.data ?? null;
    const categoriesError = categoriesQuery.error && !categoriesQuery.isFetching
        ? messageOf(categoriesQuery.error) : null;

    const text = search.trim();
    // Wait for typing to pause: one request per letter over the shop wifi arrives out of order.
    // Comparing what was asked with what is typed avoids showing results for text no longer there.
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
    const upToDate = text.length >= 2 && requested === text;
    const current: { products?: Product[]; total?: number; error?: string } | null = !upToDate ? null
        : searchQuery.error ? (searchQuery.isFetching ? null : { error: messageOf(searchQuery.error) })
            : searchQuery.data ?? null;
    const candidates = current?.products?.slice(0, MAX_CANDIDATES) ?? [];

    // Stable on purpose: a new function every render would be called again on each keystroke and the modal would jump to the notice.
    const showFailure = useCallback((node: HTMLDivElement | null) => {
        node?.scrollIntoView({ block: 'nearest' });
    }, []);

    const visibleMinimum = type === 'no_balance' ? '' : minimum;
    const badMinimum = invalidNumber(visibleMinimum) || badFormat(visibleMinimum, VALID_QUANTITY);
    const invalidFraction = !badMinimum && visibleMinimum.trim() !== ''
        && WHOLE_UNITS.includes(unit) && !Number.isInteger(Number(visibleMinimum));
    const negativePrice = invalidNumber(price);
    const badPrice = negativePrice || badFormat(price, VALID_PRICE);

    const missing = [
        internalCode.trim() === '' && 'internal code',
        name.trim() === '' && 'name',
        categoryId === '' && 'category',
        type === null && 'control type',
    ].filter((x): x is string => typeof x === 'string');

    const ready = path === 'link'
        ? chosen !== null
        : missing.length === 0 && !badMinimum && !invalidFraction && !badPrice
            && internalCode.trim() !== rejectedCode && !categoryPending;

    function changePath(next: Path) {
        setPath(next);
        setFailure(null);
    }

    /** From "none match": what was searched is almost always the new product's name. */
    function createWhatWasSearched() {
        if (name.trim() === '') setName(text);
        changePath('create');
    }

    async function submit() {
        if (busy.current || !ready) return;
        busy.current = true;
        setSending(true);
        setFailure(null);
        try {
            if (path === 'link' && chosen) {
                const r = await requestJson<{ already_linked?: boolean }>(`/api/products/${chosen.id}/codes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code }),
                });
                // The product gained a code: cached searches no longer have its full list.
                void queryClient.invalidateQueries({ queryKey: ['products'] });
                onDone({
                    title: r.already_linked ? `Already linked to ${chosen.code}` : `Code linked to ${chosen.code}`,
                    detail: `${chosen.name}. Next time someone scans it, it will come up on its own.`,
                });
            } else if (path === 'create' && type) {
                const product: UncountedNewProduct = {
                    code: internalCode.trim(),
                    name: name.trim(),
                    unit,
                    category_id: Number(categoryId),
                    control_type: type,
                    minimum: type === 'no_balance' || minimum.trim() === '' ? null : minimum.trim(),
                    price: price.trim() === '' ? null : price.trim(),
                    location: location.trim() === '' ? null : location.trim(),
                };
                // No `quantity`: it always enters uncounted, the server decides.
                const r = await requestJson<WithCodeResponse>('/api/products/with-code', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ barcode: code, product }),
                });
                // A product came in: the inventory and the home summary (which counts uncounted ones) change.
                void queryClient.invalidateQueries({ queryKey: ['products'] });
                void queryClient.invalidateQueries({ queryKey: ['summary'] });
                onDone({
                    title: `${r.product.code} added to the catalog with this code`,
                    detail: 'Uncounted: it will show — until someone counts it.',
                });
            }
        } catch (e) {
            const f = failureOf(e);
            setFailure(f);
            if (f.errorCode === 'duplicate_code') setRejectedCode(internalCode.trim());
        } finally {
            busy.current = false;
            setSending(false);
        }
    }

    return <Modal open size="md" hasScrollingContent preventCloseOnClickOutside
        className="bring-modal"
        modalLabel="Unregistered code" modalHeading={<span className="mono">{code}</span>}
        closeButtonLabel="Close"
        primaryButtonText={path === 'link' ? 'Link the code' : 'Create with this code'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={!ready || sending}
        loadingStatus={sending ? 'active' : 'inactive'} loadingDescription="Saving…"
        onRequestClose={() => { if (!busy.current) onClose(); }}
        onRequestSubmit={submit}>
        <div className="stack">
            <TileGroup name="code-path" legend="Action"
                className="cds--tile-group bring-path"
                valueSelected={path} disabled={sending}
                onChange={changePath}>
                <RadioTile id="code-path-link" value="link">
                    <strong>Link to existing product</strong>
                </RadioTile>
                <RadioTile id="code-path-create" value="create">
                    <strong>Create new product</strong>
                </RadioTile>
            </TileGroup>

            {path === 'link' && <div className="stack">
                <TextInput id="code-search" type="search" autoComplete="off"
                    labelText="Search catalog" placeholder="Name or internal code"
                    value={search} disabled={sending}
                    onChange={e => setSearch(e.target.value)} />
                {text.length >= 2 && current === null && <InlineLoading description="Searching…" />}
                {current?.error && <InlineNotification kind="error" lowContrast hideCloseButton
                    title="Could not search" subtitle={current.error} />}
                {current?.products && current.products.length === 0 && <div className="stack">
                    <p>No matches for "{text}".</p>
                    <div><Button kind="tertiary" size="md" onClick={createWhatWasSearched}>Create as new</Button></div>
                </div>}
                {candidates.length > 0 && <>
                    <ul className="bring-candidates" aria-label="Matching products">
                        {candidates.map(p => <li key={p.id}>
                            <button type="button" className="bring-candidate" disabled={sending}
                                aria-pressed={chosen?.id === p.id} onClick={() => setChosen(p)}>
                                <span className="mono">{p.code}</span>
                                <span>{p.name}</span>
                                <span className="muted">
                                    {[p.unit, p.category, p.control_type === 'no_balance' ? 'no stock tracking' : null]
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
                <CodeField id="internal-code" labelText="Internal code" required className="mono" category={(categories ?? []).find(c => String(c.id) === categoryId)}
                    value={internalCode} disabled={sending} maxLength={MAX_LENGTH.code} autoComplete="off"
                    onChange={e => setInternalCode(e.target.value.toUpperCase())}
                    invalid={rejectedCode !== null && internalCode.trim() === rejectedCode}
                    invalidText="That internal code already exists" />
                <TextInput id="code-name" labelText="Name" required
                    value={name} disabled={sending} maxLength={MAX_LENGTH.name}
                    onChange={e => setName(e.target.value)} />
                <div className="form-grid">
                    <Select id="code-unit" labelText="Unit" value={unit} disabled={sending}
                        onChange={e => setUnit(e.target.value)}>
                        {UNITS.map(u => <SelectItem key={u} value={u} text={u} />)}
                    </Select>
                    <CategoryField id="code-category" categories={categories} value={categoryId} disabled={sending}
                        onPending={setCategoryPending}
                        onChange={next => { setInternalCode(c => codeOnCategoryChange(c, categories ?? [], categoryId, next)); setCategoryId(next); }} />
                </div>
                {categoriesError && <div className="stack">
                    <InlineNotification kind="error" lowContrast hideCloseButton
                        title="Could not load the categories" subtitle={categoriesError} />
                    <div><Button kind="tertiary" size="md" onClick={() => { void categoriesQuery.refetch(); }}>
                        Retry</Button></div>
                </div>}

                <RadioButtonGroup name="code-type" legendText="Control type" orientation="vertical"
                    valueSelected={type ?? ''} disabled={sending}
                    onChange={v => setType(v as CreateType)}>
                    <RadioButton id="code-type-stock" value="stock" labelText="Tracks stock" />
                    <RadioButton id="code-type-no-balance" value="no_balance" labelText="Cost only, no stock" />
                </RadioButtonGroup>

                <div className="form-grid">
                    <TextInput id="code-minimum" labelText="Minimum" type="number" min={0} step="any" inputMode="decimal"
                        value={visibleMinimum} disabled={sending || type === 'no_balance'}
                        onChange={e => setMinimum(e.target.value)}
                        invalid={badMinimum || invalidFraction}
                        invalidText={invalidNumber(visibleMinimum) ? 'Must be a non-negative number.'
                            : badMinimum ? 'Up to 9 digits and 3 decimals.' : `No fractions of "${unit}".`} />
                    <TextInput id="code-price" labelText="Price" type="number" min={0} step="0.01" inputMode="decimal"
                        value={price} disabled={sending}
                        onChange={e => setPrice(e.target.value)}
                        invalid={badPrice}
                        invalidText={negativePrice ? 'Must be a non-negative number' : 'Up to 8 digits and 2 decimals (cents)'} />
                </div>
                <TextInput id="code-location" labelText="Location" value={location} disabled={sending} maxLength={MAX_LENGTH.location}
                    onChange={e => setLocation(e.target.value)} />

                {missing.length > 0 && <p className="muted">Missing: {LIST.format(missing)}.</p>}
            </div>}

            {/* The server's message goes as is. If the code already has an owner (someone linked it while
                this was being filled in), name it and offer to go to that product: nothing left to create. */}
            {failure && <div key={failure.id} ref={showFailure} className="stack">
                <InlineNotification kind="error" hideCloseButton
                    title={path === 'link' ? 'Could not link' : 'Could not create'}
                    subtitle={failure.message} />
                {failure.owner && <div className="stack">
                    <p>It already belongs to <span className="mono">{failure.owner.code}</span> — {failure.owner.name}.</p>
                    <div><Button kind="tertiary" size="md" onClick={() => onDone({
                        title: `The code belongs to ${failure.owner?.code}`,
                        detail: 'Someone linked it meanwhile; that product is shown.',
                    })}>Go to that product</Button></div>
                </div>}
            </div>}
        </div>
    </Modal>;
}
