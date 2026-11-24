import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, InlineNotification } from '@carbon/react'
import { requestJson } from '../../api'
import { errorMessage } from '../../queries'

// Minimum is where ordering starts, target level is where it stops.
// Empty is not zero: an empty field clears the value back to "nobody defined it".
// The minimum moves the dashboard scale for everyone, so the server limits it to storekeeper/admin.

export type ProductLevels = { id: number; unit: string; minimum: number | null; target_level: number | null }

const text = (n: number | null) => n === null ? '' : String(n)

export function LevelEditor({ product, onSaved }: { product: ProductLevels; onSaved?: () => void }) {
    const qc = useQueryClient()
    const [minimum, setMinimum] = useState(text(product.minimum))
    const [target, setTarget] = useState(text(product.target_level))
    const [error, setError] = useState<string | null>(null)
    const [saved, setSaved] = useState(false)

    const save = useMutation({
        mutationFn: () => requestJson(`/api/products/${product.id}/levels`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            // Always both, so what's on screen is what gets saved.
            body: JSON.stringify({ minimum: minimum.trim() === '' ? null : minimum.trim(), target_level: target.trim() === '' ? null : target.trim() }),
        }),
        onSuccess: () => {
            setError(null); setSaved(true)
            void qc.invalidateQueries({ queryKey: ['requisition'] })
            void qc.invalidateQueries({ queryKey: ['products'] })
            void qc.invalidateQueries({ queryKey: ['summary'] })
            onSaved?.()
        },
        onError: e => { setError(errorMessage(e)); setSaved(false) },
    })

    const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => { set(e.target.value); setSaved(false) }
    const same = minimum === text(product.minimum) && target === text(product.target_level)

    return <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-3 text-sm">
            <label>Minimum<br />
                <input className="mt-1 h-10 w-32 border bg-layer px-2" inputMode="decimal" value={minimum} onChange={edit(setMinimum)} placeholder="not set" /></label>
            <label>Target level<br />
                <input className="mt-1 h-10 w-32 border bg-layer px-2" inputMode="decimal" value={target} onChange={edit(setTarget)} placeholder="not set" /></label>
            <span className="pb-2 text-text-2">{product.unit}</span>
            <Button size="sm" kind="tertiary" disabled={save.isPending || same} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save levels'}</Button>
            {saved && <span className="pb-2 text-sm">Saved.</span>}
        </div>
        {error && <InlineNotification kind="error" title="Could not save" subtitle={error} hideCloseButton />}
    </div>
}
