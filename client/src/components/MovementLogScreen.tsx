import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Tile, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, InlineNotification, InlineLoading, Tag } from '@carbon/react';
import { Pagination } from './Pagination';
import { Chip } from './ProductTable';
import { colors } from '../theme';
import { formatQuantity } from '../level';
import { fetchJson, errorMessage } from '../queries';

// Read-only list of every warehouse movement (the full list for audits, not the quick flow of MovementScreen).

type Movement = {
    id: number;
    type: 'in' | 'out' | 'adjustment' | 'loan' | 'return';
    quantity: string;
    /** Only sent to storekeeper and admin: the server omits it for operators. */
    unit_price?: string | null;
    folio: string | null;
    note: string | null;
    date: string;
    /** 'historical' = initial load from the books: no author and no time of day. */
    origin: string;
    over_negative: boolean;
    product_id: number;
    code: string;
    product: string;
    user_id: number;
    user: string;
    responsible_id: number | null;
    responsible: string | null;
};

type MovementsResponse = {
    movements: Movement[];
    total: number;
    page: number;
    pages: number;
};

const TYPE_FILTERS = [
    { label: 'All', value: null },
    { label: 'In', value: 'in' },
    { label: 'Out', value: 'out' },
    { label: 'Adjustments', value: 'adjustment' },
    { label: 'Loans', value: 'loan' },
    { label: 'Returns', value: 'return' },
] as const;

type TypeFilter = typeof TYPE_FILTERS[number]['value'];

/** Short label per type, for the TYPE column. */
const TYPE_LABEL: Record<Movement['type'], { text: string }> = {
    in: { text: 'IN' },
    out: { text: 'OUT' },
    adjustment: { text: 'ADJUSTMENT' },
    loan: { text: 'LOAN' },
    return: { text: 'RETURN' },
};

// Sign and color of the quantity by type. The color is a per-mode variable (index.scss) and never the only
// carrier of direction: the sign (+ / −) and the TYPE column say it too.
function signedQuantity(m: Movement): { text: string; color: string } {
    // The first count of an uncounted product stores the difference against a meaningless balance; the fact is the
    // counted figure (note: "First physical count: 5"), so that's what is shown.
    const first = m.type === 'adjustment' ? m.note?.match(/^First physical count: ([\d.]+)/) : null;
    if (first) return { text: `= ${formatQuantity(parseFloat(first[1]))}`, color: colors.ink };
    const n = formatQuantity(parseFloat(m.quantity));
    if (m.type === 'in' || m.type === 'return') {
        return { text: `+${n}`, color: 'var(--mov-in)' };
    }
    if (m.type === 'out' || m.type === 'loan') {
        return { text: `−${n}`, color: 'var(--mov-out)' };
    }
    return { text: n, color: colors.ink };
}

// The historical load has no time of day (everything sits at midnight), and "12:00 AM" would claim one.
function dateTime(iso: string, origin: string): string {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const date = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
    if (origin === 'historical') return date;
    const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `${date} ${time}`;
}

export function MovementLogScreen({ onBack }: { onBack: () => void }) {
    const [page, setPage] = useState(1);
    const [filter, setFilter] = useState<TypeFilter>(null);

    const params = new URLSearchParams();
    if (filter) params.set('type', filter);
    params.set('page', String(page));

    const query = useQuery({
        queryKey: ['movements', { type: filter, page }],
        queryFn: fetchJson<MovementsResponse>(`/api/movements?${params}`),
        // Keep the previous rows while the next ones load, instead of an empty table on every click.
        placeholderData: previous => previous,
    });

    const movements = query.data?.movements ?? [];
    const total = query.data?.total ?? 0;
    // isFetching covers the first load and every refetch on filter or page change.
    const loading = query.isFetching;
    const error = query.error ? errorMessage(query.error) : null;

    function changeFilter(value: TypeFilter) {
        setFilter(value);
        setPage(1);
    }

    function goToPage(next: (p: number) => number) {
        setPage(next);
    }

    return <section className="page stack">
        <div className="page-heading"><div><h1>Movements</h1></div><Button kind="ghost" onClick={onBack}>Inventory</Button></div>
        {error && <><InlineNotification kind="error" title="Could not load the movement log" subtitle={error} hideCloseButton /><Button kind="tertiary" onClick={() => query.refetch()}>Retry</Button></>}
        <Tile className="panel stack">
            <div className="row spread"><h2>Log</h2><div className="row" role="group" aria-label="Filter by type">{TYPE_FILTERS.map(f => <Chip key={f.label} label={f.label} active={filter === f.value} onClick={() => changeFilter(f.value)} />)}</div></div>
            {loading && <InlineLoading description="Loading movements…" />}
            {!movements.length && !loading && !error && <p>No movements match this filter.</p>}
            {!!movements.length && <div className="table-scroll"><Table className="history-table card-table" aria-label="Movement history">
                <TableHead><TableRow>{['Date / time','Type','Product','Who','Quantity','Folio / note'].map(h => <TableHeader key={h}>{h}</TableHeader>)}</TableRow></TableHead>
                <TableBody>{movements.map(m => {
                    const quantity = signedQuantity(m);
                    // COALESCE makes responsible equal to the author when they're the same person.
                    // Only show both when they differ.
                    const differs = m.responsible_id !== null && m.responsible !== null && m.responsible !== m.user;
                    return <TableRow key={m.id}>
                        <TableCell className="mono">{dateTime(m.date, m.origin)}</TableCell>
                        <TableCell><Tag type="gray">{TYPE_LABEL[m.type].text}</Tag></TableCell>
                        <TableCell><span className="mono">{m.code}</span><span className="product-name">{m.product}</span></TableCell>
                        <TableCell data-label="Who">{m.user ?? (m.origin === 'historical' ? 'Historical load' : 'Not recorded')}{differs && <p className="muted">For {m.responsible}</p>}</TableCell>
                        <TableCell className="mono" data-label="Quantity">{quantity.text}</TableCell>
                        <TableCell data-label="Folio / note">{m.folio && <p>{m.folio}</p>}{m.note && <p>{m.note}</p>}{!m.folio && !m.note && '—'}{m.over_negative && <p><strong>Left a negative balance · confirmed</strong></p>}</TableCell>
                    </TableRow>;
                })}</TableBody>
            </Table></div>}
            <Pagination total={total} page={page} disabled={loading} onChange={p => goToPage(() => p)} />
        </Tile>
    </section>;
}
