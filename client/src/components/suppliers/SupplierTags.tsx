import { useState } from 'react';
import { Button, DismissibleTag, TextInput } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { tagColor, MAX_TAG_LENGTH, MAX_TAGS, useWriteSupplier } from '../../purchases/suppliers';

// What a catalog supplier is about ("Steel", "Gases", "Service"). Preset tags and ones another supplier already
// uses are offered for one-click adding; a new one can also be typed, and the server normalizes how they're written.
export function SupplierTags({ supplierId, tags, known, onNotice }: {
    supplierId: number;
    tags: string[];
    /** Preset tags plus the ones some supplier already has: offered so the same tag isn't written two ways. */
    known: string[];
    onNotice: (notice: string | null) => void;
}) {
    const [draft, setDraft] = useState('');
    const write = useWriteSupplier();
    const clean = draft.trim().replace(/\s+/g, ' ');
    const duplicate = tags.some(e => e.toLowerCase() === clean.toLowerCase());
    const full = tags.length >= MAX_TAGS;
    const save = (list: string[], notice: string) => write.mutate(
        { path: `/${supplierId}`, method: 'PATCH', body: { tags: list } },
        { onSuccess: () => { setDraft(''); onNotice(notice); } });
    const put = (e: string) => save([...tags, e], `Tag “${e}” added.`);
    const add = () => { if (clean !== '' && !duplicate && !full) put(clean); };
    const toOffer = known.filter(c => !tags.some(e => e.toLowerCase() === c.toLowerCase()));

    return <div className="sheet-section">
        <h3>Tags</h3>
        {tags.length === 0
            ? <p className="muted">No tags.</p>
            : <div className="tags">{tags.map(e => <DismissibleTag key={e} size="md" type={tagColor(e)} text={e} disabled={write.isPending}
                title="Remove" dismissTooltipLabel={`Remove ${e}`} onClose={() => save(tags.filter(x => x !== e), `Tag “${e}” removed.`)} />)}</div>}
        {!full && toOffer.length > 0 && <div className="offered-tags" role="group" aria-label="Tags to add">
            {toOffer.map(c => <button key={c} type="button" className="tag-chip tag-chip--small" disabled={write.isPending}
                onClick={() => put(c)}><Add size={16} aria-hidden="true" />{c}</button>)}
        </div>}
        {!full && <form className="sheet-add" onSubmit={ev => { ev.preventDefault(); add(); }}>
            <TextInput id={`supplier-tag-${supplierId}`} labelText="Or type a new one" size="md" maxLength={MAX_TAG_LENGTH} autoComplete="off"
                value={draft} onChange={e => setDraft(e.target.value)} invalid={duplicate} invalidText="It already has it" />
            <Button type="submit" kind="tertiary" size="md" disabled={clean === '' || duplicate || write.isPending}>Add</Button>
        </form>}
        {write.error && <p className="error-text" role="alert">Could not save the tag.</p>}
    </div>;
}
