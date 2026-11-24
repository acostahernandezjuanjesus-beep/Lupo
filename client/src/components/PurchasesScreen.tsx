import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
    Button, InlineLoading, InlineNotification, Select, SelectItem, Tab, TabList, TabPanel,
    TabPanels, Tabs, Tile,
} from '@carbon/react';
import { fetchJson, errorMessage } from '../queries';
import { shortMonth, longMonth } from '../money';
import type { LineStatus, SupplierFilter, PurchaseBook, Month } from '../purchases/types';
import { PurchasesDashboard } from './purchases/PurchasesDashboard';
import { BookReader } from './purchases/BookReader';
import { BringToCatalog } from './purchases/BringToCatalog';
import { ImportBook } from './purchases/ImportBook';

// The period is a range of books, not of dates: books are filed by month, and a week crossing
// a month boundary must not split one book in two.

type Period = { from: Month | null; to: Month | null };
/** null = no limit on that end: all books. */
const ALL: Period = { from: null, to: null };

const TABS = ['Dashboard', 'Read the books', 'Bring to catalog', 'Import book'];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function PurchasesScreen({ isAdmin = false }: { isAdmin?: boolean }) {
    const booksQuery = useQuery({
        queryKey: ['purchases', 'books'],
        queryFn: fetchJson<PurchaseBook[]>('/api/purchases/books'),
    });
    const [period, setPeriod] = useState<Period>(ALL);
    // Suppliers links here with `?supplier=...`: the reader opens already limited to that supplier.
    const [params, setParams] = useSearchParams();
    const supplierName = params.get('supplier');
    const supplierId = Number(params.get('supplier_id'));
    const supplier: SupplierFilter | null = supplierName
        ? { name: supplierName, id: Number.isInteger(supplierId) && supplierId > 0 ? supplierId : null }
        : null;
    const [tab, setTab] = useState(supplier ? 1 : 0);
    // A tab mounts the first time it's opened and stays mounted: no three queries on entry, and
    // whoever was on page 12 of a book finds it there coming back from the dashboard. Linking in
    // "Bring to catalog" invalidates ['purchases'], so the other tabs refetch by themselves.
    const [opened, setOpened] = useState<ReadonlySet<number>>(() => new Set([supplier ? 1 : 0]));
    const [readerStatus, setReaderStatus] = useState<LineStatus>('all');

    /** From a dashboard notice: the reader, already filtered to what needs review. */
    function goToReader(status: LineStatus) {
        setReaderStatus(status);
        setTab(1);
        setOpened(o => new Set(o).add(1));
    }

    const heading = <div className="page-heading">
        <div><h1>Purchases</h1></div>
    </div>;

    // Books already loaded stay even if a later refetch fails: swapping the tabs for an error
    // would lose the page someone was reading.
    const books = booksQuery.data;

    if (books === undefined && booksQuery.error && !booksQuery.isFetching) return <section className="page stack purchases-page">
        {heading}
        <InlineNotification kind="error" title="Could not load the purchase books" subtitle={errorMessage(booksQuery.error)} hideCloseButton />
        <div><Button kind="tertiary" onClick={() => { void booksQuery.refetch(); }}>Retry</Button></div>
    </section>;

    if (books === undefined) return <section className="page stack purchases-page">
        {heading}
        <InlineLoading description="Loading the purchase books…" />
    </section>;

    if (books.length === 0) return <section className="page stack purchases-page">
        {heading}
        <Tile className="panel stack">
            <h2>No purchase books yet</h2>
            <ImportBook isAdmin={isAdmin} />
        </Tile>
    </section>;

    // The server sends them ordered by period.
    const months = [...new Set(books.map(b => b.period))];
    const first = months[0];
    const last = months[months.length - 1];
    const from = period.from ?? first;
    const to = period.to ?? last;
    const booksInPeriod = books.filter(b => b.period >= from && b.period <= to);
    // The text comes from the books, not the code: when next month's book arrives the button says so.
    const allLabel = books.length === 1
        ? `The only book (${shortMonth(first)})`
        : `All ${books.length} books (${first === last ? shortMonth(first) : `${shortMonth(first)} – ${shortMonth(last)}`})`;

    function choose(newFrom: Month, newTo: Month) {
        // Range ends are stored as "no limit": asking from the first book is the same as no limit,
        // and picking them by hand doesn't fire an identical query.
        setPeriod({
            from: newFrom === first ? null : newFrom,
            to: newTo === last ? null : newTo,
        });
    }

    return <section className="page stack purchases-page">
        {heading}

        <Tile className="panel stack">
            <div className="purchases-period">
                {/* If one end crosses the other, the other follows: a backwards range makes no sense and the server rejects it. */}
                <Select id="purchases-from" labelText="From" value={from}
                    onChange={e => choose(e.target.value, e.target.value > to ? e.target.value : to)}>
                    {months.map(m => <SelectItem key={m} value={m} text={capitalize(longMonth(m))} />)}
                </Select>
                <Select id="purchases-to" labelText="To" value={to}
                    onChange={e => choose(e.target.value < from ? e.target.value : from, e.target.value)}>
                    {months.map(m => <SelectItem key={m} value={m} text={capitalize(longMonth(m))} />)}
                </Select>
                <Button kind="tertiary" onClick={() => setPeriod(ALL)}>{allLabel}</Button>
            </div>
        </Tile>

        <Tabs selectedIndex={tab} onChange={({ selectedIndex }) => {
            setTab(selectedIndex);
            setOpened(o => o.has(selectedIndex) ? o : new Set(o).add(selectedIndex));
        }}>
            <TabList aria-label="Purchases sections">
                {TABS.map(t => <Tab key={t}>{t}</Tab>)}
            </TabList>
            <TabPanels>
                <TabPanel>
                    {opened.has(0) && <PurchasesDashboard from={period.from} to={period.to} books={books} onReview={goToReader} />}
                </TabPanel>
                <TabPanel>
                    {opened.has(1) && <BookReader from={period.from} to={period.to} books={booksInPeriod} supplier={supplier}
                        status={readerStatus} onStatus={setReaderStatus}
                        onClearSupplier={() => setParams({}, { replace: true })} />}
                </TabPanel>
                <TabPanel>
                    {opened.has(2) && <BringToCatalog from={period.from} to={period.to}
                        monthsWithBook={new Set(booksInPeriod.map(b => b.period)).size} />}
                </TabPanel>
                <TabPanel>
                    {/* Doesn't depend on the period above: imports whichever book is picked, from any month. */}
                    {opened.has(3) && <ImportBook isAdmin={isAdmin} />}
                </TabPanel>
            </TabPanels>
        </Tabs>
    </section>;
}
