import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { requestJson } from './api';
import { fetchJson } from './queries';

/** Material requests from the shop floor to the storeroom. */
export type RequestStatus = 'pending' | 'ready' | 'delivered' | 'cancelled';

export type MaterialRequest = {
    id: number;
    status: RequestStatus;
    note: string | null;
    created_at: string;
    changed_at: string;
    requester: { id: number; name: string };
    handled_by: string | null;
    items: { product_id: number; code: string; name: string; location: string | null; unit: string; quantity: string }[];
};

export type RequestsResponse = { requests: MaterialRequest[]; open: number };

export const STATUS_LABEL: Record<RequestStatus, string> = {
    pending: 'Pending', ready: 'Ready for pickup', delivered: 'Delivered', cancelled: 'Cancelled',
};

export const isOpen = (r: MaterialRequest) => r.status === 'pending' || r.status === 'ready';

/** `handled_by` is only filled when someone else closes it: a cancelled one like that is a request the storeroom didn't deliver. */
export const statusLabel = (r: MaterialRequest) => r.status === 'cancelled' && r.handled_by ? 'Not delivered' : STATUS_LABEL[r.status];

/** How often to ask for new requests: the worst-case delay before the storeroom finds out. */
const POLL_MS = 8_000;

/** The requests, watched. With `active` false nothing is fetched. While the tab is visible it re-asks every few seconds. */
export function useRequests(active = true) {
    return useQuery({
        queryKey: ['requests'],
        queryFn: fetchJson<RequestsResponse>('/api/requests'),
        enabled: active,
        refetchInterval: POLL_MS,
        staleTime: 0,
    });
}

export function useSendRequest() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (body: { items: { product_id: number; quantity: number }[]; note?: string }) =>
            requestJson<{ id: number }>('/api/requests', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            }),
        onSuccess: () => client.invalidateQueries({ queryKey: ['requests'] }),
    });
}

export function useChangeRequest() {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ id, status }: { id: number; status: RequestStatus }) =>
            requestJson<{ id: number }>(`/api/requests/${id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
            }),
        // Also on failure (409: someone else changed it): refresh the list instead of leaving it stale.
        onSettled: () => client.invalidateQueries({ queryKey: ['requests'] }),
    });
}

/** "3 min ago", "2 h ago", or the date if it's from another day. */
export function timeAgo(iso: string, now = Date.now()): string {
    const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    if (min < 24 * 60) return `${Math.floor(min / 60)} h ago`;
    return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
}

function beep() {
    try {
        const Audio = window.AudioContext;
        const ctx = new Audio();
        const tone = (frequency: number, from: number) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.frequency.value = frequency; o.connect(g); g.connect(ctx.destination);
            g.gain.setValueAtTime(0.0001, ctx.currentTime + from);
            g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + from + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + from + 0.28);
            o.start(ctx.currentTime + from); o.stop(ctx.currentTime + from + 0.3);
        };
        tone(880, 0); tone(1174, 0.18);
        setTimeout(() => void ctx.close(), 800);
    } catch { /* no audio, or the browser blocks it until a tap: the rest of the alert still works */ }
}

/**
 * In-page alert when a new request arrives: two tones, vibration and the count in the tab title.
 * Only when the count goes UP, not on load or when it drops. With the page closed, push.ts takes over.
 */
export function useRequestAlert(open: number | undefined) {
    const previous = useRef<number | null>(null);
    useEffect(() => {
        if (open === undefined) return;
        if (previous.current !== null && open > previous.current) {
            beep();
            try { navigator.vibrate?.([200, 100, 200]); } catch { /* not all browsers allow it */ }
        }
        previous.current = open;
    }, [open]);

    useEffect(() => {
        const base = document.title.replace(/^\(\d+\) /, '');
        document.title = open ? `(${open}) ${base}` : base;
        return () => { document.title = base; };
    }, [open]);
}
