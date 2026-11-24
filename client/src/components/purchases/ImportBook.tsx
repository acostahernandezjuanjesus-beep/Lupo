import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
    Button, Checkbox, ContentSwitcher, InlineLoading, InlineNotification, Select, SelectItem, Switch, Tab,
    TabList, TabPanel, TabPanels, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tabs, Tag,
} from '@carbon/react';
import { ApiError, requestJson } from '../../api';
import { errorMessage } from '../../queries';
import { quantityText, money, shortDate, longMonth, unitPriceText } from '../../money';
import {
    toBase64, type ImportedSheet, type ImportedLine, type ImportResult, type BookPreview,
} from '../../purchases/import';
import { ImportHistory } from './ImportHistory';
import './import.scss';

// Import a purchase book from its Excel: pick the .xlsx, see it sheet by sheet in a grid (each line
// new, existing or with a different description) and only then save what's new.
//
// A similar name is NOT the same product ("ROLLO DE 244 M" vs "305 M"): the server suggests, and
// nothing is pre-checked here. A supplier that doesn't match exactly stays as text until someone
// links it; a purchase with no supplier is valid.

type Filter = 'all' | 'new' | 'existing' | 'unrecognized' | 'warnings';
const FILTERS: { value: Filter; text: string }[] = [
    { value: 'all', text: 'All' },
    { value: 'new', text: 'New' },
    { value: 'existing', text: 'Already there' },
    { value: 'unrecognized', text: 'Unrecognized' },
    { value: 'warnings', text: 'With warning' },
];

const COLUMNS = ['Row', 'Date', 'Folio', 'Material', 'Quantity', 'Price', 'Amount', 'Supplier', 'Requested by', 'Comment', 'Status', 'Catalog'];
const INTEGERS = new Intl.NumberFormat('en-US');
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// date_status texts come from the server, see 00-decisions.
const doubtfulDate = (l: ImportedLine) => l.date_status.startsWith('corrected date') || l.date_status.startsWith('month identified');
const hasWarning = (l: ImportedLine) => l.status === 'description_differs' || doubtfulDate(l) || !l.supplier;

function passesFilter(l: ImportedLine, filter: Filter) {
    switch (filter) {
        case 'new': return l.status === 'new';
        case 'existing': return l.status === 'existing';
        case 'unrecognized': return l.status === 'new' && l.product === null;
        case 'warnings': return hasWarning(l);
        default: return true;
    }
}

export function ImportBook({ isAdmin = false }: { isAdmin?: boolean }) {
    const queryClient = useQueryClient();
    const input = useRef<HTMLInputElement>(null);
    const [reading, setReading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [view, setView] = useState<{ preview: BookPreview; content: string } | null>(null);
    // What the person decided: description -> product, and book supplier -> chosen supplier.
    const [links, setLinks] = useState<ReadonlyMap<string, number>>(new Map());
    const [supplierLinks, setSupplierLinks] = useState<Readonly<Record<string, number>>>({});
    const [filter, setFilter] = useState<Filter>('all');
    const [saving, setSaving] = useState(false);
    const [result, setResult] = useState<ImportResult | null>(null);

    const reset = () => {
        setView(null); setLinks(new Map()); setSupplierLinks({}); setFilter('all'); setError(null); setResult(null);
        if (input.current) input.current.value = '';
    };

    async function picked(file: File | undefined) {
        if (!file) return;
        reset();
        if (!/\.xlsx$/i.test(file.name)) {
            setError('Pick the book as an .xlsx (Excel) file. An .xls or a PDF can\'t be read.');
            return;
        }
        setReading(true);
        try {
            const content = await toBase64(file);
            const preview = await requestJson<BookPreview>('/api/purchases/import/preview', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: file.name, content }),
            });
            setView({ preview, content });
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setReading(false);
        }
    }

    async function save() {
        if (!view) return;
        setSaving(true); setError(null);
        try {
            const r = await requestJson<ImportResult>('/api/purchases/import/confirm', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    file: view.preview.file, content: view.content,
                    links: [...links].map(([description, product_id]) => ({ description, product_id })),
                    suppliers: supplierLinks,
                }),
            });
            setResult(r); setView(null);
            // Changes the dashboard, the reader, "Bring to catalog" and each product's last price.
            void queryClient.invalidateQueries({ queryKey: ['purchases'] });
            void queryClient.invalidateQueries({ queryKey: ['products'] });
        } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Could not connect to the API');
        } finally {
            setSaving(false);
        }
    }

    const toggleLink = (description: string, productId: number, checked: boolean) =>
        setLinks(before => { const n = new Map(before); if (checked) n.set(description, productId); else n.delete(description); return n; });

    // Result
    if (result) {
        const r = result;
        return <div className="stack">
            <InlineNotification kind="success" hideCloseButton title={r.inserted > 0 ? 'Book imported' : 'Nothing new'}
                subtitle={r.inserted > 0
                    ? `Saved ${INTEGERS.format(r.inserted)} new lines (${money(r.amount)}) in ${capitalize(longMonth(r.period))}. ` +
                      `${INTEGERS.format(r.existing_count)} were already there and were not touched.`
                    : `All ${INTEGERS.format(r.existing_count)} lines in this book were already in the system.`} />
            {r.links_created > 0 && <p>Linked {r.links_created} {r.links_created === 1 ? 'name' : 'names'} to the catalog.</p>}
            {r.links_skipped.length > 0 && <InlineNotification kind="info" hideCloseButton title="Links that already existed"
                subtitle={`${r.links_skipped.length} ${r.links_skipped.length === 1 ? 'name was already linked' : 'names were already linked'}.`} />}
            <div><Button kind="tertiary" onClick={reset}>Import another book</Button></div>
            <ImportHistory isAdmin={isAdmin} />
        </div>;
    }

    // Pick the file
    const choose = <div className="import-choose">
        <input ref={input} id="import-file" type="file" accept=".xlsx" tabIndex={-1} aria-hidden="true"
            onChange={e => { void picked(e.target.files?.[0]); }} />
        <Button kind={view ? 'tertiary' : 'primary'} disabled={reading || saving} onClick={() => input.current?.click()}>
            {view ? 'Pick another book' : 'Pick book (.xlsx)'}
        </Button>
        {reading && <InlineLoading description="Reading…" />}
    </div>;

    const failure = error && <InlineNotification kind="error" hideCloseButton title="Could not import" subtitle={error} />;

    if (!view) return <div className="stack">{choose}{failure}<ImportHistory isAdmin={isAdmin} /></div>;

    // Preview
    const { preview } = view;
    const x = preview.summary;
    const checked = links.size;
    const nearCertain = preview.sheets.flatMap(h => h.lines).filter(l => l.status === 'new' && l.suggestion?.level === 'near_certain');
    const nearCertainByDescription = new Map(nearCertain.map(l => [l.description, l.suggestion!.product.id]));
    const checkNearCertain = () => setLinks(before => new Map([...before, ...nearCertainByDescription]));

    return <div className="stack">
        {choose}
        {failure}
        <h2>{capitalize(longMonth(preview.period))} · {preview.file}</h2>

        {preview.other_books_of_month.length > 0 && <InlineNotification kind="warning" hideCloseButton lowContrast
            title="There's already another book for this month" subtitle={`Under another name: ${preview.other_books_of_month.join(', ')}. This one would be saved as a separate book.`} />}
        {preview.book_exists && <p className="muted">{preview.matched_book
            ? <>Recognized as this month's book already in the system ("{preview.matched_book}"; the browser renamed it on download). Only what it's missing would be saved.</>
            : 'This book is already in the system: only what it\'s missing would be saved.'}</p>}

        {preview.notes.length > 0 && <div className="stack">
            <InlineNotification kind="warning" hideCloseButton lowContrast title="How the book was read"
                subtitle="Worth checking before saving: something in its structure isn't as usual." />
            <ul className="import-notices">{preview.notes.map(o => <li key={o}>{o}</li>)}</ul>
        </div>}

        <div className="import-figures" role="group" aria-label="Preview summary">
            <div className="import-figure"><span className="import-figure__value">{INTEGERS.format(x.new_count)}</span>
                <span className="import-figure__text">new lines · {money(x.new_amount)}</span></div>
            <div className="import-figure"><span className="import-figure__value">{INTEGERS.format(x.existing_count)}</span>
                <span className="import-figure__text">already there, not touched</span></div>
            <div className="import-figure"><span className="import-figure__value">{INTEGERS.format(x.new_recognized)}</span>
                <span className="import-figure__text">new ones the catalog already recognizes</span></div>
            <div className="import-figure"><span className="import-figure__value">{INTEGERS.format(x.new_unrecognized)}</span>
                <span className="import-figure__text">new, unrecognized (left unlinked)</span></div>
            {x.description_differs > 0 && <div className="import-figure"><span className="import-figure__value">{INTEGERS.format(x.description_differs)}</span>
                <span className="import-figure__text">with a different description than the database (not rewritten)</span></div>}
        </div>

        {x.new_count === 0 && <InlineNotification kind="info" hideCloseButton lowContrast title="Nothing new"
            subtitle="All the lines in this book are already in the system." />}

        {preview.warnings.length > 0 && <div className="stack">
            <InlineNotification kind="warning" hideCloseButton lowContrast title="Dates worth a look"
                subtitle={preview.warnings.length === 1 ? 'A date in the book was corrected or could not be read.' : `${preview.warnings.length} dates in the book were corrected or could not be read.`} />
            <ul className="import-notices">{preview.warnings.map(a => <li key={a}>{a}</li>)}</ul>
        </div>}

        {preview.unlinked_suppliers.length > 0 && <section className="stack" aria-labelledby="import-supplier-title">
            <h3 id="import-supplier-title">Unlinked suppliers</h3>
            {preview.unlinked_suppliers.map((p, i) => <div className="import-supplier" key={p.name}>
                <div><strong>{p.name}</strong><span className="import-small">{p.lines} {p.lines === 1 ? 'new line' : 'new lines'}</span></div>
                {p.suggested
                    ? <Select id={`import-supplier-${i}`} size="md" labelText="Link to" value={String(supplierLinks[p.name] ?? '')}
                        onChange={e => setSupplierLinks(before => {
                            const n = { ...before };
                            if (e.target.value) n[p.name] = Number(e.target.value); else delete n[p.name];
                            return n;
                        })}>
                        <SelectItem value="" text="Leave unlinked" />
                        <SelectItem value={String(p.suggested.id)} text={p.suggested.name} />
                    </Select>
                    : <span className="muted">Unlinked</span>}
            </div>)}
        </section>}

        <div className="import-bar">
            <ContentSwitcher size="md" selectedIndex={FILTERS.findIndex(f => f.value === filter)} onChange={e => setFilter(FILTERS[e.index ?? 0].value)}>
                {FILTERS.map(f => <Switch key={f.value} name={f.value} text={f.text} />)}
            </ContentSwitcher>
            {nearCertainByDescription.size > 0 && <Button kind="tertiary" size="md" onClick={checkNearCertain}>
                {nearCertainByDescription.size === 1 ? 'Check the near-certain match' : `Check the ${nearCertainByDescription.size} near-certain matches`}
            </Button>}
        </div>

        <Tabs>
            <TabList aria-label="Book sheets (one per week)" contained>
                {preview.sheets.map(h => <Tab key={h.name}>{h.name}</Tab>)}
            </TabList>
            <TabPanels>
                {preview.sheets.map((h, i) => <TabPanel key={h.name}>
                    <Grid sheet={h} index={i} filter={filter} links={links} onLink={toggleLink} />
                </TabPanel>)}
            </TabPanels>
        </Tabs>

        <div className="import-confirm" role="region" aria-label="Confirm the import">
            <p>
                {x.new_count > 0
                    ? <>Will save <strong>{INTEGERS.format(x.new_count)}</strong> {x.new_count === 1 ? 'new line' : 'new lines'} ({money(x.new_amount)})
                        {checked > 0 && <> and <strong>{checked}</strong> {checked === 1 ? 'link' : 'links'} to the catalog</>}. What was already there is not touched.</>
                    : checked > 0 ? <>No new lines; will save <strong>{checked}</strong> links to the catalog.</> : 'Nothing to save.'}
            </p>
            <div className="import-actions">
                {saving && <InlineLoading description="Saving…" />}
                <Button kind="secondary" disabled={saving} onClick={reset}>Cancel</Button>
                <Button kind="primary" disabled={saving || (x.new_count === 0 && checked === 0)} onClick={() => { void save(); }}>
                    {x.new_count > 0 ? `Save ${INTEGERS.format(x.new_count)} ${x.new_count === 1 ? 'line' : 'lines'}` : 'Save the links'}
                </Button>
            </div>
        </div>
    </div>;
}

/** A sheet (one week) as it is in the book. */
function Grid({ sheet, index, filter, links, onLink }: {
    sheet: ImportedSheet; index: number; filter: Filter; links: ReadonlyMap<string, number>;
    onLink: (description: string, productId: number, checked: boolean) => void;
}) {
    const all = filter === 'all';
    const visible = sheet.lines.filter(l => passesFilter(l, filter));
    if (visible.length === 0) return <p role="status">No lines on this sheet with this filter.</p>;

    return <div className="table-scroll" role="region" aria-label={`Sheet ${sheet.name}, scrolls horizontally`} tabIndex={0}>
        <Table className="import-grid" aria-label={`Lines of sheet ${sheet.name}`}>
            <TableHead><TableRow>{COLUMNS.map(c => <TableHeader key={c}>{c}</TableHeader>)}</TableRow></TableHead>
            <TableBody>
                {visible.map((l, i) => {
                    // Date, folio and supplier show once per folio, like in the Excel; with a filter they repeat so each line says which purchase it belongs to.
                    const starts = !all || i === 0 || visible[i - 1].block !== l.block;
                    return <TableRow key={l.row_num} className={[starts ? 'import-new-block' : '', l.status === 'existing' ? 'import-done' : ''].join(' ').trim()}>
                        <TableCell className="import-row mono">{l.row_num}</TableCell>
                        <TableCell className="import-date mono">{starts ? <>
                            <span className="import-nowrap">{shortDate(l.date)}</span>
                            {doubtfulDate(l) && <span className="import-small">{l.date_status}</span>}
                        </> : ''}</TableCell>
                        <TableCell className="import-folio mono">{starts ? l.folio ?? '—' : ''}</TableCell>
                        <TableCell className="import-desc">{l.description}</TableCell>
                        <TableCell className="import-num mono">{quantityText(l.quantity)}</TableCell>
                        <TableCell className="import-num mono">{unitPriceText(l.unit_price)}</TableCell>
                        <TableCell className="import-num mono">{money(l.amount)}</TableCell>
                        <TableCell className="import-supplier-col">{starts ? <>
                            {l.supplier ?? <span className="muted">No supplier</span>}
                            {l.supplier && l.supplier_id === null && <span className="import-small">Doesn't match the table</span>}
                        </> : ''}</TableCell>
                        <TableCell className="import-requested-by">{starts ? l.requester ?? '—' : ''}</TableCell>
                        <TableCell className="import-comment">{starts ? l.note ?? '—' : ''}</TableCell>
                        <TableCell className="import-status-col"><Status line={l} /></TableCell>
                        <TableCell className="import-category"><Catalog line={l} linkId={`import-link-${index}-${l.row_num}`} links={links} onLink={onLink} /></TableCell>
                    </TableRow>;
                })}
            </TableBody>
        </Table>
    </div>;
}

function Status({ line }: { line: ImportedLine }) {
    return <div className="import-status">
        {line.status === 'new' && <Tag type="blue" size="sm">New</Tag>}
        {line.status === 'existing' && <Tag type="gray" size="sm">Already there</Tag>}
        {line.status === 'description_differs' && <Tag type="warm-gray" size="sm">Different description</Tag>}
        {line.type === 'no_amount' && <Tag type="outline" size="sm">No amount</Tag>}
        {line.existing_description && <span className="import-small">In the database: {line.existing_description}</span>}
    </div>;
}

function Catalog({ line, linkId, links, onLink }: {
    line: ImportedLine; linkId: string; links: ReadonlyMap<string, number>;
    onLink: (description: string, productId: number, checked: boolean) => void;
}) {
    if (line.product) {
        return <div className="import-link"><span className="import-small">Linked to</span>
            <span className="mono">{line.product.code}</span> — {line.product.name}</div>;
    }
    if (line.status !== 'new') return <span className="muted">—</span>;
    const s = line.suggestion;
    if (!s) return <span className="muted">Not linked · new product</span>;
    const checked = links.get(line.description) === s.product.id;
    return <div className="import-suggestion">
        <span className="import-small">
            {s.level === 'near_certain' ? 'Almost certainly the same' : 'Similar, check it'}{s.has_numbers ? ', with the same measurements' : ''} · {Math.round(s.similarity * 100)} %
        </span>
        <Checkbox id={linkId} labelText={<><span className="mono">{s.product.code}</span> — {s.product.name}</>}
            checked={checked} onChange={(_, { checked }) => onLink(line.description, s.product.id, checked)} />
        <span className="import-small">As written there: {s.similar_to}</span>
    </div>;
}
