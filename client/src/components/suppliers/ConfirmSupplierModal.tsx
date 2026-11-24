import { InlineNotification, Modal, Select, SelectItem } from '@carbon/react';
import { useState } from 'react';
import { errorMessage } from '../../queries';
import { plural, useWriteSupplier } from '../../purchases/suppliers';
import type { SupplierSummary } from '../../purchases/types';

// The actions that can't be undone with one click (merge, archive, delete) get their own confirmation, with the consequences in view.

type Links = { purchases: number; invoices: number; movements: number };

const linksText = (e: Links) => [
    e.purchases > 0 && plural(e.purchases, 'line from the books', 'lines from the books'),
    e.invoices > 0 && plural(e.invoices, 'invoice', 'invoices'),
    e.movements > 0 && plural(e.movements, 'inventory movement', 'inventory movements'),
].filter(Boolean).join(', ');

export function MergeSupplierModal({ supplier, links, candidates, onClose, onDone }: {
    supplier: { id: number; name: string };
    links: Links;
    /** The other active suppliers in the catalog. */
    candidates: SupplierSummary[];
    onClose: () => void;
    onDone: (targetName: string) => void;
}) {
    const [target, setTarget] = useState('');
    const write = useWriteSupplier();
    const chosen = candidates.find(c => String(c.id) === target);
    const has = linksText(links);

    return <Modal open size="sm" danger preventCloseOnClickOutside
        modalLabel="Merge suppliers" modalHeading={`Merge “${supplier.name}”`}
        closeButtonLabel="Close" primaryButtonText="Merge" secondaryButtonText="Cancel"
        primaryButtonDisabled={!chosen || write.isPending}
        loadingStatus={write.isPending ? 'active' : 'inactive'} loadingDescription="Merging…"
        onRequestClose={() => { if (!write.isPending) onClose(); }}
        onRequestSubmit={() => {
            if (!chosen) return;
            void write.mutateAsync({ path: `/${supplier.id}/merge`, body: { into: chosen.id } }).then(() => onDone(chosen.name)).catch(() => undefined);
        }}>
        <div className="stack">
            <p>{has ? `Moves ${has} to the selected supplier.` : 'No linked records.'}</p>
            <Select id="merge-target" labelText="Merge into" value={target} onChange={e => setTarget(e.target.value)}>
                <SelectItem value="" text="Pick a supplier" />
                {candidates.map(c => <SelectItem key={c.id} value={String(c.id)} text={c.name} />)}
            </Select>
            {write.error && <InlineNotification kind="error" hideCloseButton title="Could not merge" subtitle={errorMessage(write.error)} />}
        </div>
    </Modal>;
}

export function ActionModal({ title, button, danger = false, text, path, method = 'POST', onClose, onDone }: {
    title: string;
    button: string;
    danger?: boolean;
    text: string;
    path: string;
    method?: 'POST' | 'DELETE';
    onClose: () => void;
    onDone: () => void;
}) {
    const write = useWriteSupplier();
    return <Modal open size="sm" danger={danger} preventCloseOnClickOutside
        modalLabel="Suppliers" modalHeading={title} closeButtonLabel="Close"
        primaryButtonText={button} secondaryButtonText="Cancel"
        primaryButtonDisabled={write.isPending}
        loadingStatus={write.isPending ? 'active' : 'inactive'} loadingDescription="Saving…"
        onRequestClose={() => { if (!write.isPending) onClose(); }}
        onRequestSubmit={() => { void write.mutateAsync({ path, method }).then(onDone).catch(() => undefined); }}>
        <div className="stack">
            <p>{text}</p>
            {write.error && <InlineNotification kind="error" hideCloseButton title="Could not complete" subtitle={errorMessage(write.error)} />}
        </div>
    </Modal>;
}
