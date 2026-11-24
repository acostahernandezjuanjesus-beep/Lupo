import { useState } from 'react';
import { Button, DismissibleTag, InlineNotification, Modal, TextInput } from '@carbon/react';
import { errorMessage } from '../../queries';
import { tagColor, MAX_TAG_LENGTH, useWriteSupplier } from '../../purchases/suppliers';
import type { PresetTag } from '../../purchases/types';

// Admin only: the preset tags offered on every supplier's card even if nobody has them yet. Removing one here
// doesn't remove it from suppliers that already have it.
export function TagsModal({ presets, onClose }: { presets: PresetTag[]; onClose: () => void }) {
    const [draft, setDraft] = useState('');
    const write = useWriteSupplier();
    const clean = draft.trim().replace(/\s+/g, ' ');
    const duplicate = presets.some(e => e.name.toLowerCase() === clean.toLowerCase());
    const add = () => {
        if (clean === '' || duplicate) return;
        write.mutate({ path: '/tags', body: { name: clean } }, { onSuccess: () => setDraft('') });
    };

    return <Modal open passiveModal size="sm" modalLabel="Suppliers" modalHeading="Preset tags" closeButtonLabel="Close" onRequestClose={onClose}>
        <div className="stack">
            {presets.length === 0
                ? <p className="muted">The list is empty.</p>
                : <div className="tags">{presets.map(e => <DismissibleTag key={e.id} size="md" type={tagColor(e.name)} text={e.name}
                    disabled={write.isPending} title="Remove from the list" dismissTooltipLabel={`Remove ${e.name}`}
                    onClose={() => write.mutate({ path: `/tags/${e.id}`, method: 'DELETE' })} />)}</div>}
            <form className="sheet-add" onSubmit={ev => { ev.preventDefault(); add(); }}>
                <TextInput id="preset-tag-new" labelText="Add to the list" size="md" maxLength={MAX_TAG_LENGTH} autoComplete="off" data-modal-primary-focus
                    value={draft} onChange={e => setDraft(e.target.value)} invalid={duplicate} invalidText="It's already in the list" />
                <Button type="submit" kind="tertiary" size="md" disabled={clean === '' || duplicate || write.isPending}>Add</Button>
            </form>
            {write.error && <InlineNotification kind="error" hideCloseButton title="Could not save" subtitle={errorMessage(write.error)} />}
        </div>
    </Modal>;
}
