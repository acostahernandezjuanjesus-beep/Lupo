import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineLoading, InlineNotification, Modal, Select, SelectItem, Tag, TextInput } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import type { Product, User } from '../../types';
import { requestJson } from '../../api';
import { fetchJson, errorMessage } from '../../queries';
import { levelStateOf, formatQuantity, balanceKnown } from '../../level';
import { quantityText, money, shortDate, shortMonth, unitPriceText } from '../../money';
import { StockBar, StockState } from '../ProductTable';
import { EditProductModal } from './EditProductModal';

// Everything the system knows about one product. A modal, because on a phone a side column ended up below
// 50 rows and tapping a row showed nothing. Only verifiable fields: no purchase unit, last count or main supplier.

type Movement = {
    id: number;
    type: 'in' | 'out' | 'adjustment' | 'loan' | 'return';
    quantity: string;
    date: string;
    /** 'historical' = initial load from the books: no author and no time of day. */
    origin: string;
    note: string | null;
    over_negative: boolean;
    user: string | null;
    responsible: string | null;
};
type MovementsResponse = { movements: Movement[]; total: number };
type LinkedCode = { id: number; code: string; format: string | null; type: 'barcode' | 'supplier'; description: string | null; pieces: number | null; created_at: string; created_by: string | null };
type ProductPurchase = {
    id: number; date: string | null; period: string; description: string;
    quantity: string | null; price: string | null; amount: string | null; supplier: string | null; folio: string | null;
};
type ProductPurchases = {
    /** No quantity total: the book doesn't store the unit. */
    summary: { purchases: number; amount: string | null; first_date: string | null; last_date: string | null };
    purchases: ProductPurchase[];
};

/** How many movements to show here. The full history is in the movement log. */
const VISIBLE_MOVEMENTS = 10;

const DIRECTION: Record<Movement['type'], { label: string; sign: string }> = {
    in: { label: 'In', sign: '+' },
    return: { label: 'Return', sign: '+' },
    out: { label: 'Out', sign: '−' },
    loan: { label: 'Loan', sign: '−' },
    adjustment: { label: 'Adjustment', sign: '' },
};

const DATE_TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'short', timeStyle: 'short' });
const DATE_ONLY = new Intl.DateTimeFormat('en-US', { dateStyle: 'short' });

// The historical load has no time of day (everything sits at midnight), and "12:00 AM" would claim one.
const dateOf = (m: Movement) => (m.origin === 'historical' ? DATE_ONLY : DATE_TIME).format(new Date(m.date));
const whoOf = (m: Movement) => m.responsible ?? m.user ?? (m.origin === 'historical' ? 'Historical load' : 'Not recorded');

// An adjustment stores the unsigned DIFFERENCE; whether it was a surplus or a shortfall is only in the
// server-written note ("Physical count: 7 (surplus of 2)"). No recognizable note, no sign.
function signOf(m: Movement) {
    if (m.type !== 'adjustment') return DIRECTION[m.type].sign;
    if (m.note?.includes('(surplus of')) return '+';
    if (m.note?.includes('(shortfall of')) return '−';
    return '';
}

// The first count of an uncounted product stores the difference against a meaningless balance
// (note: "First physical count: 5"). The counted figure is the fact, so show "= 5", not "8".
function quantityOf(m: Movement) {
    const first = m.type === 'adjustment' ? m.note?.match(/^First physical count: ([\d.]+)/) : null;
    if (first) return `= ${quantityText(first[1])}`;
    return signOf(m) + quantityText(m.quantity);
}

const CONTROL: Record<Product['control_type'], string> = {
    stock: 'Tracks stock',
    no_balance: 'Cost only, no stock',
    unit: 'Unit',
};

type Props = {
    product: Product;
    user: User;
    onClose: () => void;
    onRecord: (product: Product) => void;
    /** The product changed after an edit: whoever shows it swaps in this one. */
    onChange: (product: Product) => void;
};

export function ProductDetailModal({ product, user, onClose, onRecord, onChange }: Props) {
    const [editing, setEditing] = useState(false);
    const state = levelStateOf(product);
    // Decided by the key, not the role: no price from the server means no costs for this user,
    // and the purchases would be a 403 anyway.
    const seesCosts = product.price !== undefined;

    // Query keys share the prefixes the other screens invalidate: linking a code invalidates ['products'],
    // recording a movement ['movements'], and linking or bringing in Purchases ['purchases'].
    const codes = useQuery({
        queryKey: ['products', product.id, 'codes'],
        queryFn: fetchJson<LinkedCode[]>(`/api/products/${product.id}/codes`),
    });
    const movements = useQuery({
        queryKey: ['movements', { product_id: product.id }],
        queryFn: fetchJson<MovementsResponse>(`/api/movements?product_id=${product.id}`),
    });
    const purchases = useQuery({
        queryKey: ['purchases', 'product', product.id],
        queryFn: fetchJson<ProductPurchases>(`/api/products/${product.id}/purchases`),
        enabled: seesCosts,
    });

    const data: [string, string][] = [
        ['Category', product.category ?? 'Uncategorized'],
        ['Location', product.location ?? 'No location'],
        ['Unit', product.unit],
        ['Control', CONTROL[product.control_type]],
    ];
    // Brand and group exist on few products: no row where there's none, "Generic" would claim something nobody entered.
    if (product.brand) data.push(['Brand', product.brand]);
    if (product.group_name) data.push(['Group', product.group_name]);
    data.push(['Restock', product.restock_control === 'manual' ? 'Declared' : 'Calculated']);
    // The supplier's number as printed on the box and the invoice. If none is linked, say so.
    const supplierCodes = product.supplier_codes ?? [];
    if (supplierCodes.length === 0) data.push(['Supplier code', 'Not recorded']);
    for (const c of supplierCodes) data.push(['Supplier code', c.description ? `${c.code} · ${c.description}` : c.code]);

    const lp = product.last_purchase;

    // Editing replaces the detail while it lasts; two stacked modals would fight over focus and scrolling.
    if (editing) return <EditProductModal product={product} user={user} onClose={() => setEditing(false)}
        onSaved={p => { setEditing(false); onChange(p); }} />;

    return <Modal open passiveModal size="lg" hasScrollingContent
        className="product-detail"
        modalLabel={product.code} modalHeading={product.name}
        closeButtonLabel="Close" onRequestClose={onClose}>
        <div className="stack">
            <section className="detail-section detail-stock" aria-label="Stock">
                <div className="row spread">
                    <div className="row">
                        {/* A zero would claim there's none: uncounted or untracked shows a dash (see `balanceKnown`). */}
                        <span className="stock-quantity">{balanceKnown(product) ? formatQuantity(product.quantity) : '—'}</span>
                        <span>{product.unit}</span>
                    </div>
                    <div className="row">
                        {/* Fixing the record is for storekeeper and admin (the API too): operators don't get the button. */}
                        {user.role !== 'operator' && <Button size="md" kind="tertiary" onClick={() => setEditing(true)}>Edit product</Button>}
                        <Button size="md" renderIcon={ArrowRight} onClick={() => onRecord(product)}>Record movement</Button>
                    </div>
                </div>
                <StockState state={state} />
                <div>
                    <StockBar state={state} />
                    <p className="muted">
                        {product.minimum === null ? 'No minimum' : 'Minimum: ' + formatQuantity(product.minimum)}
                    </p>
                </div>
            </section>

            <dl className="detail-meta">{data.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>

            {seesCosts && <section className="detail-section" aria-labelledby="detail-price">
                <h3 id="detail-price">Price</h3>
                <dl className="detail-meta">
                    <div><dt>Catalog price</dt><dd>{product.price === null || product.price === undefined ? 'Not recorded' : money(product.price.toFixed(2))}</dd></div>
                    <div><dt>Last purchase</dt><dd>
                        {lp
                            ? <><span className="mono">{unitPriceText(lp.price)}</span>{' · '}
                                {lp.date ? shortDate(lp.date) : `${shortMonth(lp.period)} book`}
                                {lp.supplier ? ` · ${lp.supplier}` : ''}</>
                            : 'None'}
                    </dd></div>
                </dl>
            </section>}

            {seesCosts && <section className="detail-section" aria-labelledby="detail-purchases">
                <h3 id="detail-purchases">Purchases</h3>
                {purchases.isPending && <InlineLoading description="Loading…" />}
                {purchases.error && <InlineNotification kind="error" lowContrast hideCloseButton
                    title="Could not load the purchases" subtitle={errorMessage(purchases.error)} />}
                {purchases.data && (purchases.data.summary.purchases === 0
                    ? <p className="muted">None linked.</p>
                    : <>
                        <p>
                            {purchases.data.summary.purchases} {purchases.data.summary.purchases === 1 ? 'purchase' : 'purchases'}
                            {' · '}{money(purchases.data.summary.amount)}
                            {purchases.data.summary.first_date && purchases.data.summary.last_date
                                && <> · from {shortDate(purchases.data.summary.first_date)} to {shortDate(purchases.data.summary.last_date)}</>}
                        </p>
                        <div className="table-scroll">
                            <table className="detail-table">
                                {/* "Quantity in the book" is in the unit it was bought in (rolls, kilos, boxes),
                                    which the book doesn't record and may differ from the catalog's. */}
                                <thead><tr><th>Date</th><th>Supplier</th><th>Quantity in the book</th><th>Price</th><th>Amount</th></tr></thead>
                                <tbody>{purchases.data.purchases.map(c => <tr key={c.id}>
                                    <td>{c.date ? shortDate(c.date) : shortMonth(c.period)}</td>
                                    <td>{c.supplier ?? '—'}</td>
                                    <td className="mono">{quantityText(c.quantity)}</td>
                                    <td className="mono">{unitPriceText(c.price)}</td>
                                    <td className="mono">{money(c.amount)}</td>
                                </tr>)}</tbody>
                            </table>
                        </div>
                        {purchases.data.summary.purchases > purchases.data.purchases.length && <p className="muted">
                            Showing the {purchases.data.purchases.length} most recent. The rest are in Purchases.
                        </p>}
                    </>)}
            </section>}

            <section className="detail-section" aria-labelledby="detail-codes">
                <h3 id="detail-codes">Codes</h3>
                {codes.isPending && <InlineLoading description="Loading…" />}
                {codes.error && <InlineNotification kind="error" lowContrast hideCloseButton
                    title="Could not load the codes" subtitle={errorMessage(codes.error)} />}
                {codes.data && (codes.data.length === 0
                    ? <p className="muted">None linked.</p>
                    : <ul className="detail-codes">{codes.data.map(c => <li key={c.id}>
                        <Tag size="sm" type={c.type === 'supplier' ? 'purple' : 'gray'}>{c.type === 'supplier' ? 'Supplier' : 'Barcode'}</Tag>{' '}
                        <span className="mono">{c.code}</span>
                        {c.description && <span> · {c.description}</span>}
                        {c.created_by && <span className="muted"> · linked by {c.created_by}</span>}
                    </li>)}</ul>)}
                {user.role !== 'operator' && <AddCode productId={product.id} />}
            </section>

            <section className="detail-section" aria-labelledby="detail-movements">
                <h3 id="detail-movements">Latest movements</h3>
                {movements.isPending && <InlineLoading description="Loading…" />}
                {movements.error && <InlineNotification kind="error" lowContrast hideCloseButton
                    title="Could not load the movements" subtitle={errorMessage(movements.error)} />}
                {movements.data && (movements.data.total === 0
                    ? <p className="muted">No movements recorded.</p>
                    : <>
                        <div className="table-scroll">
                            <table className="detail-table">
                                <thead><tr><th>Date</th><th>Movement</th><th>Quantity</th><th>Who</th></tr></thead>
                                <tbody>{movements.data.movements.slice(0, VISIBLE_MOVEMENTS).map(m => <tr key={m.id}>
                                    <td>{dateOf(m)}</td>
                                    <td>{DIRECTION[m.type].label}{m.over_negative && <span className="muted"> · negative balance</span>}</td>
                                    <td className="mono">{quantityOf(m)}</td>
                                    <td>{whoOf(m)}</td>
                                </tr>)}</tbody>
                            </table>
                        </div>
                        {movements.data.total > VISIBLE_MOVEMENTS && <p className="muted">
                            {movements.data.total} in total; the rest are in the movement log.
                        </p>}
                    </>)}
            </section>
        </div>
    </Modal>;
}

// Link a code by hand: a box's barcode, or the number on the supplier's label (Z-20120).
// Supplier numbers are stored uppercase; a code that belongs to another product is rejected, saying which.
function AddCode({ productId }: { productId: number }) {
    const qc = useQueryClient();
    const [type, setType] = useState<'barcode' | 'supplier'>('supplier');
    const [code, setCode] = useState('');
    const [description, setDescription] = useState('');
    const [error, setError] = useState<string | null>(null);
    const link = useMutation({
        mutationFn: () => requestJson(`/api/products/${productId}/codes`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, code: code.trim(), ...(description.trim() ? { description: description.trim() } : {}) }),
        }),
        onSuccess: () => {
            setCode(''); setDescription(''); setError(null);
            // New codes enter search and the list, so refresh everything product-related.
            void qc.invalidateQueries({ queryKey: ['products'] });
        },
        onError: e => setError(errorMessage(e)),
    });
    return <div className="stack">
        <div className="form-grid">
            <Select id="code-type" labelText="Type" value={type} onChange={e => setType(e.target.value as 'barcode' | 'supplier')} disabled={link.isPending}>
                <SelectItem value="supplier" text="Supplier number" />
                <SelectItem value="barcode" text="Barcode" />
            </Select>
            <TextInput id="code-new" labelText="Code" value={code} maxLength={200} autoComplete="off" className="mono"
                onChange={e => setCode(e.target.value)} disabled={link.isPending} />
        </div>
        <TextInput id="code-description" labelText="Description (optional)" value={description} maxLength={300} autoComplete="off"
            onChange={e => setDescription(e.target.value)} disabled={link.isPending} />
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not link" subtitle={error} />}
        <div><Button size="sm" kind="tertiary" disabled={code.trim() === '' || link.isPending} onClick={() => link.mutate()}>{link.isPending ? 'Linking…' : 'Add code'}</Button></div>
    </div>;
}
