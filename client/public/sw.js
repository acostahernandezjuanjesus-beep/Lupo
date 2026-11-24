// Only job: receive Web Push messages and show them. No caching, no fetch interception.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
    let notice = {};
    try { notice = e.data ? e.data.json() : {}; } catch { /* unreadable body still gets shown */ }
    e.waitUntil((async () => {
        // If the app is on screen it already beeps and vibrates by itself.
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (windows.some(w => w.visibilityState === 'visible')) return;
        await self.registration.showNotification(notice.title || 'Lupo', {
            body: notice.body || '',
            tag: notice.tag || 'lupo',
            icon: '/favicon.svg',
            vibrate: [200, 100, 200],
            requireInteraction: true,
            data: { url: notice.url || '/' },
        });
    })());
});

self.addEventListener('notificationclick', e => {
    e.notification.close();
    const target = new URL(e.notification.data?.url || '/', self.location.origin).href;
    e.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const open = windows.find(w => new URL(w.url).origin === self.location.origin);
        if (open) { await open.focus(); if ('navigate' in open) await open.navigate(target).catch(() => {}); return; }
        await self.clients.openWindow(target);
    })());
});
