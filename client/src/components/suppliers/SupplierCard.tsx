import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, InlineLoading, InlineNotification, TextInput } from '@carbon/react';
import { ArrowUpRight } from '@carbon/icons-react';
import { Link } from 'react-router';
import { fetchJson, errorMessage } from '../../queries';
import { money, shortDate } from '../../money';
import {
    detailUrl, purchasesLink, contactName, dialNumber, ALIAS_ORIGIN_LABEL, linesText, linkedSummary, useWriteSupplier,
} from '../../purchases/suppliers';
import type { SupplierContact, SupplierDetail, SupplierSummary } from '../../purchases/types';
import { SupplierCardModal } from './SupplierCardModal';
import { ContactModal } from './ContactModal';
import { ActionModal, MergeSupplierModal } from './ConfirmSupplierModal';
import { SupplierTags } from './SupplierTags';

// One supplier in depth. Catalog ones are edited, have aliases and (admin) get merged, archived or deleted;
// one that's only written in the books is linked to a catalog one or added as new. Lines are never rewritten:
// what changes is which supplier they belong to. It unfolds under its row, full width (`.supplier-sheet`).

type ModalKind = 'edit' | 'merge' | 'archive' | 'unarchive' | 'delete' | null;

export function SupplierCard({ supplier, active, knownTags, isAdmin, onNotice, onGone }: {
    supplier: SupplierSummary;
    /** Active catalog suppliers: who it can be merged into. */
    active: SupplierSummary[];
    /** Tags some supplier already has: suggested when typing one. */
    knownTags: string[];
    isAdmin: boolean;
    onNotice: (notice: string | null) => void;
    /** The supplier no longer exists as it looked (merged, deleted or linked to another): the selection must be dropped. */
    onGone: (notice: string) => void;
}) {
    const detail = useQuery({ queryKey: ['suppliers', 'detail', supplier.id ?? `text:${supplier.name}`], queryFn: fetchJson<SupplierDetail>(detailUrl(supplier)) });
    const write = useWriteSupplier<{ linked?: number | { purchases: number; invoices: number }; name?: string }>();
    const [modal, setModal] = useState<ModalKind>(null);
    const [alias, setAlias] = useState('');
    const [contact, setContact] = useState<SupplierContact | 'new' | null>(null);
    const [removing, setRemoving] = useState<SupplierContact | null>(null);
    const d = detail.data;
    const card = d?.card ?? null;
    const links = d?.links ?? null;
    const noHistory = links !== null && links.purchases + links.invoices + links.movements === 0;

    const addAlias = () => {
        if (card === null || alias.trim() === '') return;
        write.mutate({ path: `/${card.id}/aliases`, body: { alias: alias.trim() } }, {
            onSuccess: r => { setAlias(''); onNotice(linkedSummary(r.linked) ?? 'Alias saved.'); },
        });
    };
    const adopt = (sameAs: number | null) => write.mutate(
        { path: '/adopt', body: { name: supplier.name, ...(sameAs === null ? {} : { supplier_id: sameAs }) } },
        { onSuccess: r => onGone(`“${supplier.name}” is now linked to “${r.name ?? supplier.name}”. ${linkedSummary(r.linked) ?? ''}`.trim()) });

    return <div className="supplier-sheet">
        {detail.error && <InlineNotification className="sheet-notice" kind="error" title="Could not load the supplier" subtitle={errorMessage(detail.error)} hideCloseButton />}
        {detail.isPending && <InlineLoading className="sheet-notice" description="Loading…" />}
        {write.error && <InlineNotification className="sheet-notice" kind="error" title="Could not save" subtitle={errorMessage(write.error)} hideCloseButton />}

        {d && <>
            <div className="sheet-section">
                <h3>Summary</h3>
                <dl className="sheet-data">
                    <dt>Purchases</dt>
                    <dd>{d.lines === 0 ? <span className="muted">No purchases in the books yet</span>
                        : <><span className="mono">{money(d.amount)}</span> in {linesText(d.lines)}</>}</dd>
                    {d.first_date && <><dt>Period</dt><dd>{shortDate(d.first_date)} – {shortDate(d.last_date)}</dd></>}
                    <dt>RFC</dt><dd>{card?.rfc ? <span className="mono">{card.rfc}</span> : <span className="muted">No RFC</span>}</dd>
                    {card?.note && <><dt>Note</dt><dd className="break-words whitespace-pre-line">{card.note}</dd></>}
                </dl>
                <div className="flex flex-wrap gap-2">
                    {d.lines > 0 && <Button as={Link} to={purchasesLink(supplier)} kind="tertiary" size="md" renderIcon={ArrowUpRight}>See its lines in the books</Button>}
                    {card && <Button kind="secondary" size="md" onClick={() => setModal('edit')}>Edit</Button>}
                </div>
            </div>

            {!supplier.in_catalog && <div className="sheet-section">
                <h3>Add to catalog</h3>
                {supplier.suggested && <p>Similar: <strong>{supplier.suggested.name}</strong></p>}
                <div className="flex flex-wrap gap-2">
                    {supplier.suggested && <Button kind="primary" size="md" disabled={write.isPending} onClick={() => adopt(supplier.suggested!.id)}>
                        Use {supplier.suggested.name}
                    </Button>}
                    <Button kind={supplier.suggested ? 'tertiary' : 'primary'} size="md" disabled={write.isPending} onClick={() => adopt(null)}>
                        {write.isPending ? 'Saving…' : supplier.suggested ? 'Add as new' : 'Add to catalog'}
                    </Button>
                </div>
            </div>}

            {card && <SupplierTags supplierId={card.id} tags={card.tags} known={knownTags} onNotice={onNotice} />}

            {isAdmin && card && <div className="sheet-section">
                <h3>Contacts</h3>
                {d.contacts.length === 0
                    ? <p className="muted">None yet.</p>
                    : <ul>{d.contacts.map(c => <li key={c.id} className="flex items-start justify-between gap-4 border-b border-border py-2 text-sm">
                        <span className="min-w-0 break-words">
                            {c.name && <strong className="block">{c.name}</strong>}
                            {c.phones.map(t => { const n = dialNumber(t); return n ? <a key={t} className="block" href={`tel:${n}`}>{t}</a> : <span key={t} className="block">{t}</span>; })}
                            {c.email && <a className="block" href={`mailto:${c.email}`}>{c.email}</a>}
                            {c.address && <span className="block whitespace-pre-line muted">{c.address}</span>}
                        </span>
                        <span className="flex flex-none">
                            <Button kind="ghost" size="sm" aria-label={`Edit the contact ${contactName(c)}`} onClick={() => setContact(c)}>Edit</Button>
                            <Button kind="ghost" size="sm" aria-label={`Remove the contact ${contactName(c)}`} onClick={() => setRemoving(c)}>Remove</Button>
                        </span>
                    </li>)}</ul>}
                <div><Button kind="tertiary" size="md" onClick={() => setContact('new')}>Add contact</Button></div>
            </div>}

            {card && <div className="sheet-section">
                <h3>Aliases</h3>
                {d.aliases.length === 0
                    ? <p className="muted">None yet.</p>
                    : <ul>{d.aliases.map(e => <li key={e.id} className="flex items-start justify-between gap-4 border-b border-border py-2 text-sm">
                        <span className="min-w-0 break-words">{e.alias} <span className="muted">· {ALIAS_ORIGIN_LABEL[e.origin]}{e.created_by ? `, ${e.created_by}` : ''}</span></span>
                        <Button kind="ghost" size="sm" disabled={write.isPending} aria-label={`Remove the alias ${e.alias}`}
                            onClick={() => write.mutate({ path: `/${card.id}/aliases/${e.id}`, method: 'DELETE' }, { onSuccess: () => onNotice('Alias removed. What was already linked stays linked.') })}>
                            Remove
                        </Button>
                    </li>)}</ul>}
                <div className="sheet-add">
                    <TextInput id="supplier-alias" labelText="Add another name" maxLength={120} autoComplete="off" size="md"
                        value={alias} onChange={e => setAlias(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAlias(); } }} />
                    <Button kind="tertiary" size="md" disabled={alias.trim() === '' || write.isPending} onClick={addAlias}>Add</Button>
                </div>
            </div>}

            <div className="sheet-section">
                <h3>Latest purchases</h3>
                {d.latest.length === 0
                    ? <p className="muted">{d.lines === 0 ? 'No purchases yet.' : 'Its lines have no date.'}</p>
                    : <ul>{d.latest.map((c, i) => <li key={`${i}${c.date}${c.folio}`} className="flex items-start justify-between gap-4 border-b border-border py-2 text-sm">
                        <span>{shortDate(c.date)}{c.folio ? ` · folio ${c.folio}` : ''} · {linesText(c.lines)}</span>
                        <span className="mono flex-none whitespace-nowrap">{money(c.amount)}</span>
                    </li>)}</ul>}
            </div>

            {d.top_purchased.length > 0 && <div className="sheet-section">
                <h3>Most purchased from it</h3>
                <ul>{d.top_purchased.map(m => <li key={m.description} className="flex items-start justify-between gap-4 border-b border-border py-2 text-sm">
                    <span className="min-w-0 break-words">{m.description}</span>
                    <span className="mono flex-none whitespace-nowrap">{money(m.amount)}</span>
                </li>)}</ul>
            </div>}

            {isAdmin && card && links && <div className="sheet-section">
                <h3>Manage</h3>
                <div className="flex flex-wrap gap-2">
                    <Button kind="tertiary" size="md" onClick={() => setModal('merge')}>Merge into another…</Button>
                    {card.archived
                        ? <Button kind="tertiary" size="md" onClick={() => setModal('unarchive')}>Restore</Button>
                        : <Button kind="tertiary" size="md" onClick={() => setModal('archive')}>Archive</Button>}
                    <Button kind="danger--tertiary" size="md" disabled={!noHistory} onClick={() => setModal('delete')}>Delete</Button>
                </div>
            </div>}
        </>}

        {modal === 'edit' && card && <SupplierCardModal supplier={card} onClose={() => setModal(null)}
            onDone={(_saved, notice) => { setModal(null); onNotice(notice ?? 'Changes saved.'); }} />}
        {contact !== null && card && <ContactModal supplierId={card.id} contact={contact === 'new' ? null : contact}
            onClose={() => setContact(null)} onDone={() => { setContact(null); onNotice('Contact saved.'); }} />}
        {removing && card && <ActionModal title="Remove contact" button="Remove" danger path={`/${card.id}/contacts/${removing.id}`} method="DELETE"
            text={`“${contactName(removing)}” will be deleted from this supplier. This can't be undone.`}
            onClose={() => setRemoving(null)} onDone={() => { setRemoving(null); onNotice('Contact removed.'); }} />}
        {modal === 'merge' && card && links && <MergeSupplierModal supplier={card} links={links}
            candidates={active.filter(v => v.id !== card.id)} onClose={() => setModal(null)}
            onDone={target => { setModal(null); onGone(`“${card.name}” was merged into “${target}”. Its name is now an alias.`); }} />}
        {modal === 'archive' && card && <ActionModal title={`Archive “${card.name}”`} button="Archive" path={`/${card.id}/archive`}
            text="It stops showing in the list and in the pickers. Its purchases, invoices and movements stay linked, and it can be restored."
            onClose={() => setModal(null)} onDone={() => { setModal(null); onNotice('Supplier archived.'); }} />}
        {modal === 'unarchive' && card && <ActionModal title={`Restore “${card.name}”`} button="Restore" path={`/${card.id}/unarchive`}
            text="It shows again in the list and in the pickers."
            onClose={() => setModal(null)} onDone={() => { setModal(null); onNotice('Supplier restored.'); }} />}
        {modal === 'delete' && card && <ActionModal title={`Delete “${card.name}”`} button="Delete" danger path={`/${card.id}`} method="DELETE"
            text="Nothing is linked to it, so it's deleted along with its aliases and contacts. This can't be undone."
            onClose={() => setModal(null)} onDone={() => { setModal(null); onGone(`“${card.name}” was deleted.`); }} />}
    </div>;
}
