import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    Button, InlineLoading, InlineNotification, Search, Select, SelectItem, Table, TableBody,
    TableCell, TableHead, TableHeader, TableRow, Tag,
} from '@carbon/react';
import { fetchJson, errorMessage } from '../../queries';
import { quantityText, money, shortDate, longMonth, unitPriceText } from '../../money';
import type { LineStatus, SupplierFilter, PurchaseBook, Month, PurchaseLine, LinesResponse } from '../../purchases/types';
import { Pagination } from '../Pagination';

// The purchase books in reading order: book -> sheet -> line. The server sets the order (the
// Excel reading order); here it's just cut into sheets. Nothing is rewritten, and the cell stays
// visible so the original file can be checked.

const STATUSES: { value: LineStatus; text: string }[] = [
    { value: 'all', text: 'All' },
    { value: 'unlinked', text: 'Not linked' },
    { value: 'linked', text: 'Linked' },
    { value: 'review', text: 'Date to review' },
    { value: 'duplicate', text: 'Possible duplicate' },
];

const COLUMNS = ['Date', 'Item', 'Supplier and folio', 'Quantity', 'Price', 'Amount', 'Why'];

const INTEGERS = new Intl.NumberFormat('en-US');
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** 'YYYY-MM' -> 'AUGUST 2025', the way books are labeled. */
const monthLabel = (period: Month) => longMonth(period).toUpperCase();

/** Cuts the page into sheets: a new group starts whenever the book or sheet changes. */
function bySheet(lines: PurchaseLine[]) {
    const groups: { key: string; title: string; lines: PurchaseLine[] }[] = [];
    for (const line of lines) {
        const key = `${line.book.id}|${line.sheet}`;
        const last = groups[groups.length - 1];
        if (last?.key === key) last.lines.push(line);
        else groups.push({ key, title: `${monthLabel(line.book.period)} · Sheet ${line.sheet}`, lines: [line] });
    }
    return groups;
}

/** The filters without the page: which query a set of lines belongs to. */
const filtersOf = (from: Month | null, to: Month | null, book: number | null, status: LineStatus, q: string, supplier: SupplierFilter | null) =>
    JSON.stringify([from, to, book, status, q, supplier]);

/**
 * A page requested past the last one: a link was made or removed in Bring to catalog and the total
 * dropped. The server repeats the requested page, so the response alone says whether this is one.
 */
const pageMissing = (d: LinesResponse) =>
    d.lines.length === 0 && d.page > Math.max(1, d.pages);

export function BookReader({ from, to, books, supplier, onClearSupplier, status, onStatus }: {
    from: Month | null;
    to: Month | null;
    /** The dashboard sets this too and sends people here with the filter already on. */
    status: LineStatus;
    onStatus: (status: LineStatus) => void;
    /** The books in the chosen period, for the book filter. */
    books: PurchaseBook[];
    /** Set when arriving from Suppliers: only that supplier's lines. */
    supplier: SupplierFilter | null;
    onClearSupplier: () => void;
}) {
    const [bookId, setBookId] = useState<number | null>(null);
    const [search, setSearch] = useState('');
    const [q, setQ] = useState('');
    const [pageFor, setPageFor] = useState<{ filters: string; page: number } | null>(null);

    // Wait until typing stops: a request per letter would make the table flicker and an old response could win.
    useEffect(() => {
        const id = setTimeout(() => setQ(search.trim()), 300);
        return () => clearTimeout(id);
    }, [search]);

    // If the period changes and the chosen book falls outside it, read all the period's books.
    // Adjusted during render, not in an effect, so no request goes out with a book the period no
    // longer has. The choice is forgotten, not just hidden, or widening the period would bring it
    // back with the select saying "All" while the table showed one book.
    const bookInPeriod = bookId !== null && books.some(b => b.id === bookId);
    if (bookId !== null && !bookInPeriod) setBookId(null);
    const book = bookInPeriod ? bookId : null;
    const filters = filtersOf(from, to, book, status, q, supplier);
    // The page only counts for the filters it was picked with; with others, start at the first.
    const page = pageFor?.filters === filters ? pageFor.page : 1;

    const params = new URLSearchParams({ page: String(page) });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (book !== null) params.set('book_id', String(book));
    if (status !== 'all') params.set('status', status);
    if (q) params.set('q', q);
    // Catalog suppliers filter by id; one that's only written in the books, by its exact text.
    if (supplier) params.set(supplier.id === null ? 'supplier_text' : 'supplier_id', supplier.id === null ? supplier.name : String(supplier.id));
    const url = `/api/purchases?${params}`;

    // Same rule as the dashboard: each response is stored with the filters that produced it. Only
    // when the query is the same except for the page does the previous one stay on screen (placeholder).
    const query = useQuery({
        queryKey: ['purchases', 'lines', { from, to, book, status, q, supplier, page }] as const,
        queryFn: fetchJson<LinesResponse>(url),
        placeholderData: (previous, previousQuery) => {
            const before = previousQuery?.queryKey[2];
            return before && previous && !pageMissing(previous)
                && filtersOf(before.from, before.to, before.book, before.status, before.q, before.supplier) === filters
                ? previous : undefined;
        },
    });
    const response = query.data;

    // If the page stopped existing (a link changed the total), step back to the last one; an empty
    // page would say "no lines" when there are some. Adjusted during render and only on a confirmed
    // response: a stale cached copy can claim the page is gone while it's refetching and turns out fine.
    if (response && !query.isPlaceholderData && !query.isFetching && pageMissing(response)) {
        setPageFor({ filters, page: Math.max(1, response.pages) });
    }

    const loading = query.isFetching;
    // Paging keeps the previous page on screen until the next arrives: every line says which book
    // and sheet it's from, so none is credited to the wrong one. After an error no lines are drawn.
    const data = query.error || !response || pageMissing(response) ? null : response;
    const error = query.error && !loading ? errorMessage(query.error) : null;
    const repeated = new Set(books.map(b => b.period).filter((p, i, all) => all.indexOf(p) !== i));

    return <div className="stack">
        {supplier && <div className="flex flex-wrap items-center gap-2">
            <Tag type="blue">Supplier: {supplier.name}</Tag>
            <Button kind="ghost" size="sm" onClick={onClearSupplier}>Remove this filter</Button>
        </div>}
        <div className="purchases-filters">
            <Select id="purchases-book" labelText="Book" value={book === null ? '' : String(book)}
                onChange={e => { setBookId(e.target.value ? Number(e.target.value) : null); setPageFor(null); }}>
                <SelectItem value="" text="All books in the period" />
                {books.map(b => <SelectItem key={b.id} value={String(b.id)}
                    text={repeated.has(b.period) ? `${capitalize(longMonth(b.period))} · ${b.file}` : capitalize(longMonth(b.period))} />)}
            </Select>
            <Search id="purchases-search" size="md" labelText="Search the books" closeButtonLabelText="Clear search"
                placeholder="Description, folio, supplier, requester or note" value={search}
                onChange={e => setSearch(e.target.value)} />
            <Select id="purchases-status" labelText="Status" value={status}
                onChange={e => { onStatus(e.target.value as LineStatus); setPageFor(null); }}>
                {STATUSES.map(s => <SelectItem key={s.value} value={s.value} text={s.text} />)}
            </Select>
        </div>

        {loading && <InlineLoading description="Reading the books…" />}
        {error && <>
            <InlineNotification kind="error" title="Could not read the books" subtitle={error} hideCloseButton />
            <div><Button kind="tertiary" onClick={() => { void query.refetch(); }}>Retry</Button></div>
        </>}

        {data && data.total === 0 && <p role="status">No lines match these filters.</p>}
        {data && data.total > 0 && <>
            <p className="muted">{data.total === 1 ? '1 line' : `${INTEGERS.format(data.total)} lines`}, in book order.</p>
            <div className="table-scroll" role="region" aria-label="Book lines, scrolls horizontally" tabIndex={0}>
                <Table className="purchases-lines" aria-label="Purchase book lines" aria-busy={loading}>
                    <TableHead><TableRow>{COLUMNS.map(c => <TableHeader key={c}>{c}</TableHeader>)}</TableRow></TableHead>
                    {bySheet(data.lines).map(g => <TableBody key={g.key}>
                        <TableRow className="purchases-sheet">
                            <th colSpan={COLUMNS.length} scope="rowgroup">{g.title}</th>
                        </TableRow>
                        {g.lines.map(l => <Line key={l.id} line={l} />)}
                    </TableBody>)}
                </Table>
            </div>
            <Pagination total={data.total} page={page} disabled={loading}
                onChange={p => { if (p !== page) setPageFor({ filters, page: p }); }} />
        </>}
    </div>;
}

function Line({ line }: { line: PurchaseLine }) {
    const labels = [
        line.type === 'no_amount' && 'No amount',
        line.type === 'note' && 'Note',
        line.possible_duplicate && 'Possible duplicate',
        line.in_inventory && 'In inventory',
    ].filter((e): e is string => typeof e === 'string');

    return <TableRow>
        <TableCell>
            <span className="mono purchases-date">{shortDate(line.date)}</span>
            {line.date_to_review && <span className="purchases-tags">
                <Tag type="warm-gray" size="sm">To review</Tag>
                <span className="purchases-small">{line.date_status}</span>
            </span>}
            <span className="purchases-small mono">Cell {line.cell}</span>
        </TableCell>
        <TableCell>
            <span className="purchases-description">{line.description}</span>
            {/* A note isn't a purchase: nothing to link. */}
            {line.type !== 'note' && (line.product
                ? <span className="product-name">Linked to <span className="mono">{line.product.code}</span> — {line.product.name}</span>
                : <span className="product-name">Not linked</span>)}
            {labels.length > 0 && <span className="purchases-tags">
                {labels.map(e => <Tag key={e} type="gray" size="sm">{e}</Tag>)}
            </span>}
        </TableCell>
        {/* On a note with no supplier or folio, "No supplier" would suggest a purchase missing data; there is no purchase. */}
        <TableCell>{line.type === 'note' && !line.supplier && !line.folio ? '—' : <>
            {line.supplier ?? 'No supplier'}
            <span className="product-name">{line.folio ? <>Folio <span className="mono">{line.folio}</span></> : 'No folio'}</span>
        </>}</TableCell>
        <TableCell className="mono purchases-num">{quantityText(line.quantity)}</TableCell>
        <TableCell className="mono purchases-num">{unitPriceText(line.unit_price)}</TableCell>
        <TableCell className="mono purchases-num">{money(line.amount)}</TableCell>
        <TableCell>
            {line.note && <span className="purchases-block">{line.note}</span>}
            {line.requester && <span className="purchases-block muted">Requested by: {line.requester}</span>}
            {!line.note && !line.requester && '—'}
        </TableCell>
    </TableRow>;
}
