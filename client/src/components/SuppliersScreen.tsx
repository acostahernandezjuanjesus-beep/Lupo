import { Fragment, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineLoading, InlineNotification, Search, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag, Tile, Toggle } from '@carbon/react';
import { Add, ArrowDown, ArrowsVertical, ArrowUp, ChevronDown } from '@carbon/icons-react';
import { fetchJson, errorMessage } from '../queries';
import { money, shortDate } from '../money';
import { tagColor, tagsInUse, rowKey, sortSuppliers, linesText } from '../purchases/suppliers';
import type { SupplierSort } from '../purchases/suppliers';
import type { SupplierList, SupplierSummary } from '../purchases/types';
import { SupplierCard } from './suppliers/SupplierCard';
import { SupplierCardModal } from './suppliers/SupplierCardModal';
import { TagsModal } from './suppliers/TagsModal';

// Two kinds of supplier, and the screen says which: catalog ones, and ones only written in a book line. They're
// never merged by similarity; linking is a person's call. A supplier with no purchases in the books shows "—",
// not $0.00: nobody said nothing was bought from it. The list comes ordered by most purchased; the headers
// reorder it (one click sorts up, another down, the third restores the original order).

/** Tag filter: one particular tag, the suppliers with none, or no filter. */
type Filter = { tag: string } | 'none' | null;

const COLUMNS = 5;

export function SuppliersScreen({ isAdmin }: { isAdmin: boolean }) {
    const [withArchived, setWithArchived] = useState(false);
    const list = useQuery({
        queryKey: ['suppliers', { withArchived }],
        queryFn: fetchJson<SupplierList>(`/api/suppliers${withArchived ? '?archived=1' : ''}`),
    });
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState<Filter>(null);
    const [sort, setSort] = useState<SupplierSort | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);
    const [tagList, setTagList] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);

    const all = list.data?.suppliers ?? [];
    const inUse = tagsInUse(all);
    const known = inUse.map(e => e.tag);
    // What the card offers for one-click adding: preset tags plus the ones someone already has, without repeats.
    const presets = list.data?.preset_tags ?? [];
    const toPick = [...presets.map(e => e.name), ...known.filter(c => !presets.some(e => e.name.toLowerCase() === c.toLowerCase()))]
        .sort((a, b) => a.localeCompare(b, 'en'));
    // A tag nobody has any more (the last one was removed) stops existing: the filter asking for it lets go on its own.
    const liveFilter: Filter = filter !== null && filter !== 'none' && !known.includes(filter.tag) ? null : filter;
    const text = search.trim().toLowerCase();
    const matches = (p: SupplierSummary) => text === '' || p.name.toLowerCase().includes(text)
        || (p.rfc ?? '').toLowerCase().includes(text) || (p.tags ?? []).some(e => e.toLowerCase().includes(text));
    const passesFilter = (p: SupplierSummary) => liveFilter === null ? true
        : liveFilter === 'none' ? p.in_catalog && (p.tags ?? []).length === 0
            : (p.tags ?? []).includes(liveFilter.tag);
    const visible = sortSuppliers(all.filter(p => matches(p) && passesFilter(p)), sort);
    // Names start A to Z; figures and dates start with the biggest and most recent.
    const header = (by: SupplierSort['by'], title: string, numeric = false) => {
        const first = by === 'name' ? 'ASC' : 'DESC', second = first === 'ASC' ? 'DESC' : 'ASC';
        const direction = sort?.by === by ? sort.direction : null;
        // Our own button instead of Carbon's `isSortable`: that one brings its notice in English and its styles aren't bundled in this project.
        return <TableHeader className={numeric ? 'num' : undefined} aria-sort={direction === null ? undefined : direction === 'ASC' ? 'ascending' : 'descending'}>
            <button type="button" className="column-sort" title={`Sort by ${title.toLowerCase()}`}
                onClick={() => setSort(o => o?.by !== by ? { by, direction: first } : o.direction === first ? { by, direction: second } : null)}>
                {title}
                {direction === null ? <ArrowsVertical className="column-sort__arrow column-sort__arrow--none" aria-hidden="true" />
                    : direction === 'ASC' ? <ArrowUp className="column-sort__arrow" aria-hidden="true" /> : <ArrowDown className="column-sort__arrow" aria-hidden="true" />}
            </button>
        </TableHeader>;
    };
    const active = all.filter(p => p.in_catalog && !p.archived);
    const untagged = all.filter(p => p.in_catalog && (p.tags ?? []).length === 0).length;

    // The selected row can end up out of view (just created, or the card above closed): bring it in.
    useEffect(() => {
        if (selected === null) return;
        document.querySelector(`[data-supplier="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [selected]);

    return <section className="page stack">
        <div className="page-heading">
            <div><h1>Suppliers</h1></div>
            <Button kind="primary" size="md" renderIcon={Add} onClick={() => setCreating(true)}>New supplier</Button>
        </div>

        {notice && <InlineNotification className="sticky-notice" kind="success" title="Done" subtitle={notice} onCloseButtonClick={() => setNotice(null)} />}
        {list.error && <InlineNotification kind="error" title="Could not load the suppliers" subtitle={errorMessage(list.error)} hideCloseButton />}
        {list.isPending && <InlineLoading description="Loading…" />}

        {list.data && (all.length === 0
            ? <Tile className="panel" role="status"><p className="muted">No suppliers yet.</p></Tile>
            : <Tile className="panel suppliers-panel">
                <div className="suppliers-bar">
                    <div className="min-w-0 flex-1">
                        <Search id="suppliers-search" size="md" labelText="Search a supplier" closeButtonLabelText="Clear search"
                            placeholder="Name, RFC or tag" value={search} onChange={e => setSearch(e.target.value)} />
                    </div>
                    {isAdmin && <Toggle id="suppliers-archived" size="sm" labelText="Archived" labelA="Hidden" labelB="Shown"
                        toggled={withArchived} onToggle={setWithArchived} />}
                </div>

                <div className="tag-filter" role="group" aria-label="Filter by tag">
                    <span className="tag-filter__title">Tags</span>
                    {inUse.length === 0
                        ? <span className="muted">None</span>
                        : <>
                            <button type="button" className="tag-chip" aria-pressed={liveFilter === null} onClick={() => setFilter(null)}>All</button>
                            {inUse.map(e => <button key={e.tag} type="button" className="tag-chip"
                                aria-pressed={liveFilter !== null && liveFilter !== 'none' && liveFilter.tag === e.tag}
                                onClick={() => setFilter(f => f !== null && f !== 'none' && f.tag === e.tag ? null : { tag: e.tag })}>
                                {e.tag} <span className="tag-chip__count">{e.suppliers}</span>
                            </button>)}
                            {untagged > 0 && <button type="button" className="tag-chip" aria-pressed={liveFilter === 'none'}
                                onClick={() => setFilter(f => f === 'none' ? null : 'none')}>
                                No tag <span className="tag-chip__count">{untagged}</span>
                            </button>}
                        </>}
                    {isAdmin && <Button className="tag-filter__list" kind="ghost" size="sm" onClick={() => setTagList(true)}>Tag list</Button>}
                </div>

                <div className="table-scroll">
                    <Table className="card-table suppliers-table" aria-label="Suppliers">
                        <TableHead><TableRow>
                            {header('name', 'Supplier')}<TableHeader>RFC</TableHeader>{header('lines', 'Lines', true)}
                            {header('amount', 'Amount', true)}{header('last_date', 'Last purchase')}
                        </TableRow></TableHead>
                        <TableBody>
                            {visible.map(p => {
                                const key = rowKey(p), open = key === selected;
                                return <Fragment key={key}>
                                    <TableRow className={open ? 'supplier-row supplier-row--open' : 'supplier-row'} data-supplier={key}
                                        onClick={() => setSelected(open ? null : key)}>
                                        <TableCell>
                                            <button type="button" className="product-link supplier-row__name" aria-expanded={open}>
                                                <ChevronDown className="supplier-row__arrow" aria-hidden="true" />
                                                <span>{p.name}</span>
                                            </button>
                                            {((p.tags ?? []).length > 0 || !p.in_catalog || p.archived) && <div className="tags supplier-row__tags">
                                                {(p.tags ?? []).map(e => <Tag key={e} size="sm" type={tagColor(e)}>{e}</Tag>)}
                                                {!p.in_catalog && <Tag type="outline" size="sm">Only in the books</Tag>}
                                                {p.archived && <Tag type="outline" size="sm">Archived</Tag>}
                                            </div>}
                                        </TableCell>
                                        <TableCell className={p.rfc ? 'mono' : 'mono empty-cell'} data-label="RFC">{p.rfc ?? '—'}</TableCell>
                                        <TableCell className="mono num" data-label="Lines">{p.lines === 0 ? '—' : p.lines.toLocaleString('en-US')}</TableCell>
                                        <TableCell className="mono num" data-label="Amount">{money(p.amount)}</TableCell>
                                        <TableCell data-label="Last purchase">{shortDate(p.last_date)}</TableCell>
                                    </TableRow>
                                    {open && <TableRow className="sheet-row">
                                        <TableCell colSpan={COLUMNS}>
                                            <div className="sheet-row__slide"><div className="sheet-row__inner">
                                                <SupplierCard supplier={p} active={active} knownTags={toPick} isAdmin={isAdmin} onNotice={setNotice}
                                                    onGone={message => { setSelected(null); setNotice(message); }} />
                                            </div></div>
                                        </TableCell>
                                    </TableRow>}
                                </Fragment>;
                            })}
                            {visible.length === 0 && <TableRow><TableCell colSpan={COLUMNS}>
                                {text !== '' ? 'No supplier matches the search.' : 'No supplier has that tag.'}
                            </TableCell></TableRow>}
                        </TableBody>
                    </Table>
                </div>

                {list.data.no_supplier && <p className="muted">
                    Also, {linesText(list.data.no_supplier.lines)} ({money(list.data.no_supplier.amount)}) have no supplier noted in the book.
                </p>}
            </Tile>)}

        {tagList && <TagsModal presets={presets} onClose={() => setTagList(false)} />}
        {creating && <SupplierCardModal supplier={null} onClose={() => setCreating(false)}
            onDone={(created, summary) => { setCreating(false); setSelected(`id:${created.id}`); setNotice(`“${created.name}” is now in the catalog. ${summary ?? ''}`.trim()); }} />}
    </section>;
}
