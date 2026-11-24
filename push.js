// Web Push: the storekeeper's phone hears about a new request even with the page closed.
// Behind a session and the storekeeper/admin role; only they receive notifications.
//   GET    /key             the server's public key (the browser needs it to subscribe)
//   POST   /subscriptions   registers this device: { endpoint, keys: { p256dh, auth } }
//   DELETE /subscriptions   removes it: { endpoint }
//
// The endpoint comes from a logged-in user and the server will request it, so only the browsers'
// push services are allowed (otherwise: SSRF). A notification never fails or delays what triggers it,
// and a subscription the service reports dead (404/410) is deleted.

const express = require('express');
const webpush = require('web-push');
const { fail, Rejection } = require('./util');

// Push services of Chrome/Edge/Opera (FCM), Firefox, Safari/iOS and Windows.
const SERVICES = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
const MAX_ENDPOINT = 2048;
const MAX_PER_USER = 10;       // more than that is a browser subscribing in a loop

/** Validates a subscription and returns what gets stored. Throws `Rejection`. */
function readSubscription(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const { endpoint } = b;
    const keys = b.keys && typeof b.keys === 'object' ? b.keys : {};
    if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) throw new Rejection('Invalid endpoint');
    let url;
    try { url = new URL(endpoint); } catch { throw new Rejection('Invalid endpoint'); }
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || !SERVICES.some(re => re.test(url.hostname))) {
        throw new Rejection('That notification service is not allowed');
    }
    const base64url = /^[A-Za-z0-9_-]{16,200}$/;
    if (typeof keys.p256dh !== 'string' || !base64url.test(keys.p256dh) || typeof keys.auth !== 'string' || !base64url.test(keys.auth)) {
        throw new Rejection('The subscription keys are missing');
    }
    return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/** The server's VAPID key pair: from the database, or generated on first use. */
async function vapidKeys(pool) {
    const read = () => pool.query('SELECT public_key, private_key FROM push_keys').then(r => r.rows[0]);
    const existing = await read();
    if (existing) return existing;
    const fresh = webpush.generateVAPIDKeys();
    // ON CONFLICT: two simultaneous requests end up using the same pair.
    await pool.query('INSERT INTO push_keys (public_key, private_key) VALUES ($1, $2) ON CONFLICT DO NOTHING', [fresh.publicKey, fresh.privateKey]);
    return read();
}

const CONTACT = () => process.env.LUPO_DOMAIN ? `https://${process.env.LUPO_DOMAIN}` : 'mailto:admin@example.com';

module.exports = function createPush(pool, { send = webpush.sendNotification } = {}) {
    const router = express.Router();

    router.get('/key', async (_req, res) => {
        try {
            res.json({ key: (await vapidKeys(pool)).public_key });
        } catch (err) {
            fail(_req, res, err, 'Could not read the notification key');
        }
    });

    router.post('/subscriptions', async (req, res) => {
        let s;
        try {
            s = readSubscription(req.body);
        } catch (e) {
            if (e instanceof Rejection) return res.status(e.status).json({ error: e.message });
            throw e;
        }
        const userAgent = String(req.get('user-agent') ?? '').slice(0, 200) || null;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(7300037, $1)', [req.user.id]);
            const { rows: [{ n }] } = await client.query(
                'SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1 AND endpoint <> $2', [req.user.id, s.endpoint]);
            if (n >= MAX_PER_USER) throw new Rejection(`You already have ${MAX_PER_USER} devices with notifications. Remove one first`, 409);
            // A browser already subscribed under someone else moves to whoever is logged in now.
            await client.query(
                `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent`,
                [req.user.id, s.endpoint, s.p256dh, s.auth, userAgent]);
            await client.query('COMMIT');
            res.status(201).json({ ok: true });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (err instanceof Rejection) return res.status(err.status).json({ error: err.message });
            fail(req, res, err, 'Could not turn on notifications');
        } finally {
            client.release();
        }
    });

    router.delete('/subscriptions', async (req, res) => {
        const endpoint = req.body?.endpoint;
        if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return res.status(400).json({ error: 'Invalid endpoint' });
        try {
            // own subscriptions only
            await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
            res.json({ ok: true });
        } catch (err) {
            fail(req, res, err, 'Could not remove the notification');
        }
    });

    /**
     * Notifies every storekeeper and admin device. Never throws; callers don't await it.
     * `except`: the user who triggered it (an admin's own request doesn't notify themselves).
     */
    async function notify(payload, { except = null } = {}) {
        try {
            const { rows } = await pool.query(
                `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s JOIN users u ON u.id = s.user_id
                  WHERE u.active AND u.role IN ('storekeeper', 'admin') AND s.user_id IS DISTINCT FROM $1`, [except]);
            if (rows.length === 0) return 0;
            const { public_key, private_key } = await vapidKeys(pool);
            const vapid = { subject: CONTACT(), publicKey: public_key, privateKey: private_key };
            const body = JSON.stringify(payload);
            let sent = 0;
            await Promise.all(rows.map(async s => {
                try {
                    await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { vapidDetails: vapid, TTL: 120, urgency: 'high', timeout: 8000 });
                    sent++;
                } catch (err) {
                    if (err?.statusCode === 404 || err?.statusCode === 410) {
                        await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
                    } else {
                        console.error('push notification not delivered:', err?.statusCode ?? err?.message);
                    }
                }
            }));
            return sent;
        } catch (err) {
            console.error('push notification failed:', err.message);
            return 0;
        }
    }

    return { router, notify };
};
module.exports.readSubscription = readSubscription;
