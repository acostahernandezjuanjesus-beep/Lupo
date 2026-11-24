import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineLoading, InlineNotification, Modal, Tag } from '@carbon/react';
import { requestJson } from '../../api';
import { fetchJson, errorMessage } from '../../queries';
import { money } from '../../money';
import { plural } from '../../purchases/suppliers';
import type { BookImport, UndoResult } from '../../purchases/import';

// Recent book imports; admins can undo one, which deletes the lines and links it brought. Imports
// older than this feature can't be told apart from other lines, so the reason is shown instead of
// a button that couldn't deliver.

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export function ImportHistory({ isAdmin }: { isAdmin: boolean }) {
    const queryClient = useQueryClient();
    const history = useQuery({ queryKey: ['purchases', 'imports'], queryFn: fetchJson<BookImport[]>('/api/purchases/import/history') });
    const [chosen, setChosen] = useState<BookImport | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    const undo = useMutation({
        mutationFn: (id: number) => requestJson<UndoResult>(`/api/purchases/import/${id}/undo`, { method: 'POST' }),
        onSuccess: async (r, id) => {
            const file = history.data?.find(i => i.id === id)?.file ?? 'the book';
            setNotice(`Undid the import of "${file}": ${plural(r.lines, 'line', 'lines')} (${money(r.amount)})${r.links > 0 ? ` and ${plural(r.links, 'link', 'links')} to the catalog` : ''}.${r.book_deleted ? ' The book was left with no lines, so it was removed too.' : ''}`);
            setChosen(null);
            // Changes the dashboard, the reader, Bring to catalog and each product's last price.
            await Promise.all(['purchases', 'products'].map(k => queryClient.invalidateQueries({ queryKey: [k] })));
        },
    });

    if (history.isPending) return <InlineLoading description="Loading the imports…" />;
    if (history.error) return <InlineNotification kind="error" hideCloseButton title="Could not load the imports" subtitle={errorMessage(history.error)} />;
    const imports = history.data;

    return <section className="stack" aria-labelledby="imports-title">
        <h3 id="imports-title" className="text-base">Recent imports</h3>
        {notice && <InlineNotification kind="success" title="Done" subtitle={notice} onCloseButtonClick={() => setNotice(null)} />}
        {imports.length === 0
            ? <p className="muted">No book has been imported from this screen yet.</p>
            : <ul>{imports.map(i => <li key={i.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border py-3 text-sm">
                <div className="min-w-0 flex-1">
                    <p className="break-words font-semibold">{i.file} {i.undone_at && <Tag type="gray" size="sm">Undone</Tag>}</p>
                    <p className="muted">
                        {when(i.done_at)}{i.user_name ? ` · ${i.user_name}` : ''} · {plural(i.new_count, 'line', 'lines')}{i.amount ? ` (${money(i.amount)})` : ''}
                        {i.links_created > 0 && ` · ${plural(i.links_created, 'link', 'links')}`}
                    </p>
                    {i.undone_at && <p className="muted">Undone on {when(i.undone_at)}{i.undone_by ? ` by ${i.undone_by}` : ''}.</p>}
                    {isAdmin && !i.undone_at && i.undo_blocked_reason && <p className="muted">Can't be undone: {i.undo_blocked_reason}</p>}
                </div>
                {isAdmin && !i.undone_at && !i.undo_blocked_reason
                    && <Button kind="danger--tertiary" size="sm" onClick={() => { undo.reset(); setChosen(i); }}>Undo</Button>}
            </li>)}</ul>}

        {chosen && <Modal open size="sm" danger preventCloseOnClickOutside
            modalLabel="Import book" modalHeading="Undo the import" closeButtonLabel="Close"
            primaryButtonText="Undo" secondaryButtonText="Cancel" primaryButtonDisabled={undo.isPending}
            loadingStatus={undo.isPending ? 'active' : 'inactive'} loadingDescription="Undoing…"
            onRequestClose={() => { if (!undo.isPending) setChosen(null); }}
            onRequestSubmit={() => undo.mutate(chosen.id)}>
            <div className="stack">
                <p>
                    Deletes {plural(chosen.lines, 'line', 'lines')} ({money(chosen.amount)}) from "{chosen.file}"
                    {chosen.links_created > 0 && <> and {plural(chosen.links_created, 'link', 'links')}</>}.
                </p>
                {undo.error && <InlineNotification kind="error" hideCloseButton title="Could not undo" subtitle={errorMessage(undo.error)} />}
            </div>
        </Modal>}
    </section>;
}
