import { Button, DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell } from '@carbon/react';
import type { CSSProperties } from 'react';
import type { Product } from '../types';
import { levelStateOf, formatQuantity, LEVEL_BACKGROUND } from '../level';
import { stockLevel } from '../theme';
import { shortDate, shortMonth, unitPriceText } from '../money';
import { StockCell, CountPanel } from './inventory/StockControl';
import { useCount } from './inventory/useCount';

// A column of small squares with a short label lets you spot the levels without reading hundreds of
// rows. Category, location and minimum are hidden on phones (`secondary-col`): the table doesn't fit
// there and the detail shows them anyway.
const COLUMNS = [
    { key: 'product', header: 'SKU / Description' },
    { key: 'category', header: 'Category', secondary: true },
    { key: 'location', header: 'Location', secondary: true },
    { key: 'quantity', header: 'Stock' },
    { key: 'minimum', header: 'Minimum', secondary: true },
    { key: 'status', header: 'Status' },
];
// Only if the server sent the key: operators don't get it.
const PURCHASE_COLUMN = { key: 'purchase', header: 'Last purchase', secondary: false };

export function ProductTable({ products, selected, onSelect }: {
    products: Product[]; selected: Product | null; onSelect: (p: Product) => void;
}) {
    const byId = new Map(products.map(p => [String(p.id), p]));
    const count = useCount();
    // Decided by the key, not the role: the screen shows what the API returned and doesn't guess permissions.
    const hasPurchase = products.some(p => p.last_purchase !== undefined);
    // The same key decides who can fix the stock from the table: storekeepers and admins (who see costs).
    // The server refuses the adjustment to operators, so they only read it.
    const headers = hasPurchase ? [...COLUMNS, PURCHASE_COLUMN] : COLUMNS;
    const secondary = new Set(headers.filter(h => 'secondary' in h && h.secondary).map(h => h.key));
    const data = products.map(p => ({ id: String(p.id), product: p.code, category: p.category, location: p.location, quantity: p.quantity, minimum: p.minimum, status: levelStateOf(p).short, purchase: p.last_purchase?.price ?? null }));
    if (!products.length) return <p className="muted">No products match those filters.</p>;
    // Carbon keeps internal row state; changing the set of ids resets it before a new page or filter renders.
    return <div className="table-scroll"><DataTable key={products.map(p => p.id).join(',')} rows={data} headers={headers}>
        {({ rows, headers: columns, getTableProps, getHeaderProps, getRowProps }) => (
            <Table {...getTableProps()} aria-label="Product catalog" className="catalog-table">
                <TableHead><TableRow>{columns.map(h => <TableHeader {...getHeaderProps({ header: h })} key={h.key}
                    className={secondary.has(h.key) ? 'secondary-col' : undefined}>{h.header}</TableHeader>)}</TableRow></TableHead>
                <TableBody>{rows.map(row => {
                    const p = byId.get(row.id)!;
                    // The whole row opens the detail (hitting the code with gloves was half the work). The code
                    // button stays for keyboard and screen readers; its click doesn't bubble to avoid opening twice.
                    const level = levelStateOf(p).level;
                    // On phones the level is also a color stripe on the card's edge; "no minimum" is hatched, not a color.
                    return <TableRow {...getRowProps({ row })} key={row.id} onClick={() => onSelect(p)}
                        style={level === 'no_minimum' ? undefined : { '--level': LEVEL_BACKGROUND[level] } as CSSProperties}
                        className={'product-row' + (selected?.id === p.id ? ' selected-row' : '')}>
                        {/* `data-product` is how focus returns here when the detail closes. */}
                        <TableCell className="product-cell"><button className="product-link" aria-label={'View details of ' + p.code} data-product={p.id}
                            onClick={e => { e.stopPropagation(); onSelect(p); }}>
                            {/* Plex Mono and a slashed zero keep dictated codes from being confused. */}
                            <span className="mono">{p.code}</span><span className="product-name">{p.brand ? p.brand + ' · ' : ''}{p.name}</span>
                            {/* Category and location have no column on phones: one small line. */}
                            <span className="mobile-only product-place">{p.category ?? 'No category'} · {p.location ?? 'No location'}</span>
                            {/* The supplier's number and what they call it: it's what the box and invoice carry. */}
                            {(p.supplier_codes ?? []).map(c => <span key={c.code} className="block text-xs text-text-2">
                                Supplier <span className="mono">{c.code}</span>{c.description ? ' · ' + c.description : ''}</span>)}
                        </button>
                        <CountPanel product={p} count={count} /></TableCell>
                        <TableCell className="secondary-col">{p.category ?? '—'}</TableCell>
                        <TableCell className="secondary-col">{p.location ?? <span className="muted">No location</span>}</TableCell>
                        {/* A zero says there's none: a pending count, or a product with no stock tracking, shows a dash. */}
                        <TableCell className="mono stock-cell"><StockCell product={p} count={count} canCount={hasPurchase} /></TableCell>
                        <TableCell className="mono secondary-col">{p.minimum === null ? '—' : formatQuantity(p.minimum)}</TableCell>
                        <TableCell className="status-cell"><StockState state={levelStateOf(p)} compact /></TableCell>
                        {hasPurchase && <TableCell className="purchase-cell">
                            {p.last_purchase
                                ? <><span className="mono">{unitPriceText(p.last_purchase.price)}</span>
                                    {/* No day in the book: show the book's month, it's all we know. */}
                                    <span className="muted note-cell">{p.last_purchase.date ? shortDate(p.last_purchase.date) : shortMonth(p.last_purchase.period)}</span></>
                                // "No purchases" would claim it was never bought, but only some book lines are
                                // linked and some bought products have a description with no link.
                                : <span className="muted">No linked purchase</span>}
                        </TableCell>}
                    </TableRow>;
                })}</TableBody>
            </Table>
        )}
    </DataTable></div>;
}

// Grey = unknown quantity; hatched = unknown minimum. They are not the same.
export function StockState({ state, compact = false }: { state: ReturnType<typeof levelStateOf>; compact?: boolean }) {
    // The restock amber has no contrast as text: use the dark ink.
    return <span className="stock-state" style={{ color: state.level === 'restock' ? stockLevel.restockText : undefined, fontWeight: state.level === 'below_min' ? 600 : 400 }}>
        <span className="stock-square" style={{ background: LEVEL_BACKGROUND[state.level] }} aria-hidden="true" />{compact ? state.short : state.label}
    </span>;
}
export function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
    return <Button kind={active ? 'secondary' : 'ghost'} size="sm" aria-pressed={active} onClick={onClick}>{label}</Button>;
}

// The minimum mark is required: without it the length doesn't say whether it's enough.
// The scale is twice the minimum; unknowns don't draw a quantity.
export function StockBar({ state }: { state: ReturnType<typeof levelStateOf> }) {
    return <div className={'stock-bar' + (state.proportion === null ? ' stock-unknown' : '')} aria-hidden="true">
        {state.proportion !== null && <>
            <div className="stock-fill" style={{ width: (state.proportion * 100) + '%', background: state.color ?? undefined }} />
            {state.minMark !== null && <span className="stock-mark" style={{ left: (state.minMark * 100) + '%' }} />}
        </>}
    </div>;
}
