import { useCallback, useEffect, useState } from 'react';
import { requestJson } from './api';

/** Phone alerts (Web Push): the server sends them and the browser shows them even with the page closed. */
export type PushState =
    | 'loading'
    | 'unsupported'      // the browser doesn't do notifications (or the page isn't HTTPS)
    | 'install'          // iPhone/iPad: only works from an app added to the home screen
    | 'blocked'          // the person said no: only changeable in browser settings
    | 'inactive'
    | 'active';

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** The public key comes as base64url; `subscribe` wants bytes. */
function toBytes(base64url: string): Uint8Array<ArrayBuffer> {
    const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
    const raw = atob((base64url + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}

const sendSubscription = (subscription: PushSubscription) => requestJson('/api/push/subscriptions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription.toJSON()),
});

async function currentSubscription(): Promise<PushSubscription | null> {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return registration ? registration.pushManager.getSubscription() : null;
}

export function usePhoneAlerts() {
    const [state, setState] = useState<PushState>('loading');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let current = true;
        (async () => {
            if (!isSupported()) return current && setState(isIos() ? 'install' : 'unsupported');
            if (Notification.permission === 'denied') return current && setState('blocked');
            const existing = Notification.permission === 'granted' ? await currentSubscription() : null;
            // If someone else signed in on this browser, the subscription moves to whoever has the session now.
            if (existing) await sendSubscription(existing).catch(() => { /* retried next time */ });
            if (current) setState(existing ? 'active' : 'inactive');
        })().catch(() => current && setState('inactive'));
        return () => { current = false; };
    }, []);

    const enable = useCallback(async () => {
        setError(null);
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') return setState(permission === 'denied' ? 'blocked' : 'inactive');
            const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
            await navigator.serviceWorker.ready;
            const { key } = await requestJson<{ key: string }>('/api/push/key');
            const subscription = (await registration.pushManager.getSubscription())
                ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toBytes(key) });
            await sendSubscription(subscription);
            setState('active');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not turn alerts on');
        }
    }, []);

    const disable = useCallback(async () => {
        setError(null);
        try {
            const existing = await currentSubscription();
            if (existing) {
                await requestJson('/api/push/subscriptions', {
                    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: existing.endpoint }),
                }).catch(() => { /* even if the server doesn't answer, this device stops receiving them */ });
                await existing.unsubscribe();
            }
            setState('inactive');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not turn alerts off');
        }
    }, []);

    return { state, error, enable, disable };
}
