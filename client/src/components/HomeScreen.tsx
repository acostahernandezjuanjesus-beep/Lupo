import { useId, useState, type ReactNode } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Button, InlineNotification, InlineLoading } from '@carbon/react';
import { AddAlt, ArrowUpRight, Barcode } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router';
import type { User } from '../types';
import type { RecentPurchases, PurchasesSummary } from '../purchases/types';
import { fetchJson, errorMessage } from '../queries';
import { systemProblems, type Diagnostics } from '../system';
import { LEVEL_BACKGROUND, formatQuantity, type Level } from '../level';
import { money, shortDate, longMonth, unitPriceText } from '../money';
import { HIGH_MARGIN, bookIncomplete, highThreshold } from '../purchases/spikes';
import { DismissibleNotice } from './DismissibleNotice';
import { Clock } from './Clock';
import { RequestMaterial } from './requests/RequestMaterial';
import { RequestQueue } from './requests/RequestQueue';

// Home. Storekeeper/admin get the dashboard; operators get the material request screen.
//
// Cards are Tailwind divs, not Carbon `Tile`: Carbon is square-cornered and its components can't be adjusted
// with utilities. Buttons, notices and menus are still Carbon. Every color is a var(--…), so it works in light and dark.
//
// Not shown on purpose: a "this month" spend card (only the books already loaded exist, so the last one under
// "this month" would claim a month that isn't its own) and any zero or sample data. A made-up zero reads as a fact.

type Summary = {
    products: number;
    uncounted: number;
    with_minimum: number;
    /** With a minimum AND counted: the only ones that can be compared against it. */
    with_minimum_counted: number;
    below_min: number;
    restock: number;
    negative_balance: number;
    movements: number;
    movements_today: number;
    outs_today: number;
    over_negative: number;
    active_users: number;
    /** The ones that track stock (not 'no_balance'): the base of the scale. */
    with_stock: number;
    levels: Record<Level, number>;
};

type MovementItem = {
    id: number;
    type: 'in' | 'out' | 'adjustment' | 'return' | 'loan';
    quantity: string;
    date: string;
    /** 'historical' = initial load from the books: no author and no time of day. */
    origin: string;
    note: string | null;
    product_id: number;
    code: string;
    product: string;
    user_id: number | null;
    user: string | null;
    responsible_id: number | null;
    responsible: string | null;
};

type MovementsResponse = {
    movements: MovementItem[];
    total: number;
    page: number;
    pages: number;
};

// The sign comes from the type, not the quantity: the API always sends it positive.
const SUBTRACTS = new Set(['out', 'loan']);

const INTEGERS = new Intl.NumberFormat('en-US');
const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });
const MONTH_ONLY = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
/** A big amount on a card: "$1.52M". The exact one goes below. */
const COMPACT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'MXN', currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 2 });

/** The scale in reading order: from fine to needs attention, then what can't be measured. Labels match `levelStateOf()`. */
const SCALE: { level: Level; label: string }[] = [
    { level: 'ample', label: 'Sufficient' },
    { level: 'restock', label: 'Restock needed' },
    { level: 'below_min', label: 'Below minimum' },
    { level: 'no_minimum', label: 'No minimum set' },
    { level: 'uncounted', label: 'Uncounted' },
];

/** The base dashboard card. Compact on purpose; not done with zoom, which would shrink small text and touch targets too. */
const CARD = 'rounded-2xl bg-layer p-4 md:p-5 min-w-0';

/** An id for url(#…) in SVG. React's own contains characters that break the reference inside url(). */
function useSvgId() {
    return 'svg' + useId().replace(/[^a-zA-Z0-9]/g, '');
}

export function HomeScreen({ user }: { user: User }) {
    return user.role === 'operator' ? <RequestMaterial user={user} /> : <Dashboard user={user} />;
}

function Dashboard({ user }: { user: User }) {
    const navigate = useNavigate();

    // Independent queries: each has its own state, so if purchases fails the rest of the dashboard still shows.
    const summaryQuery = useQuery({ queryKey: ['summary'], queryFn: fetchJson<Summary>('/api/summary') });
    const movementsQuery = useQuery({
        queryKey: ['movements', { page: 1 }],
        queryFn: fetchJson<MovementsResponse>('/api/movements?page=1'),
    });
    const purchasesQuery = useQuery({
        queryKey: ['purchases', 'summary', 'home'],
        queryFn: fetchJson<PurchasesSummary>('/api/purchases/summary?group_by=category'),
    });

    const recentQuery = useQuery({
        queryKey: ['purchases', 'recent'],
        queryFn: fetchJson<RecentPurchases>('/api/purchases/recent'),
    });

    // Admin only, and it only speaks when something is wrong (a late backup, a pending update).
    const systemQuery = useQuery({
        queryKey: ['admin', 'diagnostics'],
        queryFn: fetchJson<Diagnostics>('/api/admin/diagnostics'),
        enabled: user.role === 'admin',
        staleTime: 5 * 60_000,
    });
    const systemIssues = systemQuery.data ? systemProblems(systemQuery.data) : [];

    const summary = summaryQuery.data ?? null;
    const movements = movementsQuery.data?.movements.slice(0, 8) ?? [];
    const purchases = purchasesQuery.data ?? null;
    // With no book loaded the spend cards are OMITTED instead of drawn at "$0": a zero on a dashboard reads as a fact,
    // and here it only means there are no books (a fresh install).
    const hasBooks = (purchases?.period.books ?? 0) > 0;
    const loading = summaryQuery.isPending || movementsQuery.isPending;
    const error = summaryQuery.error
        ? errorMessage(summaryQuery.error)
        : movementsQuery.error ? errorMessage(movementsQuery.error) : null;

    function retry() {
        summaryQuery.refetch();
        movementsQuery.refetch();
        purchasesQuery.refetch();
    }

    const toInventory = (level?: Level) => level ? `/inventory?status=${level}&control=stock` : '/inventory';

    return <section className="page flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
                <h1 className="text-[1.75rem] font-light">Hello, {user.name}</h1>
                <Clock />
            </div>
            <div className="flex flex-wrap gap-2">
                <Button kind="primary" renderIcon={AddAlt} onClick={() => navigate('/movement')}>Record movement</Button>
                <Button kind="tertiary" renderIcon={Barcode} onClick={() => navigate('/scan')}>Scan</Button>
            </div>
        </div>

        <RequestQueue />

        {systemIssues.length > 0 && <DismissibleNotice title="System" text={systemIssues.join(' ')}>
            <Button kind="tertiary" size="sm" onClick={() => navigate('/system')}>See the status</Button>
        </DismissibleNotice>}

        {error && <div className="flex flex-col items-start gap-2">
            <InlineNotification kind="error" title="Could not load the summary" subtitle={error} hideCloseButton />
            <Button kind="tertiary" onClick={retry}>Retry</Button>
        </div>}
        {loading && <InlineLoading description="Loading summary…" />}

        {summary && <>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
                <RegisteredStock summary={summary} to={toInventory} />
                <Figure title="Today's movements" to="/movements" value={INTEGERS.format(summary.movements_today)} />
                {purchases && hasBooks
                    ? <CurrentMonth data={purchases} />
                    : <Figure title="Purchases" to="/purchases" value="—" />}
            </div>

            {purchasesQuery.error && <InlineNotification kind="error" hideCloseButton
                title="Could not load the purchases" subtitle={errorMessage(purchasesQuery.error)} />}

            {recentQuery.data && hasBooks && <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <LatestPurchases purchases={recentQuery.data.latest} />
                <PriceChanges changes={recentQuery.data.prices} />
            </div>}

            {/* Three columns on desktop: the curve (two) and the catalog ring on top; below, the stock status runs down
                two rows with movements and spend beside it. One column on the phone. */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {purchases && hasBooks && <>
                    <PurchasesByMonth data={purchases} className="lg:col-span-2" />
                    <CatalogCoverage data={purchases} />
                </>}
                <StockStatus summary={summary} to={toInventory} className="lg:row-span-2" />
                {/* Movements before spend: it's what the warehouse checks daily. */}
                <RecentMovements movements={movements} className="lg:col-span-2" />
                {purchases && hasBooks && <SpendByCategory data={purchases} className="lg:col-span-2" />}
            </div>
        </>}
    </section>;
}

// Shared pieces

/** The round arrow button. Filled with the theme's inverted colors; outlined it got lost. */
function ArrowLink({ to, label, onStrong = false }: { to: string; label: string; onStrong?: boolean }) {
    return <Link to={to} aria-label={label}
        className={'grid size-9 flex-none place-items-center rounded-full outline-offset-2 transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-focus '
            + (onStrong ? 'bg-white text-black' : 'bg-inverse text-text-inverse')}>
        <ArrowUpRight size={20} />
    </Link>;
}

function CardHeading({ title, to, label }: { title: string; to?: string; label?: string }) {
    return <div className="flex items-start justify-between gap-2">
        <h2 className="text-base">{title}</h2>
        {to && <ArrowLink to={to} label={label ?? `Go to ${title.toLowerCase()}`} />}
    </div>;
}

/** A data box with a color bar on the left. The bar is the legend swatch: the value is written, color is never the only cue. */
function StatBox({ swatch, title, value, detail, to, strong = false }: {
    swatch: string; title: string; value: string; detail?: string; to?: string; strong?: boolean;
}) {
    const body = <>
        <span className="w-1 flex-none self-stretch rounded-full" style={{ background: swatch }} aria-hidden="true" />
        <span className="min-w-0">
            <span className="block text-xs text-text-2">{title}</span>
            <span className={'block text-lg ' + (strong ? 'font-semibold' : '')}>{value}</span>
            {detail && <span className="block text-xs text-text-2">{detail}</span>}
        </span>
    </>;
    const classes = 'flex gap-3 rounded-xl border border-border px-3 py-2 text-text no-underline';
    return to
        ? <Link to={to} className={classes + ' hover:bg-background focus-visible:outline-2 focus-visible:outline-focus'}>{body}</Link>
        : <div className={classes}>{body}</div>;
}

/** Hatched SVG fill, for "not known". The tones come from the theme. */
function Hatch({ id, line, background }: { id: string; line: string; background: string }) {
    return <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" style={{ fill: background }} /><rect width="2" height="6" style={{ fill: line }} />
    </pattern>;
}

/** Donut: each part is a stroke on the same circle with a 1.5-unit gap in the card color. Starts at the top, clockwise. */
function Ring({ parts, label, children }: {
    parts: { key: string; v: number; background: string }[]; label: string; children: ReactNode;
}) {
    const R = 70, LENGTH = 2 * Math.PI * R, GAP = 1.5;
    const total = parts.reduce((s, p) => s + p.v, 0);
    const visible = parts.filter(p => p.v > 0);
    let traveled = 0;
    return <div className="relative mx-auto aspect-square w-full max-w-44">
        <svg viewBox="0 0 180 180" className="size-full -rotate-90" role="img" aria-label={label}>
            {total > 0 && visible.map(p => {
                const length = (p.v / total) * LENGTH;
                const gap = visible.length > 1 ? GAP : 0;
                const stroke = <circle key={p.key} cx="90" cy="90" r={R} fill="none" strokeWidth="26"
                    style={{ stroke: p.background }}
                    strokeDasharray={`${Math.max(length - gap, 0.5)} ${LENGTH}`} strokeDashoffset={-traveled} />;
                traveled += length;
                return stroke;
            })}
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>;
}

/** A mark's tooltip: shows on hover or focus. */
function Bubble({ children, visible }: { children: ReactNode; visible?: boolean }) {
    return <span role="tooltip"
        className={'pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-inverse px-2 py-1 text-xs text-text-inverse '
            + (visible === undefined ? 'hidden group-hover:block group-focus-visible:block' : visible ? 'block' : 'hidden')}>
        {children}
    </span>;
}

// Top figures

function Figure({ title, value, to }: { title: string; value: string; to: string }) {
    return <article className={CARD + ' flex flex-col gap-4'}>
        <CardHeading title={title} to={to} />
        <p className="text-4xl font-light">{value}</p>
    </article>;
}

/** The lead card, in the theme's strong tone (--dashboard-strong): how much of the inventory has a quantity that means something. */
function RegisteredStock({ summary, to }: { summary: Summary; to: (n?: Level) => string }) {
    const counted = summary.with_stock - summary.levels.uncounted;
    // With no stock-tracked products there's no proportion: a dash, not 0%.
    const coverage = summary.with_stock > 0 ? counted / summary.with_stock : null;
    const boxes = [
        { value: counted, text: 'with quantity', to: to() },
        { value: summary.uncounted, text: 'uncounted', to: to('uncounted') },
        { value: summary.negative_balance, text: 'negative balance', to: to() },
    ];
    return <article className="flex flex-col gap-4 rounded-2xl p-4 text-white md:col-span-2 md:p-5" style={{ background: 'var(--dashboard-strong)' }}>
        <div className="flex items-start justify-between gap-2">
            <h2 className="text-base text-white">Registered stock</h2>
            <ArrowLink to={to()} label="Go to inventory" onStrong />
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
            <p className="text-5xl font-light leading-none">{coverage === null ? '—' : PERCENT.format(coverage)}</p>
        </div>
        {coverage !== null && <div className="h-2 w-full overflow-hidden rounded-full bg-white/20" aria-hidden="true">
            <div className="h-full rounded-full bg-white" style={{ width: `${coverage * 100}%` }} />
        </div>}
        <div className="grid grid-cols-3 gap-2">
            {boxes.map((c, i) => <Link key={c.text} to={c.to}
                className={'rounded-xl px-3 py-2 text-center no-underline outline-offset-2 focus-visible:outline-2 focus-visible:outline-white '
                    + (i === 0 ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/20')}>
                <span className="block text-xl">{INTEGERS.format(c.value)}</span>
                <span className="block text-xs">{c.text}</span>
            </Link>)}
        </div>
    </article>;
}

// Purchases

/** Smooth curve through every point (Catmull-Rom to Bézier). */
function curve(p: [number, number][]): string {
    if (p.length < 2) return '';
    let d = `M ${p[0][0]} ${p[0][1]}`;
    for (let i = 0; i < p.length - 1; i++) {
        const [x0, y0] = p[i - 1] ?? p[i], [x1, y1] = p[i], [x2, y2] = p[i + 1], [x3, y3] = p[i + 2] ?? p[i + 1];
        d += ` C ${x1 + (x2 - x0) / 6} ${y1 + (y2 - y0) / 6}, ${x2 - (x3 - x1) / 6} ${y2 - (y3 - y1) / 6}, ${x2} ${y2}`;
    }
    return d;
}

/**
 * Area curve per book month. A month with no book isn't drawn: it's not zero spend, it's no record (same rule as
 * Purchases). What counts as "high" is in purchases/spikes.ts; peaks are painted yellow.
 */
function PurchasesByMonth({ data, className = '' }: { data: PurchasesSummary; className?: string }) {
    const [active, setActive] = useState<number | null>(null);
    const gradientId = useSvgId();
    const highId = useSvgId();
    const aboveId = useSvgId();
    const series = data.monthly_series;
    const values = series.map(m => Number(m.amount ?? 0));
    const biggest = Math.max(0, ...values);
    const high = highThreshold(series);
    // A "round" ceiling for the guides: the next multiple of 50k.
    const ceiling = biggest > 0 ? Math.ceil(Math.max(biggest, high?.threshold ?? 0) / 50000) * 50000 : 1;
    const W = 600, H = 200;
    // Each month sits at the center of its strip, like its label below; edge to edge the points drifted off their month.
    const points: [number, number][] = values.map((v, i) => [
        ((i + 0.5) / series.length) * W,
        H - (v / ceiling) * H,
    ]);
    const x0 = points[0]?.[0] ?? 0, xN = points[points.length - 1]?.[0] ?? W;
    const line = curve(points);
    const guides = [1, 0.75, 0.5, 0.25, 0];
    const yThreshold = high ? H - (high.threshold / ceiling) * H : null;
    const isHigh = (i: number) => high !== null && values[i] > high.threshold;

    return <article className={CARD + ' flex flex-col gap-4 ' + className}>
        <div className="flex items-start justify-between gap-4">
            <h2 className="text-base">Purchases by month</h2>
            <div className="flex items-start gap-3">
                <p className="text-xl font-light">{COMPACT.format(Number(data.summary.amount ?? 0))}</p>
                <ArrowLink to="/purchases" label="Go to purchases" />
            </div>
        </div>

        {/* Grows to the height the row leaves it (the ring next to it is taller); a fixed height left a gap under the curve. */}
        {series.length > 1 && <div className="grid min-h-48 flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] gap-x-3">
            {/* Guides: recessive, dotted, with their figure on the left. */}
            <div className="relative w-12" aria-hidden="true">
                {guides.map(g => <span key={g} className="absolute right-0 -translate-y-1/2 text-[0.6875rem] text-text-2" style={{ top: `${(1 - g) * 100}%` }}>
                    {COMPACT.format(ceiling * g)}</span>)}
            </div>
            <div className="relative" onMouseLeave={() => setActive(null)}>
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" style={{ stopColor: 'var(--chart-1)', stopOpacity: 0.35 }} />
                            <stop offset="100%" style={{ stopColor: 'var(--chart-1)', stopOpacity: 0 }} />
                        </linearGradient>
                        {/* What goes past the threshold: yellow gradient, clipped at the threshold so only the excess is painted. */}
                        {yThreshold !== null && <>
                            <linearGradient id={highId} x1="0" y1="0" x2="0" y2={yThreshold} gradientUnits="userSpaceOnUse">
                                <stop offset="0%" style={{ stopColor: 'var(--chart-alert)', stopOpacity: 0.75 }} />
                                <stop offset="100%" style={{ stopColor: 'var(--chart-alert)', stopOpacity: 0.2 }} />
                            </linearGradient>
                            <clipPath id={aboveId}><rect x="0" y="0" width={W} height={Math.max(yThreshold, 0)} /></clipPath>
                        </>}
                    </defs>
                    {guides.map(g => <line key={g} x1="0" x2={W} y1={(1 - g) * H} y2={(1 - g) * H}
                        vectorEffect="non-scaling-stroke" strokeDasharray="3 4" strokeWidth="1" style={{ stroke: 'var(--cds-border-subtle-01)' }} />)}
                    <path d={`${line} L ${xN} ${H} L ${x0} ${H} Z`} style={{ fill: `url(#${gradientId})` }} />
                    <path d={line} fill="none" strokeWidth="2.5" vectorEffect="non-scaling-stroke" style={{ stroke: 'var(--chart-1)' }} />
                    {yThreshold !== null && <>
                        <path d={`${line} L ${xN} ${H} L ${x0} ${H} Z`} clipPath={`url(#${aboveId})`} style={{ fill: `url(#${highId})` }} />
                        <path d={line} fill="none" strokeWidth="3" vectorEffect="non-scaling-stroke" clipPath={`url(#${aboveId})`} style={{ stroke: 'var(--chart-alert)' }} />
                        <line x1="0" x2={W} y1={yThreshold} y2={yThreshold} vectorEffect="non-scaling-stroke" strokeWidth="1.5" strokeDasharray="6 4"
                            style={{ stroke: 'var(--chart-alert)' }} />
                    </>}
                    {active !== null && <line x1={points[active][0]} x2={points[active][0]} y1="0" y2={H}
                        vectorEffect="non-scaling-stroke" strokeWidth="1" style={{ stroke: 'var(--cds-text-secondary)' }} />}
                </svg>
                {/* The dot and the tooltip are HTML: with preserveAspectRatio="none" an SVG circle would come out stretched. */}
                {active !== null && <span className="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-layer"
                    style={{ left: `${(points[active][0] / W) * 100}%`, top: `${(points[active][1] / H) * 100}%`, borderColor: 'var(--chart-1)' }} />}
                {/* Each high peak carries its written figure: yellow on white is under 3:1, so color can't go alone. */}
                {series.map((m, i) => isHigh(i) && <span key={m.period} className="pointer-events-none absolute"
                    style={{ left: `${(points[i][0] / W) * 100}%`, top: `${(points[i][1] / H) * 100}%` }} aria-hidden="true">
                    <span className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-layer" style={{ background: 'var(--chart-alert)' }} />
                    <span className={'absolute bottom-2 -translate-x-1/2 whitespace-nowrap rounded-full px-2 text-xs font-semibold text-black ' + (active === i ? 'invisible' : '')}
                        style={{ background: 'var(--chart-alert)' }}>{COMPACT.format(values[i])}</span>
                </span>)}
                {/* Pointer and keyboard zones, one per month. */}
                <div className="absolute inset-0 flex">
                    {series.map((m, i) => <div key={m.period} tabIndex={0} className="relative h-full flex-1 outline-none focus-visible:bg-background/50"
                        onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}>
                        <span className="absolute left-1/2" style={{ top: `${(points[i][1] / H) * 100}%` }}>
                            <Bubble visible={active === i}>{longMonth(m.period)} · {money(m.amount)} · {INTEGERS.format(m.purchases)} lines{isHigh(i) ? ' · high' : ''}{bookIncomplete(m) ? ' · incomplete book' : ''}</Bubble>
                        </span>
                    </div>)}
                </div>
            </div>
            <span />
            <div className="mt-2 flex" aria-hidden="true">
                {/* Month only; the year on the first one and when it changes. Thirteen "Aug 2025" labels don't fit. */}
                {series.map((m, i) => <span key={m.period} className="flex-1 text-center text-[0.6875rem] leading-tight text-text-2">
                    {MONTH_ONLY.format(new Date(`${m.period}-01T12:00:00Z`)).replace('.', '')}{bookIncomplete(m) ? '*' : ''}
                    {(i === 0 || m.period.endsWith('-01')) && <span className="block">{m.period.slice(0, 4)}</span>}
                </span>)}
            </div>
        </div>}

        {/* What the yellow means, written out: the threshold and where it comes from. */}
        {high && <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
                <span className="h-0 w-6 border-t-2 border-dashed" style={{ borderColor: 'var(--chart-alert)' }} aria-hidden="true" />
                High: more than {PERCENT.format(HIGH_MARGIN)} above the median ({COMPACT.format(high.median)}), i.e. over {COMPACT.format(high.threshold)}
            </span>
        </div>}

        {/* What a screen reader gets: the table, not the curve. */}
        <div className="sr-only"><table>
            <caption>Amount per book month</caption>
            <tbody>{series.map(m => <tr key={m.period}><th scope="row">{longMonth(m.period)}</th><td>{money(m.amount)}</td><td>{m.purchases} lines</td><td>{isHigh(series.indexOf(m)) ? 'high' : ''}{bookIncomplete(m) ? ' incomplete book' : ''}</td></tr>)}</tbody>
        </table></div>
    </article>;
}

/**
 * Of the books' amount, how much the catalog recognizes. Blue and orange are the two linked parts (validated as a
 * pair in light and dark); unlinked is hatched, because it's spend the catalog doesn't know what to call yet.
 */
function CatalogCoverage({ data }: { data: PurchasesSummary }) {
    const hatchId = useSvgId();
    const c = data.coverage;
    const total = Number(data.summary.amount ?? 0);
    const pct = (v: string | null) => total > 0 ? PERCENT.format(Number(v ?? 0) / total) : '—';
    const parts = [
        { key: 'with', v: Number(c.with_stock.amount ?? 0), background: 'var(--chart-1)' },
        { key: 'without', v: Number(c.no_stock.amount ?? 0), background: 'var(--chart-2)' },
        { key: 'free', v: Number(c.unlinked.amount ?? 0), background: `url(#${hatchId})` },
    ];
    const linked = total > 0 ? (parts[0].v + parts[1].v) / total : null;

    return <article className={CARD + ' flex flex-col gap-4'}>
        <CardHeading title="Catalog coverage" />
        <svg width="0" height="0" className="absolute" aria-hidden="true">
            <defs><Hatch id={hatchId} line="var(--hatch-line)" background="var(--hatch-bg)" /></defs>
        </svg>
        <Ring parts={parts} label={`With stock ${pct(c.with_stock.amount)}; without stock ${pct(c.no_stock.amount)}; unlinked ${pct(c.unlinked.amount)}`}>
            <div>
                <p className="text-2xl font-light leading-none">{linked === null ? '—' : PERCENT.format(linked)}</p>
                <p className="text-xs text-text-2">linked</p>
            </div>
        </Ring>
        <div className="grid grid-cols-2 gap-2">
            <StatBox swatch="var(--chart-1)" title="With stock" value={pct(c.with_stock.amount)} detail={money(c.with_stock.amount)} />
            <StatBox swatch="var(--chart-2)" title="Without stock" value={pct(c.no_stock.amount)} detail={money(c.no_stock.amount)} />
            <StatBox swatch="var(--chart-hatched)" title="Unlinked" value={pct(c.unlinked.amount)} detail={money(c.unlinked.amount)} />
            <StatBox swatch="var(--chart-hatched)" title="Unlinked descriptions" value={INTEGERS.format(c.unlinked.descriptions)} to="/purchases" />
        </div>
    </article>;
}

/**
 * The categories with the most spend, in thin bars. One series, one color (purple, which goes alone: next to blue
 * in dark mode they can't be told apart). "Not linked to the catalog" is hatched: not a category, just what the catalog doesn't know yet.
 */
function SpendByCategory({ data, className = '' }: { data: PurchasesSummary; className?: string }) {
    const total = Number(data.summary.amount ?? 0);
    const rows = data.breakdown.filter(g => g.amount !== null).slice(0, 8);
    const biggest = Math.max(0, ...rows.map(g => Number(g.amount)));

    return <article className={CARD + ' flex flex-col gap-4 ' + className}>
        <CardHeading title="Spend by category" to="/purchases" label="Go to purchases" />
        <ol className="grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2">
            {rows.map((g, i) => {
                const v = Number(g.amount);
                const hatched = g.key === 'unlinked';
                return <li key={g.key ?? g.name} className="flex flex-col gap-1.5">
                    <span className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate" title={g.name}><span className="mono mr-2 text-text-2">{i + 1}</span>{g.name}</span>
                        <span className="mono flex-none text-sm">{COMPACT.format(v)} <span className="text-text-2">· {total > 0 ? PERCENT.format(v / total) : '—'}</span></span>
                    </span>
                    <span className="h-2 overflow-hidden rounded-full bg-background" aria-hidden="true">
                        <span className="block h-full rounded-full"
                            style={{ width: biggest > 0 ? `${(v / biggest) * 100}%` : 0, background: hatched ? 'var(--chart-hatched)' : 'var(--chart-3)' }} />
                    </span>
                </li>;
            })}
        </ol>
    </article>;
}

// Recent purchases

function CurrentMonth({ data }: { data: PurchasesSummary }) {
    const series = data.monthly_series.filter(m => m.amount !== null);
    const current = series.at(-1);
    if (!current) return null;
    const incomplete = bookIncomplete(current);
    return <Figure title={incomplete ? 'Current month' : 'Last book'} to="/purchases"
        value={COMPACT.format(Number(current.amount))} />;
}

function LatestPurchases({ purchases }: { purchases: RecentPurchases['latest'] }) {
    return <article className={CARD + ' flex flex-col gap-2'}>
        <CardHeading title="Latest purchases" to="/purchases" label="Go to purchases" />
        {!purchases.length && <p className="muted">No dated purchases.</p>}
        <ul>
            {purchases.map((c, i) => <li key={`${i}${c.supplier}${c.folio}${c.date}`} className="flex items-start justify-between gap-4 border-b border-border py-2 text-sm">
                <div className="min-w-0">
                    <p className="truncate" title={c.supplier ?? undefined}>{c.supplier ?? 'No supplier'}</p>
                    <p className="text-xs text-text-2">{shortDate(c.date)}{c.folio ? ` · folio ${c.folio}` : ''} · {c.lines === 1 ? '1 line' : `${c.lines} lines`}</p>
                </div>
                <span className="mono flex-none whitespace-nowrap text-base">{money(c.amount)}</span>
            </li>)}
        </ul>
    </article>;
}

function PriceChanges({ changes }: { changes: RecentPurchases['prices'] }) {
    return <article className={CARD + ' flex flex-col gap-2'}>
        <CardHeading title="Price changes" to="/purchases" label="Go to purchases" />
        {!changes.length && <p className="muted">No recent price changes.</p>}
        <ul>
            {changes.map(c => <li key={`${c.name}${c.latest.date}${c.latest.price}`} className="flex items-start justify-between gap-4 border-b border-border py-2 text-sm">
                <div className="min-w-0">
                    <p className="truncate" title={c.name}>{c.name}</p>
                    <p className="text-xs text-text-2">{shortDate(c.previous.date)} → {shortDate(c.latest.date)}
                        {c.latest.supplier !== c.previous.supplier && c.latest.supplier ? ` · ${c.latest.supplier}` : ''}</p>
                </div>
                <div className="flex-none text-right">
                    <p className="mono whitespace-nowrap">{unitPriceText(c.previous.price)} → {unitPriceText(c.latest.price)}</p>
                    {/* The sign carries the direction: color is never the only cue. */}
                    <p className="mono text-xs text-text-2">{c.change > 0 ? '+' : '−'}{Math.abs(c.change).toLocaleString('en-US')} %</p>
                </div>
            </li>)}
        </ul>
    </article>;
}

// Stock status

function StockStatus({ summary, to, className = '' }: { summary: Summary; to: (n?: Level) => string; className?: string }) {
    const hatchId = useSvgId();
    const total = summary.with_stock;
    const parts = SCALE.map(e => ({ ...e, n: summary.levels[e.level] }));

    return <article className={CARD + ' flex flex-col gap-4 ' + className}>
        <CardHeading title="Stock status" to={to()} label="Go to inventory" />
        <svg width="0" height="0" className="absolute" aria-hidden="true">
            <defs><Hatch id={hatchId} line="var(--level-hatch-line)" background="var(--level-hatch-bg)" /></defs>
        </svg>
        {/* The stock scale with its own colors (LEVEL_BACKGROUND), not the chart ones. Each part has its figure written in the boxes. */}
        <Ring label={parts.map(p => `${p.label}: ${p.n}`).join('; ')}
            parts={parts.map(p => ({ key: p.level, v: p.n, background: p.level === 'no_minimum' ? `url(#${hatchId})` : LEVEL_BACKGROUND[p.level] }))}>
            <div>
                <p className="text-2xl font-light leading-none">{INTEGERS.format(total)}</p>
                <p className="text-xs text-text-2">products</p>
            </div>
        </Ring>
        <div className="grid grid-cols-2 gap-2">
            {parts.map(p => <StatBox key={p.level} swatch={LEVEL_BACKGROUND[p.level]} title={p.label}
                value={INTEGERS.format(p.n)} strong={p.level === 'below_min'}
                detail={total > 0 ? PERCENT.format(p.n / total) : undefined}
                to={p.n > 0 ? to(p.level) : undefined} />)}
        </div>
    </article>;
}

// Recent movements

/** Wide and compact: two columns on desktop instead of one long strip. */
function RecentMovements({ movements, className = '' }: { movements: MovementItem[]; className?: string }) {
    return <article className={CARD + ' flex flex-col gap-2 ' + className}>
        <CardHeading title="Recent movements" to="/movements" label="Go to the movement log" />
        {!movements.length && <p className="muted">No movements recorded yet.</p>}
        <ul className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
            {movements.map(m => <li key={m.id} className="flex items-start justify-between gap-4 border-b border-border py-2 text-sm">
                <div className="min-w-0">
                    <p className="mono truncate">{m.code}</p>
                    <p className="truncate" title={m.product}>{m.product}</p>
                    <p className="text-xs text-text-2">{m.responsible ?? m.user ?? (m.origin === 'historical' ? 'Historical load' : 'Not recorded')} · {m.type}</p>
                </div>
                {/* An adjustment stores the absolute delta, so with no direction in the data it can't be shown as a positive in.
                    The first count stores the difference against a meaningless balance: show what was counted.
                    The quantity stays in one piece: "+7" / "5" split apart reads as two. */}
                <span className="mono flex-none whitespace-nowrap text-base">{m.type === 'adjustment' && m.note?.startsWith('First physical count: ')
                    ? `= ${formatQuantity(parseFloat(m.note.slice('First physical count: '.length)))}`
                    : `${m.type === 'adjustment' ? '' : SUBTRACTS.has(m.type) ? '−' : '+'}${formatQuantity(Number(m.quantity))}`}</span>
            </li>)}
        </ul>
    </article>;
}
