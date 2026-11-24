import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, InlineNotification, Select, SelectItem, TextInput } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import type { Category } from '../types';
import { requestJson, ApiError } from '../api';

// A product's category, with a way to create one on the spot. Every create form needs a category and a
// fresh install has none, so this is the only way out of that loop. Shared by the three doors into the
// catalog (inventory create, new code from Scan, "bring to catalog" from Purchases).
type Props = {
    id: string;
    /** `null` while loading or if the query failed, so "no categories yet" is never claimed before we know. */
    categories: readonly Category[] | null;
    /** The chosen id, or '' for none. */
    value: string;
    /** The caller recomputes its code with `codeOnCategoryChange`. */
    onChange: (id: string) => void;
    disabled?: boolean;
    /** True while a name is typed but not created yet; the parent must not save in that state. */
    onPending?: (has: boolean) => void;
    /** If the list failed to load: the message and a way to ask again. */
    error?: string | null;
    onRetry?: () => void;
};

const normalize = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim();
// Case-insensitive, like the server.
const keyOf = (s: string) => normalize(s).toLowerCase();

export function CategoryField({ id, categories, value, onChange, disabled, onPending, error: listError, onRetry }: Props) {
    const queryClient = useQueryClient();
    const [creating, setCreating] = useState(false);
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const field = useRef<HTMLInputElement | null>(null);
    const form = useRef<HTMLDivElement | null>(null);

    // If this unmounts mid-typing, clear the "pending" flag or the parent's save button stays disabled.
    const reportPending = useRef(onPending);
    useEffect(() => { reportPending.current = onPending; });
    useEffect(() => () => reportPending.current?.(false), []);

    const clean = normalize(name);
    const empty = categories !== null && categories.length === 0;

    // The only place the subform state changes, so the parent hears about it right away.
    function set(creatingNow: boolean, nameNow: string) {
        setCreating(creatingNow);
        setName(nameNow);
        onPending?.(creatingNow && normalize(nameNow) !== '');
    }
    function close() {
        set(false, '');
        setError(null);
        // Otherwise the focus falls to the page body and keyboard users lose their place in the modal.
        document.getElementById(id)?.focus();
    }

    // On open: focus the field and scroll the form into view. Runs on the next frame because Carbon's
    // modal moves focus when the button that was just tapped disappears.
    useEffect(() => {
        if (!creating) return;
        const frame = requestAnimationFrame(() => {
            field.current?.focus({ preventScroll: true });
            form.current?.scrollIntoView({ block: 'nearest' });
        });
        return () => cancelAnimationFrame(frame);
    }, [creating]);

    async function create() {
        if (clean === '' || saving) return;
        setSaving(true);
        setError(null);
        try {
            const created = await requestJson<Category>('/api/categories', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: clean }),
            });
            // Add it to the shared list in order, then refetch to match the server.
            queryClient.setQueryData<Category[]>(['categories'],
                before => [...(before ?? []), created].sort((a, b) => a.name.localeCompare(b.name, 'en')));
            void queryClient.invalidateQueries({ queryKey: ['categories'] });
            set(false, '');
            onChange(String(created.id));
            document.getElementById(id)?.focus();
        } catch (e) {
            if (e instanceof ApiError && e.status === 409) {
                // It exists, probably created from another device, so our list is stale: refetch and
                // pick it if it's there.
                await queryClient.invalidateQueries({ queryKey: ['categories'] });
                const existing = queryClient.getQueryData<Category[]>(['categories'])
                    ?.find(c => keyOf(c.name) === keyOf(clean));
                if (existing) {
                    set(false, '');
                    onChange(String(existing.id));
                    document.getElementById(id)?.focus();
                    return;
                }
            }
            // "A category with that name already exists" says more than a generic connection error.
            setError(e instanceof ApiError ? e.message : 'Could not connect to the API');
        } finally {
            setSaving(false);
        }
    }

    return <div className="stack">
        <Select id={id} labelText="Category" required value={value} disabled={disabled || categories === null}
            onChange={e => onChange(e.target.value)}>
            <SelectItem value="" disabled hidden
                text={categories === null ? 'Loading categories…' : empty ? 'No categories yet: create the first one' : 'Select a category'} />
            {(categories ?? []).map(c => <SelectItem key={c.id} value={String(c.id)} text={c.name} />)}
        </Select>
        {listError && <div className="stack">
            <InlineNotification kind="error" lowContrast hideCloseButton
                title="Could not load the categories" subtitle={listError} />
            {onRetry && <div><Button kind="tertiary" size="md" onClick={onRetry}>Retry</Button></div>}
        </div>}
        {/* Both blocks stay mounted and toggle with `hidden`. Unmounting the tapped button makes Carbon's
            modal think focus left and send it to the close button (its wrapFocus beats any focus() of
            ours). `hidden` goes on a plain wrapper so no CSS `display` overrides it. */}
        <div hidden={creating}>
            <Button kind="ghost" size="sm" renderIcon={Add} disabled={disabled || categories === null}
                onClick={() => set(true, '')}>Create new category</Button>
        </div>
        <div hidden={!creating}>
            <div className="stack" ref={form}>
                {/* Enter creates the category instead of submitting the product form around this field. */}
                <TextInput id={`${id}-new`} ref={field} labelText="New category name" value={name} maxLength={50}
                    disabled={saving} autoComplete="off"
                    helperText={clean !== '' ? 'Press "Create category" to use it.' : undefined}
                    onChange={e => set(true, e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} />
                <div className="row">
                    <Button size="sm" disabled={clean === '' || saving} onClick={() => { void create(); }}>
                        {saving ? 'Creating…' : 'Create category'}
                    </Button>
                    <Button kind="ghost" size="sm" disabled={saving} onClick={close}>Cancel</Button>
                </div>
            </div>
        </div>
        {error && <InlineNotification kind="error" lowContrast title="Could not create the category" subtitle={error}
            onCloseButtonClick={() => setError(null)} />}
    </div>;
}
