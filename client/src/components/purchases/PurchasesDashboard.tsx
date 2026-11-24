import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    ActionableNotification, Button, ContentSwitcher, InlineLoading, InlineNotification, Switch, Table, TableBody,
    TableCell, TableHead, TableHeader, TableRow, Tag, Tile,
} from '@carbon/react';
import { fetchJson, errorMessage } from '../../queries';
import { money, shortDate, shortMonth, longMonth, percentage } from '../../money';
import type { GroupBy, LineStatus, PurchaseBook, Month, PurchasesSummary } from '../../purchases/types';

// Every amount goes through `money()`: the database doesn't know the currency, and rounding is done
// with BigInt because numeric -> Number can lose cents. Sums come from PostgreSQL. Only the bar
// proportions go through Number: an error in the tenth decimal doesn't change a bar's length.

const GROUPINGS: { name: GroupBy; text: string; explanation: string }[] = [
    {
        name: 'supplier', text: 'Supplier',
        explanation: 'Largest amount first. A supplier that does not exactly match the catalog is shown as written: similar names are not merged.',
    },
    {
        name: 'category', text: 'Category',
        explanation: 'By the category of the item the description is linked to. Unlinked lines stay apart: their category is unknown.',
    },
    {
        name: 'month', text: 'Month',
        explanation: 'By book month, largest amount first. A month with no book does not appear: it is not zero spend.',
    },
    { name: 'book', text: 'Book', explanation: 'By file, largest amount first.' },
];

const INTEGERS = new Intl.NumberFormat('en-US');
const DECIMAL = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

const countText = (n: number, one: string, many: string) => `${INTEGERS.format(n)} ${n === 1 ? one : many}`;
// A part with an amount that rounds to 0.0 isn't zero: "0 %" next to $599.36 would say nothing was bought.
const percentText = (p: number | null) => p === null ? '—'
    : p > 0 && p < 0.05 ? '< 0.1 %' : `${DECIMAL.format(p)} %`;
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const monthRange = (first: Month | null, last: Month | null) =>
    first === null || last === null ? '—'
        : first === last ? shortMonth(first) : `${shortMonth(first)} – ${shortMonth(last)}`;

/** Months between the first and last of the series that have no book. */
function monthsWithoutBook(series: { period: Month }[]): Month[] {
    if (series.length < 2) return [];
    const present = new Set(series.map(s => s.period));
    const missing: Month[] = [];
    let [year, month] = series[0].period.split('-').map(Number);
    const last = series[series.length - 1].period;
    for (;;) {
        const current = `${year}-${String(month).padStart(2, '0')}`;
        if (current >= last) break;
        if (!present.has(current)) missing.push(current);
        month += 1;
        if (month > 12) { month = 1; year += 1; }
    }
    return missing;
}

export function PurchasesDashboard({ from, to, books, onReview }: {
    from: Month | null;
    to: Month | null;
    /** All books, to show the month next to the file name in the by-book breakdown. */
    books: PurchaseBook[];
    /** Jumps to the book reader already filtered to those lines. */
    onReview: (status: LineStatus) => void;
}) {
    const [groupBy, setGroupBy] = useState<GroupBy>('supplier');

    const params = new URLSearchParams({ group_by: groupBy });
    if (from) params.set('from', from);
    if (to) params.set('to', to);

    // Each response is cached under the period and grouping that produced it. Changing the range
    // changes the key and drops the old data: showing it while the new loads would pin its totals
    // on the newly picked period. Only a grouping change within the same period keeps what's on screen.
    const query = useQuery({
        queryKey: ['purchases', 'summary', { from, to, groupBy }] as const,
        queryFn: fetchJson<PurchasesSummary>(`/api/purchases/summary?${params}`),
        placeholderData: (previous, previousQuery) => {
            const before = previousQuery?.queryKey[2];
            return before && before.from === from && before.to === to ? previous : undefined;
        },
    });

    const loading = query.isFetching;
    // After an error no figures are drawn: not the old ones, not while retrying.
    const error = query.error && !loading ? errorMessage(query.error) : null;
    // Summary, coverage and series don't depend on the grouping, so they stay while another breakdown loads.
    const data = query.error ? null : query.data ?? null;
    // The breakdown doesn't: a suppliers table under a "Category" header would be false. Placeholder
    // data is another grouping's, so its breakdown isn't used.
    const breakdown = data && !query.isPlaceholderData ? data.breakdown : null;

    if (error) return <div className="stack">
        <InlineNotification kind="error" title="Could not load the dashboard" subtitle={error} hideCloseButton />
        <div><Button kind="tertiary" onClick={() => { void query.refetch(); }}>Retry</Button></div>
    </div>;

    if (!data) return <InlineLoading description="Loading the books…" />;

    const { summary: s, coverage: c } = data;

    if (s.purchases === 0 && s.no_amount === 0 && s.notes === 0) return <Tile className="panel stack" role="status">
        <h2>No lines in this period</h2>
    </Tile>;

    const grouping = GROUPINGS.find(g => g.name === groupBy)!;
    const bookById = new Map(books.map(b => [String(b.id), b]));

    const parts = [
        { key: 'with-stock', title: 'Linked, tracks stock', ...c.with_stock },
        { key: 'without-stock', title: 'Linked, no stock', ...c.no_stock },
        { key: 'unlinked', title: 'Not linked', ...c.unlinked },
    ].map(p => ({ ...p, percent: p.purchases > 0 ? percentage(p.amount, s.amount) : null }));

    const series = data.monthly_series;
    const largest = Math.max(0, ...series.map(m => m.amount === null ? 0 : Number(m.amount)));
    const gaps = monthsWithoutBook(series);

    return <div className="stack">
        {loading && <InlineLoading description="Updating figures…" />}

        <div className="purchases-figures">
            <Tile className="panel metric purchases-figure--wide">
                <p className="muted">Amount for the period</p>
                <p className="metric-value purchases-total">{money(s.amount)}</p>
                {s.first_date !== null && <p className="muted">From {shortDate(s.first_date)} to {shortDate(s.last_date)}</p>}
            </Tile>
            <Tile className="panel metric purchases-figure--wide">
                <p className="muted">Purchase lines</p>
                <p className="metric-value">{INTEGERS.format(s.purchases)}</p>
                {(s.no_amount > 0 || s.notes > 0) && <p className="muted">
                    {[s.no_amount > 0 && `${INTEGERS.format(s.no_amount)} with no amount`, s.notes > 0 && countText(s.notes, 'note', 'notes')].filter(Boolean).join(' · ')}
                </p>}
            </Tile>
            <Tile className="panel metric">
                <p className="muted">Books</p>
                <p className="metric-value">{INTEGERS.format(data.period.books)}</p>
                <p className="muted">{monthRange(data.period.first_book, data.period.last_book)}</p>
            </Tile>
            <Tile className="panel metric">
                <p className="muted">Suppliers</p>
                <p className="metric-value">{INTEGERS.format(s.suppliers)}</p>
            </Tile>
        </div>

        {s.possible_duplicates > 0 && <ActionableNotification inline kind="info" lowContrast hideCloseButton
            title={`${countText(s.possible_duplicates, 'possible duplicate', 'possible duplicates')}`}
            actionButtonLabel="Review" onActionButtonClick={() => onReview('duplicate')} />}
        {s.dates_to_review > 0 && <ActionableNotification inline kind="info" lowContrast hideCloseButton
            title={`${countText(s.dates_to_review, 'date to review', 'dates to review')}`}
            actionButtonLabel="Review" onActionButtonClick={() => onReview('review')} />}

        <Tile className="panel stack">
            <h2>Catalog coverage</h2>
            <div className="purchases-stacked" role="img"
                aria-label={s.amount === null ? 'No amount to split'
                    : parts.map(p => `${p.title}: ${p.purchases > 0 ? percentText(p.percent) : 'no lines'}`).join('; ')}>
                {parts.map(p => p.percent !== null && p.percent > 0 &&
                    <span key={p.key} className={`purchases-stacked__part purchases-swatch--${p.key}`} style={{ width: `${p.percent}%` }} />)}
            </div>
            <ul className="purchases-legend">
                {parts.map(p => <li key={p.key}>
                    <span className={`purchases-swatch purchases-swatch--${p.key}`} aria-hidden="true" />
                    <div>
                        <p><strong>{p.title}</strong></p>
                        <p className="mono">{p.purchases > 0 ? `${money(p.amount)} · ${percentText(p.percent)}` : 'No lines'}</p>
                        {p.purchases > 0 && <p className="muted">{countText(p.purchases, 'line', 'lines')}</p>}
                    </div>
                </li>)}
            </ul>
            <p>{c.in_inventory.purchases === 1 ? '1 line in inventory'
                : `${INTEGERS.format(c.in_inventory.purchases)} lines in inventory`}
                {c.in_inventory.purchases > 0 && <span className="muted"> ({money(c.in_inventory.amount)})</span>}</p>
        </Tile>

        <Tile className="panel stack">
            <h2>Amount by month</h2>
            <ol className="purchases-series" aria-label="Amount and lines by book month">
                {series.map(m => <li key={m.period} className="purchases-series__row">
                    <span className="purchases-series__month">{shortMonth(m.period)}</span>
                    <span className="purchases-series__bar" aria-hidden="true">
                        {m.amount !== null && largest > 0 && <span style={{ width: `${(Number(m.amount) / largest) * 100}%` }} />}
                    </span>
                    <span className="purchases-series__figure"><span className="mono">{money(m.amount)}</span>
                        <span className="muted"> · {countText(m.purchases, 'line', 'lines')}</span></span>
                </li>)}
            </ol>
            {gaps.length > 0 && <p className="muted">No book: {gaps.map(shortMonth).join(', ')}</p>}
        </Tile>

        <Tile className="panel stack">
            <h2>Breakdown</h2>
            <ContentSwitcher className="purchases-group-by" aria-label="Group the amount by"
                selectedIndex={GROUPINGS.findIndex(g => g.name === groupBy)}
                onChange={({ name }) => { if (name && name !== groupBy) setGroupBy(name as GroupBy); }}>
                {GROUPINGS.map(g => <Switch key={g.name} name={g.name} text={g.text} />)}
            </ContentSwitcher>
            {breakdown === null ? <InlineLoading description="Grouping…" />
                : breakdown.length === 0 ? <p>No purchase lines in this period.</p>
                    : <div className="table-scroll" role="region" aria-label={`Amount by ${grouping.text.toLowerCase()}`} tabIndex={0}>
                        <Table className="purchases-groups" aria-label={`Amount by ${grouping.text.toLowerCase()}`}>
                            <TableHead><TableRow>
                                <TableHeader>{grouping.text}</TableHeader>
                                <TableHeader>Lines</TableHeader>
                                <TableHeader>Amount</TableHeader>
                            </TableRow></TableHead>
                            <TableBody>{breakdown.map((g, i) => {
                                const book = groupBy === 'book' && g.key !== null ? bookById.get(g.key) : undefined;
                                // "No supplier" groups the lines that don't name one: it isn't written in the book, so no tag.
                                const asTyped = g.as_typed && !(g.key === null && g.name === 'No supplier');
                                return <TableRow key={`${g.key ?? 'no-key'}-${i}`}>
                                    <TableCell>
                                        {groupBy === 'month' ? capitalize(longMonth(g.name))
                                            : book ? <>{capitalize(longMonth(book.period))}<span className="product-name">{g.name}</span></>
                                                : g.name}
                                        {asTyped && <span className="purchases-tags"><Tag type="outline" size="sm">as written in the book</Tag></span>}
                                    </TableCell>
                                    <TableCell className="mono">{INTEGERS.format(g.purchases)}</TableCell>
                                    <TableCell><span className="mono">{money(g.amount)}</span>
                                        <span className="product-name">{percentText(percentage(g.amount, s.amount))}</span></TableCell>
                                </TableRow>;
                            })}</TableBody>
                        </Table>
                    </div>}
        </Tile>
    </div>;
}
