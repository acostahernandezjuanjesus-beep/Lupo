import { useState } from 'react';
import { Button, IconButton, InlineNotification, Modal, TextArea, TextInput } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { errorMessage } from '../../queries';
import { MAX_PHONES, useWriteSupplier } from '../../purchases/suppliers';
import type { SupplierContact } from '../../purchases/types';

// Everything is optional, but it can't be empty. A contact has several phones (mobile, office), each on its
// own row so each gets its own dial link.

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const cleaned = (phones: string[]) => [...new Set(phones.map(t => t.trim().replace(/\s+/g, ' ')).filter(t => t !== ''))];

export function ContactModal({ supplierId, contact, onClose, onDone }: {
    supplierId: number;
    /** null = a new one. */
    contact: SupplierContact | null;
    onClose: () => void;
    onDone: () => void;
}) {
    const [name, setName] = useState(contact?.name ?? '');
    // There's always at least one phone row in view, even if empty.
    const [phones, setPhones] = useState<string[]>(contact?.phones.length ? contact.phones : ['']);
    const [email, setEmail] = useState(contact?.email ?? '');
    const [address, setAddress] = useState(contact?.address ?? '');
    const write = useWriteSupplier();

    const list = cleaned(phones);
    const empty = list.length === 0 && [name, email, address].every(v => v.trim() === '');
    const emailError = email.trim() !== '' && !RE_EMAIL.test(email.trim()) ? "That doesn't look like an email" : null;
    const unchanged = contact !== null && name.trim() === (contact.name ?? '') && list.join('\n') === contact.phones.join('\n')
        && email.trim() === (contact.email ?? '') && address.trim() === (contact.address ?? '');

    const save = () => {
        const body = { name: name.trim(), phones: list, email: email.trim(), address: address.trim() };
        void write.mutateAsync(contact === null
            ? { path: `/${supplierId}/contacts`, body }
            : { path: `/${supplierId}/contacts/${contact.id}`, method: 'PUT', body }).then(onDone).catch(() => undefined);
    };

    return <Modal open size="sm" preventCloseOnClickOutside
        modalLabel="Contacts" modalHeading={contact === null ? 'New contact' : 'Edit contact'}
        closeButtonLabel="Close" primaryButtonText="Save" secondaryButtonText="Cancel"
        primaryButtonDisabled={empty || emailError !== null || unchanged || write.isPending}
        loadingStatus={write.isPending ? 'active' : 'inactive'} loadingDescription="Saving…"
        onRequestClose={() => { if (!write.isPending) onClose(); }}
        onRequestSubmit={save}>
        <div className="stack">
            <TextInput id="contact-name" labelText="Name" maxLength={120} autoComplete="off" data-modal-primary-focus
                value={name} onChange={e => setName(e.target.value)} />
            <fieldset className="contact-phones">
                <legend className="cds--label">Phones</legend>
                {phones.map((t, i) => <div key={i} className="contact-phone">
                    <TextInput id={`contact-phone-${i}`} labelText={`Phone ${i + 1}`} hideLabel type="tel" maxLength={40} autoComplete="off"
                        placeholder={i === 0 ? '555 123 4567' : 'Another: mobile, office…'}
                        value={t} onChange={e => setPhones(ts => ts.map((x, j) => j === i ? e.target.value : x))} />
                    {phones.length > 1 && <IconButton kind="ghost" size="md" label={`Remove phone ${i + 1}`} align="left"
                        onClick={() => setPhones(ts => ts.filter((_, j) => j !== i))}><TrashCan /></IconButton>}
                </div>)}
                {phones.length < MAX_PHONES && <div>
                    <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setPhones(ts => [...ts, ''])}>Add another phone</Button>
                </div>}
            </fieldset>
            <TextInput id="contact-email" labelText="Email" type="email" maxLength={120} autoComplete="off"
                value={email} onChange={e => setEmail(e.target.value)} invalid={emailError !== null} invalidText={emailError ?? ''} />
            <TextArea id="contact-address" labelText="Address" maxLength={300} rows={3}
                value={address} onChange={e => setAddress(e.target.value)} />
            {write.error && <InlineNotification kind="error" hideCloseButton title="Could not save" subtitle={errorMessage(write.error)} />}
        </div>
    </Modal>;
}
