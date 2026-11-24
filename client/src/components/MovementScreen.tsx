import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, ComboBox, InlineNotification, InlineLoading, TextInput, Tile } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import type { Product, ProductApi, ProductsResponse, User, UserListing } from '../types';
import { toProduct, requestJson, ApiError } from '../api';
import { fetchJson, errorMessage } from '../queries';
import { levelStateOf, formatQuantity, balanceKnown } from '../level';
import { StockBar, StockState } from './ProductTable';
import { quantityProblem } from '../newProduct';
import { definitionOf, REASONS, movementSummary, type MovementType } from '../movement';
import { QuantityField, TypeSelector } from './movement/MovementControls';
import { useLocation, useNavigate } from 'react-router';
import './movement/movement.scss';

// Record a movement. It's the screen the storekeeper uses all day, so it's one column read top to
// bottom in three steps that appear as you go: the product, what happened to it, the details. Before
// the button, a sentence says in floor language what is about to be recorded.
//
// Same two rules as Scan: no type is preselected, and who takes (or delivers, or returns) the material
// is required, with no default and forgotten after each record so nothing sticky carries over.

type Props = {
    user: User;
    onBack: () => void;
};

// Stable list: a new one on every render would make the ComboBox think the options changed.
const NO_PEOPLE: UserListing[] = [];

export function MovementScreen({ user, onBack }: Props) {
    const queryClient = useQueryClient();
    const [search, setSearch] = useState('');
    // The settled term after the debounce: the query key, apart from what the field shows while typing.
    const [searchedTerm, setSearchedTerm] = useState('');
    const [product, setProduct] = useState<Product | null>(null);

    // From the inventory detail you arrive with the product CODE already chosen. The code travels, not the
    // product, because the list row could be hours old: with a stale balance, a confirmed "Will be −1"
    // would be saved as −3 with no 409. It's fetched again here, uncached, and chosen when it arrives.
    //
    // The history state is cleared once read: it survived reloads and sign-out, so the next person
    // would land here with the previous session's product.
    const location = useLocation();
    const navigate = useNavigate();
    const [initialCode] = useState(() => {
        const c = (location.state as { code?: unknown } | null)?.code;
        return typeof c === 'string' && c ? c : null;
    });
    useEffect(() => {
        if (location.state) navigate(location.pathname, { replace: true, state: null });
    }, [location.state, location.pathname, navigate]);
    const initial = useQuery({
        queryKey: ['products', 'by-code', initialCode],
        queryFn: fetchJson<ProductApi>(`/api/products/by-code?code=${encodeURIComponent(initialCode ?? '')}`),
        enabled: initialCode !== null,
        staleTime: 0,
        gcTime: 0,
    });
    // Applied once, during render rather than in an effect, and only with a response fetched on mount: never a cached copy.
    const [initialApplied, setInitialApplied] = useState(false);
    if (!initialApplied && initial.data && initial.isFetchedAfterMount) {
        setInitialApplied(true);
        setProduct(toProduct(initial.data));
    }
    const loadingInitial = initialCode !== null && !initialApplied && !initial.error;

    const [type, setType] = useState<MovementType | null>(null);
    const [value, setValue] = useState('');
    const [note, setNote] = useState('');
    const [responsible, setResponsible] = useState<UserListing | null>(null);

    // Same key as any other screen that lists people: if Users adds someone and invalidates ['users'], they show up here.
    const peopleQuery = useQuery({ queryKey: ['users'], queryFn: fetchJson<UserListing[]>('/api/users') });
    const people = peopleQuery.data ?? NO_PEOPLE;
    const meInList = people.find(g => g.id === user.id) ?? null;

    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // The server answered 409 though the client didn't expect a negative: the balance changed between
    // loading the screen and sending. Someone else took material meanwhile.
    const [confirm, setConfirm] = useState<string | null>(null);

    const searchBox = useRef<HTMLInputElement>(null);

    // Debounced search: without it there's one request per keystroke.
    useEffect(() => {
        // The chosen label ("code — name") isn't a search and must not replace the good results.
        if (product && search === `${product.code} — ${product.name}`) return;
        const id = setTimeout(() => setSearchedTerm(search.trim()), 250);
        return () => clearTimeout(id);
    }, [search, product]);

    const searchEnabled = searchedTerm.length >= 2;
    const searchQuery = useQuery({
        queryKey: ['products', { q: searchedTerm }],
        queryFn: fetchJson<ProductsResponse>(`/api/products?q=${encodeURIComponent(searchedTerm)}`),
        enabled: searchEnabled,
    });
    // A search error isn't shown: it counts as "no results" rather than adding a notice to a screen meant to be fast.
    const options = searchQuery.data?.products.map(toProduct) ?? [];
    const searching = searchEnabled && searchQuery.isFetching;

    const def = type ? definitionOf(type) : null;
    const amount = value.trim() === '' ? null : Number(value);
    // An adjustment accepts zero (counted and none left); an in or out doesn't.
    const problem = product && type ? quantityProblem(value, product.unit, type === 'adjustment') : null;
    const valid = amount !== null && problem === null;
    const needsResponsible = def !== null && def.question !== null;

    // Resulting balance by the usual rules: with no known balance (uncounted, or no stock tracking by
    // design) there's no "will be" and no negative warning. An adjustment does count: it sets the real
    // balance and can't leave it negative.
    const summary = product && type
        ? movementSummary({ type, product, quantity: valid ? amount : null, responsible: responsible?.name ?? null, operator: user.name })
        : null;
    const leavesNegative = summary?.negative ?? false;
    const meaninglessBalance = product !== null && !balanceKnown(product) && type !== 'adjustment';

    // Counting an item with no stock tracking makes it track stock, starting from the count
    // (the server requires an admin and asks for the `track_stock` confirmation).
    const promotes = product?.control_type === 'no_balance' && type === 'adjustment';

    // What the form still needs, said next to the button: a disabled button with no explanation is a dead end.
    const missing = [
        type === null && 'choose what happened',
        type !== null && !valid && 'enter the quantity',
        needsResponsible && responsible === null && 'say who',
    ].filter((f): f is string => Boolean(f));
    const levelState = product ? levelStateOf(product) : null;

    function clear() {
        setValue('');
        setNote('');
        setConfirm(null);
        setError(null);
    }

    function chooseProduct(p: Product | null) {
        setProduct(p);
        setType(null);
        setResponsible(null);
        clear();
        setSuccess(null);
    }

    function anotherProduct() {
        chooseProduct(null);
        setSearch('');
        setSearchedTerm('');
        searchBox.current?.focus();
    }

    async function record(force = false) {
        if (!product || !type || !valid || amount === null || sending) return;
        if (needsResponsible && !responsible) return;
        setSending(true);
        setError(null);
        setSuccess(null);

        const body: Record<string, unknown> = {
            product_id: product.id,
            type,
            ...(type === 'adjustment' ? { count: amount } : { quantity: amount }),
            ...(note.trim() ? { note: note.trim() } : {}),
            // The responsible is declared: whoever took it may not be whoever runs the system. The server omits
            // it when they're the same person; `user_id` comes from the session and isn't sent.
            ...(needsResponsible && responsible ? { responsible_id: responsible.id } : {}),
            // If the warning is already visible, clicking Record IS the confirmation; a 409 round trip would ask twice.
            ...((leavesNegative || force) ? { allow_negative: true } : {}),
            ...(promotes ? { track_stock: true } : {}),
        };

        try {
            const r = await requestJson<{ new_balance: number; unchanged?: boolean; now_tracks_stock?: boolean }>(
                '/api/movements',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });

            // With no known balance, "will be −1" would mean nothing: say why there's no number. A
            // no_balance item never announces one, even after an adjustment: the balance is saved but no
            // screen shows it, and "now 12" next to "Current balance: —" would contradict itself.
            const who = needsResponsible && responsible ? ` ${definitionOf(type).who?.(responsible.name) ?? ''}.` : '';
            setSuccess((r.unchanged
                ? 'The count matches the balance. No movement was recorded.'
                : r.now_tracks_stock
                    ? `Recorded. ${product.code} now tracks stock and is at ${formatQuantity(r.new_balance)} ${product.unit}.`
                    : product.control_type === 'no_balance'
                        ? `Recorded. ${product.code} has no stock tracking, so no balance will show in the inventory.`
                        : !meaninglessBalance
                            ? `Recorded. ${product.code} is now at ${formatQuantity(r.new_balance)} ${product.unit}.`
                            : `Recorded. ${product.code} is still uncounted: nobody knows how many are left until someone counts it.`) + who);

            setProduct({ ...product, quantity: r.new_balance, count_pending: type === 'adjustment' ? false : product.count_pending,
                ...(r.now_tracks_stock ? { control_type: 'stock' as const } : {}) });
            // After recording, forget everything but the product: the next movement is chosen anew.
            setType(null);
            setResponsible(null);
            clear();
            // Refresh whatever depends on the balance and the log, not just this screen's local `product`.
            queryClient.invalidateQueries({ queryKey: ['products'] });
            queryClient.invalidateQueries({ queryKey: ['movements'] });
            queryClient.invalidateQueries({ queryKey: ['summary'] });
        } catch (e) {
            if (e instanceof ApiError && e.status === 409
                && (e.body as { error_code?: string })?.error_code === 'negative_balance') {
                // The balance changed meanwhile. Show the server's number, not the one we had loaded. Mark
                // the product counted too: the server only answers 409 for a counted product, so if we
                // thought it uncounted, someone counted it meanwhile.
                const c = e.body as { current_balance: number; resulting_balance: number };
                setConfirm(
                    `The balance changed while you were entering this: it is now ${formatQuantity(c.current_balance)}. ` +
                    `This movement would leave it at ${formatQuantity(c.resulting_balance)}.`);
                setProduct({ ...product, quantity: c.current_balance, count_pending: false });
            } else {
                setError(e instanceof ApiError ? e.message : 'Could not record the movement');
            }
        } finally {
            setSending(false);
        }
    }

    const buttonLabel = sending ? 'Recording…'
        : confirm ? 'Record anyway'
            : summary && valid ? `Record ${summary.action.charAt(0).toLowerCase()}${summary.action.slice(1)}` : 'Record';

    return <section className="page movement-page stack">
        <div className="page-heading"><div><h1>Record movement</h1></div><Button kind="ghost" onClick={onBack}>Inventory</Button></div>

        <div className="mov-step">
            <h2 className="mov-step__title"><span className="mov-step__number" aria-hidden="true">1</span>Which product?</h2>
            <ComboBox<Product> id="find-product" titleText="Find product" placeholder="Code or name" items={options} ref={searchBox}
                selectedItem={product} itemToString={p => p ? p.code + ' — ' + p.name : ''}
                itemToElement={p => <span className="product-option">
                    <span><span className="mono">{p.code}</span> {p.name}</span>
                    {/* Uncounted or untracked, the balance is a dash: a zero would claim there is none. */}
                    <span className="product-option__balance mono">{balanceKnown(p) ? `${formatQuantity(p.quantity)} ${p.unit}` : '—'}</span>
                </span>}
                shouldFilterItem={() => true} onInputChange={setSearch} disabled={sending}
                onChange={({ selectedItem }) => chooseProduct(selectedItem ?? null)} />
            {searching && <InlineLoading description="Searching…" />}
            {loadingInitial && <InlineLoading description="Loading the chosen product…" />}
            {initialCode !== null && !initialApplied && initial.error && <InlineNotification kind="error" lowContrast hideCloseButton
                title="Could not load the chosen product" subtitle={`Search for it here: ${initialCode}.`} />}
        </div>

        {success && <InlineNotification kind="success" title="Recorded" subtitle={success} onCloseButtonClick={() => setSuccess(null)} />}
        {success && <div><Button kind="tertiary" size="md" onClick={anotherProduct}>Record another product</Button></div>}

        {product && levelState && <Tile className="mov-product">
            <div className="mov-product__head">
                <div className="min-w-0">
                    <p className="mono muted">{product.code}</p>
                    <h2 className="mov-product__name">{product.name}</h2>
                </div>
                <div className="mov-product__balance">
                    <p className="muted">Current balance</p>
                    <span className="stock-quantity">{balanceKnown(product) ? formatQuantity(product.quantity) : '—'}</span> {product.unit}
                </div>
            </div>
            {/* Uncounted is hatched; the mark explains the minimum. */}
            <div><StockBar state={levelState} /><div className="row spread"><StockState state={levelState} /><span className="muted">{product.minimum === null ? 'No minimum' : 'Min. ' + formatQuantity(product.minimum)}</span></div></div>
        </Tile>}

        {product && <div className="mov-step">
            <h2 className="mov-step__title"><span className="mov-step__number" aria-hidden="true">2</span>What happened?</h2>
            <TypeSelector value={type} disabled={sending} noAdjustment={user.role === 'operator'} onChange={t => { setType(t); clear(); }} />
        </div>}

        {product && type && def && <div className="mov-step">
            <h2 className="mov-step__title"><span className="mov-step__number" aria-hidden="true">3</span>Details</h2>
            {product.control_type === 'no_balance' && promotes && user.role !== 'admin' && (
                <InlineNotification kind="warning" lowContrast hideCloseButton title="Admin required to track stock" />
            )}

            <div className="mov-fields">
                <QuantityField label={type === 'adjustment' ? 'Counted quantity' : 'Quantity'} unit={product.unit} value={value} disabled={sending}
                    onChange={v => { setValue(v); setConfirm(null); }} problem={problem} />
                {needsResponsible && <div className="stack">
                    <ComboBox id="movement-responsible" titleText={def.question!} placeholder="Choose the person"
                        items={people} itemToString={(u: UserListing | null) => u?.name ?? ''}
                        selectedItem={responsible} disabled={sending}
                        onChange={({ selectedItem }) => setResponsible(selectedItem ?? null)} />
                    {meInList && responsible?.id !== meInList.id && <div>
                        <Button kind="ghost" size="sm" disabled={sending} onClick={() => setResponsible(meInList)}>It's me</Button>
                    </div>}
                    {peopleQuery.error && <div className="stack">
                        <InlineNotification kind="error" hideCloseButton lowContrast title="Could not load users"
                            subtitle={errorMessage(peopleQuery.error)} />
                        <div><Button kind="tertiary" size="sm" onClick={() => { void peopleQuery.refetch(); }}>Retry</Button></div>
                    </div>}
                </div>}
                <div className="mov-fields__wide stack">
                    <TextInput id="movement-note" labelText="Note (optional)" value={note} onChange={e => setNote(e.target.value)} disabled={sending} />
                    <div className="mov-reasons" role="group" aria-label="Common reasons">
                        {REASONS[type].map(m => <button key={m} type="button" className="mov-reason" aria-pressed={note === m} disabled={sending}
                            onClick={() => setNote(note === m ? '' : m)}>{m}</button>)}
                    </div>
                </div>
            </div>

            {/* The sentence for what's about to be recorded. The visible warning turns Record into the confirmation.
                On a concurrent change, the 409 asks to confirm the server's new balance. */}
            {summary && <div className={`mov-summary${leavesNegative ? ' mov-summary--negative' : ''}`} role="status" aria-live="polite">
                <p className="mov-summary__action">{summary.action}{valid ? <> of <strong>{product.name}</strong></> : null}</p>
                {summary.result && <p className="mov-summary__line">{summary.result}.</p>}
                {leavesNegative && !confirm && <p className="negative-notice">The balance will be negative. By recording, you confirm this negative balance.</p>}
                {summary.who && <p className="mov-summary__line">{summary.who}.</p>}
                <p className="mov-summary__missing">{summary.recordedBy}.</p>
                {missing.length > 0 && <p className="mov-summary__missing">Missing: {missing.join(', ')}.</p>}
            </div>}
            {confirm && <InlineNotification kind="warning" title="The balance changed" subtitle={confirm} hideCloseButton />}
            {error && <InlineNotification kind="error" title="Could not record" subtitle={error} hideCloseButton />}
            <div className="row">
                <Button className="mov-submit" size="xl" renderIcon={ArrowRight} disabled={missing.length > 0 || sending || (promotes && user.role !== 'admin')}
                    onClick={() => record(Boolean(confirm))}>{buttonLabel}</Button>
                {(leavesNegative || confirm) && user.role !== 'operator' && <Button kind="tertiary" disabled={sending} onClick={() => { setType('adjustment'); clear(); }}>Better to count and adjust</Button>}
            </div>
        </div>}
    </section>;
}
