import { useState } from 'react';
import { InlineNotification, Modal, TextArea, TextInput } from '@carbon/react';
import { errorMessage } from '../../queries';
import { linkedSummary, useWriteSupplier } from '../../purchases/suppliers';
import type { SupplierCard } from '../../purchases/types';

// Creating a supplier doesn't require it to be in a book: it can come from outside books or from an invoice not
// captured yet. Renaming loses nothing: the server keeps the old name as an alias.

const RE_RFC = /^[A-ZÑ&0-9]{12,13}$/

type Saved = { id: number; name: string; linked?: { purchases: number; invoices: number } }

export function SupplierCardModal({ supplier, onClose, onDone }: {
    /** null = a new one. */
    supplier: SupplierCard | null;
    onClose: () => void;
    onDone: (saved: Saved, notice: string | null) => void;
}) {
    const [name, setName] = useState(supplier?.name ?? '');
    const [rfc, setRfc] = useState(supplier?.rfc ?? '');
    const [note, setNote] = useState(supplier?.note ?? '');
    const write = useWriteSupplier<Saved>();

    const cleanRfc = rfc.trim().toUpperCase();
    const nameError = name.trim() === '' ? 'Enter the name' : null;
    const rfcError = cleanRfc !== '' && !RE_RFC.test(cleanRfc) ? 'It is 12 or 13 letters and numbers' : null;
    const hasChanges = supplier === null
        || name.trim() !== supplier.name || cleanRfc !== (supplier.rfc ?? '') || note.trim() !== (supplier.note ?? '');

    async function save() {
        const body = { name: name.trim(), rfc: cleanRfc || null, note: note.trim() || null };
        const saved = await write.mutateAsync(supplier === null
            ? { path: '', body }
            : { path: `/${supplier.id}`, method: 'PATCH', body });
        onDone(saved, linkedSummary(saved.linked));
    }

    return <Modal open size="sm" preventCloseOnClickOutside
        modalLabel="Suppliers" modalHeading={supplier === null ? 'New supplier' : 'Edit supplier'}
        closeButtonLabel="Close" primaryButtonText="Save" secondaryButtonText="Cancel"
        primaryButtonDisabled={nameError !== null || rfcError !== null || !hasChanges || write.isPending}
        loadingStatus={write.isPending ? 'active' : 'inactive'} loadingDescription="Saving…"
        onRequestClose={() => { if (!write.isPending) onClose(); }}
        onRequestSubmit={() => { void save().catch(() => undefined); }}>
        <div className="stack">
            <TextInput id="supplier-name" labelText="Name" maxLength={120} autoComplete="off" data-modal-primary-focus
                value={name} onChange={e => setName(e.target.value)}
                invalid={name !== '' && nameError !== null} invalidText={nameError ?? ''} />
            <TextInput id="supplier-rfc" labelText="RFC (optional)" maxLength={13} autoComplete="off"
                value={rfc} onChange={e => setRfc(e.target.value)} invalid={rfcError !== null} invalidText={rfcError ?? ''} />
            <TextArea id="supplier-note" labelText="Note (optional)" maxLength={1000} rows={3}
                value={note} onChange={e => setNote(e.target.value)} />
            {write.error && <InlineNotification kind="error" hideCloseButton title="Could not save" subtitle={errorMessage(write.error)} />}
        </div>
    </Modal>;
}
