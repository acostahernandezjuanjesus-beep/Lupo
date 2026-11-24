import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Product } from '../../types';
import { ApiError, requestJson } from '../../api';
import { formatQuantity } from '../../level';

type Draft = { id: number; value: string };

export function useCount() {
    const queryClient = useQueryClient();
    const [draft, setDraft] = useState<Draft | null>(null);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState<{ id: number; text: string } | null>(null);

    const change = useCallback((p: Product, value: string) => {
        setDraft({ id: p.id, value }); setError(null); setSaved(null);
    }, []);
    const cancel = useCallback(() => { setDraft(null); setError(null); }, []);

    async function save(p: Product) {
        if (draft?.id !== p.id || sending) return;
        setSending(true); setError(null);
        try {
            const r = await requestJson<{ new_balance: number; unchanged?: boolean }>('/api/movements', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ product_id: p.id, type: 'adjustment', count: Number(draft.value) }),
            });
            setDraft(null);
            setSaved({ id: p.id, text: r.unchanged ? 'The count matches the balance.' : `Count saved: ${formatQuantity(r.new_balance)} ${p.unit}` });
            for (const key of ['products', 'movements', 'summary']) void queryClient.invalidateQueries({ queryKey: [key] });
        } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Could not connect to the API');
        } finally { setSending(false); }
    }
    return { draft, sending, error, saved, change, cancel, save };
}

export type Count = ReturnType<typeof useCount>;
