import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
    Button, DataTableSkeleton, InlineLoading, InlineNotification, Modal, Search, Select, SelectItem, Tile,
} from '@carbon/react';
import { Add, Barcode, Filter, FilterReset } from '@carbon/icons-react';
import type { Category, Product, ProductsResponse, User } from '../../types';
import { toProduct } from '../../api';
import { fetchJson, errorMessage } from '../../queries';
import { Chip, ProductTable } from '../ProductTable';
import { Pagination } from '../Pagination';
import { ProductForm } from '../ProductForm';
import { ProductDetailModal } from './ProductDetailModal';

// Filters live in the URL, not in component state, so they survive opening a product, recording its movement
// and coming back, and a filtered view can be sent as a link. The history entry is replaced instead of
// stacked, so "back" leaves the inventory instead of undoing filters one by one.

type Filters = {
    q: string; status: string; category: string; location: string; control: string; sort: string; page: number;
};

// The options are the server's (levels, sorts and control filters in the products route).
const STATUSES = [
    { value: '', text: 'All statuses' },
    { value: 'below_min', text: 'Below minimum' },
    { value: 'restock', text: 'Restock needed' },
    { value: 'ample', text: 'Sufficient' },
    { value: 'no_minimum', text: 'No minimum set' },
    { value: 'uncounted', text: 'Uncounted' },
];
const CONTROLS = [
    { value: '', text: 'All' },
    { value: 'stock', text: 'Tracks stock' },
    { value: 'no_balance', text: 'Cost only, no stock' },
];
const SORTS = [
    { value: 'code', text: 'Code' },
    { value: 'name', text: 'Name' },
    { value: 'category', text: 'Category' },
    { value: 'location', text: 'Location' },
];
/** What the server understands as "no location". */
const NO_LOCATION = 'no_location';

/** The statuses people ask for daily, as chips on the phone. */
const QUICK = [
    { value: 'below_min', text: 'Below min' },
    { value: 'restock', text: 'Restock' },
    { value: 'uncounted', text: 'Uncounted' },
];

const valid = (list: { value: string }[], v: string | null) => list.some(o => o.value === v) ? v! : '';

// What the URL says, cleaned. A closed-list value the screen doesn't offer (old link, hand-edited) is ignored
// instead of sent for a 400 and an empty table. Category and location come from data and can't be checked
// here; if a link has one that no longer exists, its selector says so (see below).
function readFilters(p: URLSearchParams): Filters {
    const page = Number(p.get('page'));
    const location = p.get('location') ?? '';
    return {
        q: p.get('q') ?? '',
        status: valid(STATUSES, p.get('status')),
        category: /^\d+$/.test(p.get('category') ?? '') ? p.get('category')! : '',
        // The server rejects more than 100 characters (the column limit).
        location: location.length <= 100 ? location : '',
        control: valid(CONTROLS, p.get('control')),
        sort: valid(SORTS, p.get('sort')) || 'code',
        page: Number.isInteger(page) && page >= 1 ? page : 1,
    };
}

/** The /api/products URL: only sends what actually filters. */
function productsUrl(f: Filters): string {
    const params = new URLSearchParams();
    if (f.q.trim()) params.set('q', f.q.trim());
    if (f.status) params.set('level', f.status);
    if (f.category) params.set('category_id', f.category);
    if (f.location) params.set('location', f.location);
    if (f.control) params.set('control', f.control);
    if (f.sort !== 'code') params.set('sort', f.sort);
    params.set('page', String(f.page));
    return `/api/products?${params}`;
}

type Locations = { locations: { location: string; products: number }[]; no_location: number };

export function InventoryScreen({ user }: { user: User }) {
    const navigate = useNavigate();
    const [params, setParams] = useSearchParams();
    const filters = readFilters(params);
    const [selected, setSelected] = useState<Product | null>(null);
    const [adding, setAdding] = useState(false);
    // Narrow screens only: on a phone the five selectors took ~600 px before the first row. From `md` up they're always visible.
    const [filtersOpen, setFiltersOpen] = useState(false);

    /** Changes filters in the URL. Any new filter goes back to page 1. */
    function filter(changes: Partial<Omit<Filters, 'page'>>) {
        setParams(current => {
            const next = new URLSearchParams(current);
            for (const [key, value] of Object.entries(changes)) {
                if (value) next.set(key, String(value)); else next.delete(key);
            }
            next.delete('page');
            return next;
        }, { replace: true });
    }
    function goToPage(page: number) {
        setParams(current => {
            const next = new URLSearchParams(current);
            if (page > 1) next.set('page', String(page)); else next.delete('page');
            return next;
        }, { replace: true });
    }

    // Typing reaches the URL 300 ms after the last key, otherwise every letter would change the query key and fire
    // a request. If the URL changes elsewhere ("back", "Clear"), the field follows: adjusted during render, not in an effect.
    //
    // `typedQ` is what the timer itself wrote. The router applies the URL change inside a transition, so if another
    // key lands first the new URL ("drill") catches up when the field already says "drills", and without this mark
    // the adjustment took it for an outside change and ate the "s". It's state, not a ref, because it's read during render.
    const [search, setSearch] = useState(filters.q);
    const [seenQ, setSeenQ] = useState(filters.q);
    const [typedQ, setTypedQ] = useState<string | null>(null);
    if (filters.q !== seenQ) {
        setSeenQ(filters.q);
        if (filters.q !== typedQ) setSearch(filters.q);
    }
    // Not trimmed: if the URL held "drill" while someone types "drill bit", the field would be rewritten from the
    // URL and eat the space mid-word. It's trimmed when the query is built.
    useEffect(() => {
        if (search === filters.q) return;
        const id = setTimeout(() => {
            setTypedQ(search);
            setParams(current => {
                const next = new URLSearchParams(current);
                if (search) next.set('q', search); else next.delete('q');
                next.delete('page');
                return next;
            }, { replace: true });
        }, 300);
        return () => clearTimeout(id);
    }, [search, filters.q, setParams]);

    // Filter before paginating: the total is for the filtered catalog.
    const { data: response, isPending: loading, isFetching, error, refetch } = useQuery({
        // Trimmed search: "drill" and "drill " are the same query.
        queryKey: ['products', { ...filters, q: filters.q.trim() }],
        queryFn: fetchJson<ProductsResponse>(productsUrl(filters)),
        // On a filter, search or page change the old table stays with an "updating" notice on top, not a skeleton.
        placeholderData: keepPreviousData,
    });
    const products = response ? response.products.map(toProduct) : [];
    const total = response ? response.total : null;

    // Categories and locations change little; one shared query.
    const categoriesQuery = useQuery({ queryKey: ['categories'], queryFn: fetchJson<Category[]>('/api/categories') });
    const categories = categoriesQuery.data ?? [];
    const { data: locations } = useQuery({ queryKey: ['products', 'locations'], queryFn: fetchJson<Locations>('/api/locations') });

    const active = [filters.q.trim(), filters.status, filters.category, filters.location, filters.control].filter(Boolean).length;

    const outOfRange = response !== undefined && response.total > 0
        && response.products.length === 0 && filters.page > 1;

    // On closing the detail, focus goes back to the row's button; landing on <body> forces keyboard and screen
    // reader users to walk the filters and rows from the top. It's an effect so it runs after the modal unmounted.
    // A new object on each close so closing the same product twice fires it again.
    const [returnFocus, setReturnFocus] = useState<{ id: number } | null>(null);
    function closeDetail() {
        if (selected) setReturnFocus({ id: selected.id });
        setSelected(null);
    }
    useEffect(() => {
        if (returnFocus) document.querySelector<HTMLElement>(`[data-product="${returnFocus.id}"]`)?.focus();
    }, [returnFocus]);

    return <section className="page stack">
        <div className="page-heading">
            <div><h1>Inventory</h1></div>
            <div className="row">
                {/* Adding needs storekeeper or admin in the API too. On the phone it's a small "+": Record is already
                    in the bottom bar and two big buttons ate the first screen. */}
                {user.role !== 'operator' && <>
                    <Button kind="tertiary" renderIcon={Add} className="desktop-only" onClick={() => setAdding(true)}>Add product</Button>
                    <Button kind="tertiary" hasIconOnly renderIcon={Add} iconDescription="Add a product" tooltipPosition="left"
                        className="mobile-only" onClick={() => setAdding(true)} />
                </>}
                <Button as={Link} to="/movement" className="desktop-only">Record movement</Button>
            </div>
        </div>
        {error && <><InlineNotification kind="error" title="Could not load the catalog" subtitle={errorMessage(error)} hideCloseButton />
            <Button kind="tertiary" onClick={() => refetch()}>Retry</Button></>}

        <Tile className="panel stack">
            <div className="row spread">
                <h2>{total === null ? 'Catalog' : `Catalog · ${total} ${total === 1 ? 'product' : 'products'}`}</h2>
                {active > 0 && <Button kind="ghost" size="sm" renderIcon={FilterReset}
                    onClick={() => { setSearch(''); setTypedQ(null); setParams(new URLSearchParams(filters.sort !== 'code' ? { sort: filters.sort } : {}), { replace: true }); }}>
                    Clear filters ({active})
                </Button>}
            </div>
            {/* On the phone the search stays on top while scrolling (with 600 products, scrolling back up to search again
                was the worst part) and has the scan shortcut next to it. */}
            <div className="inventory-search">
                <div className="min-w-0 flex-1">
                    <Search id="search-catalog" labelText="Search by code or name" placeholder="Search by code or name"
                        closeButtonLabelText="Clear search" value={search} onChange={e => setSearch(e.target.value)} />
                </div>
                <Button as={Link} to="/scan" kind="ghost" hasIconOnly renderIcon={Barcode} iconDescription="Scan a code" tooltipPosition="left" className="mobile-only" />
            </div>
            {/* The most common searches, one tap away (desktop has the selectors). Each chip toggles its filter. */}
            <div className="mobile-only quick-chips flex flex-wrap gap-2" role="group" aria-label="Quick filters">
                {QUICK.map(r => <Chip key={r.value} label={r.text} active={filters.status === r.value} onClick={() => filter({ status: filters.status === r.value ? '' : r.value })} />)}
                {(locations?.no_location ?? 0) > 0 && <Chip label="No location" active={filters.location === NO_LOCATION}
                    onClick={() => filter({ location: filters.location === NO_LOCATION ? '' : NO_LOCATION })} />}
            </div>
            <Button kind="ghost" size="sm" className="self-start md:hidden" renderIcon={Filter} aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen(a => !a)}>
                {filtersOpen ? 'Hide filters' : active > 0 ? `Filters (${active})` : 'Filters and sort'}
            </Button>
            <div className={filtersOpen ? 'inventory-filters' : 'inventory-filters inventory-filters--collapsed'}>
                <Select id="filter-status" labelText="Status" value={filters.status} onChange={e => filter({ status: e.target.value })}>
                    {STATUSES.map(o => <SelectItem key={o.value} value={o.value} text={o.text} />)}
                </Select>
                {/* If the URL has a category or location that no longer exists (old link), it's added as an option:
                    otherwise the selector would say "All" while the table filters by something out of sight. */}
                <Select id="filter-category" labelText="Category" value={filters.category} onChange={e => filter({ category: e.target.value })}>
                    <SelectItem value="" text="All categories" />
                    {categories.map(c => <SelectItem key={c.id} value={String(c.id)} text={c.name} />)}
                    {filters.category && categories.length > 0 && !categories.some(c => String(c.id) === filters.category)
                        && <SelectItem value={filters.category} text="Category that no longer exists" />}
                </Select>
                {/* Locations come from the data, with how many products each has: picking an empty one isn't possible. */}
                <Select id="filter-location" labelText="Location" value={filters.location} onChange={e => filter({ location: e.target.value })}>
                    <SelectItem value="" text="All locations" />
                    {(locations?.locations ?? []).map(u => <SelectItem key={u.location} value={u.location} text={`${u.location} (${u.products})`} />)}
                    {(locations?.no_location ?? 0) > 0 && <SelectItem value={NO_LOCATION} text={`No location (${locations!.no_location})`} />}
                    {locations && filters.location && filters.location !== NO_LOCATION
                        && !locations.locations.some(u => u.location === filters.location)
                        && <SelectItem value={filters.location} text={`${filters.location} (no products)`} />}
                </Select>
                <Select id="filter-control" labelText="Control" value={filters.control} onChange={e => filter({ control: e.target.value })}>
                    {CONTROLS.map(o => <SelectItem key={o.value} value={o.value} text={o.text} />)}
                </Select>
                <Select id="filter-sort" labelText="Sort by" value={filters.sort} onChange={e => filter({ sort: e.target.value === 'code' ? '' : e.target.value })}>
                    {SORTS.map(o => <SelectItem key={o.value} value={o.value} text={o.text} />)}
                </Select>
            </div>

            {/* "No products match these filters" is only claimed with a response in hand. If loading failed the error
                is already above; an empty table below would say there's nothing when it's really unknown. */}
            {!response
                ? (error ? null : <DataTableSkeleton columnCount={6} rowCount={5} showHeader={false} showToolbar={false} />)
                : outOfRange
                    // The page lives in the URL: coming back after counting products, or with an old link, it can
                    // be past the end. Say so instead of claiming there's nothing.
                    ? <div className="stack">
                        <p>That page no longer exists: with these filters there {response.total === 1 ? 'is' : 'are'} {response.total} {response.total === 1 ? 'product' : 'products'}.</p>
                        <div><Button kind="tertiary" size="md" onClick={() => goToPage(response.pages)}>Go to page {response.pages}</Button></div>
                    </div>
                    : <ProductTable products={products} selected={selected} onSelect={setSelected} />}
            {isFetching && !loading && <InlineLoading description="Updating catalog…" />}
            {total !== null && <Pagination total={total} page={filters.page} disabled={isFetching} onChange={goToPage} />}
        </Tile>

        {/* Only the code goes to Record: the row can be hours old, and that screen asks for the product again. */}
        {selected && <ProductDetailModal key={selected.id} product={selected} user={user}
            onClose={closeDetail} onChange={setSelected}
            onRecord={p => navigate('/movement', { state: { code: p.code } })} />}

        {adding && <Modal open passiveModal size="md" modalHeading="Add a product"
            closeButtonLabel="Close" onRequestClose={() => setAdding(false)}>
            {/* The form gets `null` while loading or on failure, not an empty list: "no categories yet" is only said
                when there really are none (see CategoryField). */}
            <ProductForm categories={categoriesQuery.data ?? null}
                categoriesError={categoriesQuery.error && !categoriesQuery.isFetching ? errorMessage(categoriesQuery.error) : null}
                onRetryCategories={() => { void categoriesQuery.refetch(); }} />
        </Modal>}
    </section>;
}
