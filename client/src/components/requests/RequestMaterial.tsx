import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, ComboBox, InlineLoading, InlineNotification, Tag, TextInput } from '@carbon/react';
import { Close, SendAlt } from '@carbon/icons-react';
import type { Product, ProductsResponse, User } from '../../types';
import { toProduct } from '../../api';
import { fetchJson, errorMessage } from '../../queries';
import { quantityProblem } from '../../newProduct';
import { formatQuantity } from '../../level';
import { isOpen, statusLabel, timeAgo, useChangeRequest, useSendRequest, useRequests, type RequestStatus, type MaterialRequest } from '../../requests';
import { Clock } from '../Clock';

const CARD = 'rounded-2xl bg-layer p-4 md:p-5 min-w-0';
const TONE: Record<RequestStatus, 'gray' | 'blue' | 'green' | 'red'> = { pending: 'blue', ready: 'green', delivered: 'gray', cancelled: 'red' };

type Item = { product: Product; quantity: string };

/**
 * Home for people who work the floor: instead of the dashboard, ask the storeroom for material.
 * The request reaches the storekeeper in seconds and they gather it while the person walks over.
 * A request subtracts nothing: the stock-out is recorded at the counter, with who takes it.
 */
export function RequestMaterial({ user }: { user: User }) {
    const [search, setSearch] = useState('');
    const [searched, setSearched] = useState('');
    const [items, setItems] = useState<Item[]>([]);
    const [note, setNote] = useState('');
    const [sent, setSent] = useState(false);
    // The ComboBox can't be emptied from outside: after adding a product another one is mounted, ready for the next.
    const [reset, setReset] = useState(0);
    const searchBox = useRef<HTMLInputElement>(null);
    const send = useSendRequest();

    // Debounced search, like in the movement screen: one request per pause, not per key.
    useEffect(() => {
        const id = setTimeout(() => setSearched(search.trim()), 250);
        return () => clearTimeout(id);
    }, [search]);
    const query = useQuery({
        queryKey: ['products', { q: searched }],
        queryFn: fetchJson<ProductsResponse>(`/api/products?q=${encodeURIComponent(searched)}`),
        enabled: searched.length >= 2,
    });
    const options = query.data?.products.map(toProduct) ?? [];

    function add(p: Product | null) {
        if (!p) return;
        setSent(false);
        setItems(rs => rs.some(r => r.product.id === p.id) ? rs : [...rs, { product: p, quantity: '1' }]);
        setSearch('');
        setSearched('');
        setReset(v => v + 1);
    }
    const change = (id: number, quantity: string) => setItems(rs => rs.map(r => r.product.id === id ? { ...r, quantity } : r));
    const remove = (id: number) => setItems(rs => rs.filter(r => r.product.id !== id));

    const problems = items.map(r => r.quantity.trim() === '' ? 'Enter the quantity' : quantityProblem(r.quantity, r.product.unit, false));
    const ready = items.length > 0 && problems.every(p => p === null);

    function submit() {
        if (!ready || send.isPending) return;
        send.mutate(
            { items: items.map(r => ({ product_id: r.product.id, quantity: Number(r.quantity) })), ...(note.trim() ? { note: note.trim() } : {}) },
            { onSuccess: () => { setItems([]); setNote(''); setSent(true); searchBox.current?.focus(); } });
    }

    return <section className="page flex flex-col gap-4">
        <div>
            <h1 className="text-[1.75rem] font-light">Hi, {user.name}</h1>
            <Clock />
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <article className={CARD + ' flex flex-col gap-4'}>
                <h2 className="text-base">Request material from the storeroom</h2>

                <ComboBox<Product> id="request-product" titleText="Product" placeholder="Code or name" items={options} ref={searchBox}
                    key={reset} selectedItem={null} onInputChange={setSearch}
                    itemToString={p => p ? `${p.code} — ${p.name}` : ''} onChange={({ selectedItem }) => add(selectedItem ?? null)}
                    shouldFilterItem={() => true} />

                {items.length > 0 && <ul className="flex flex-col gap-3" aria-label="What you're requesting">
                    {items.map((r, i) => <li key={r.product.id} className="flex items-start gap-2 rounded-xl border border-border p-3">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold">{r.product.name}</p>
                            <p className="muted">{r.product.code}{r.product.location ? ` · ${r.product.location}` : ''}</p>
                        </div>
                        <TextInput id={`quantity-${r.product.id}`} labelText={`Quantity (${r.product.unit})`} size="md" className="w-28 flex-none"
                            inputMode="decimal" value={r.quantity} onChange={e => change(r.product.id, e.target.value)}
                            invalid={problems[i] !== null} invalidText={problems[i] ?? ''} />
                        <Button kind="ghost" size="md" hasIconOnly renderIcon={Close} iconDescription={`Remove ${r.product.name}`}
                            tooltipPosition="left" onClick={() => remove(r.product.id)} className="mt-6 flex-none" />
                    </li>)}
                </ul>}

                {items.length > 0 && <TextInput id="request-note" labelText="Note (optional)" placeholder="What it's for, or where you need it"
                    maxLength={300} value={note} onChange={e => setNote(e.target.value)} />}

                {send.error && <InlineNotification kind="error" title="Not sent" subtitle={errorMessage(send.error)} hideCloseButton />}
                {sent && <InlineNotification kind="success" title="Request sent" hideCloseButton />}

                <div className="flex flex-wrap items-center gap-3">
                    <Button kind="primary" renderIcon={send.isPending ? undefined : SendAlt} disabled={!ready || send.isPending} onClick={submit}>
                        {send.isPending ? 'Sending…' : 'Send request'}
                    </Button>
                </div>
            </article>

            <MyRequests />
        </div>
    </section>;
}

function MyRequests() {
    const query = useRequests();
    const change = useChangeRequest();
    const requests = query.data?.requests ?? [];
    return <article className={CARD + ' flex flex-col gap-3'}>
        <h2 className="text-base">My requests</h2>
        {query.isPending && <InlineLoading description="Loading…" />}
        {query.error && <InlineNotification kind="error" title="Could not load your requests" subtitle={errorMessage(query.error)} hideCloseButton />}
        {query.data && requests.length === 0 && <p className="muted">You haven't requested anything today.</p>}
        {change.error && <InlineNotification kind="error" title="Could not cancel" subtitle={errorMessage(change.error)} hideCloseButton />}
        <ul className="flex flex-col gap-3">
            {requests.map(p => <RequestCard key={p.id} request={p}
                action={isOpen(p) ? <Button kind="ghost" size="sm" disabled={change.isPending} onClick={() => change.mutate({ id: p.id, status: 'cancelled' })}>Cancel</Button> : null} />)}
        </ul>
    </article>;
}

export function RequestCard({ request, action, showRequester = false }: { request: MaterialRequest; action?: React.ReactNode; showRequester?: boolean }) {
    return <li className="flex flex-col gap-2 rounded-xl border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
                <Tag type={TONE[request.status]} size="md">{statusLabel(request)}</Tag>
                {showRequester && <strong className="text-sm">{request.requester.name}</strong>}
            </span>
            <span className="muted">{timeAgo(request.created_at)}</span>
        </div>
        <ul className="flex flex-col gap-1 text-sm">
            {request.items.map(r => <li key={r.product_id}>
                <strong>{formatQuantity(Number(r.quantity))} {r.unit}</strong> {r.name}
                {r.location && <span className="muted"> · {r.location}</span>}
            </li>)}
        </ul>
        {request.note && <p className="muted">“{request.note}”</p>}
        {request.status === 'ready' && !showRequester && <p className="text-sm">It's gathered: pick it up at the counter.</p>}
        {action && <div className="flex flex-wrap gap-2">{action}</div>}
    </li>;
}
