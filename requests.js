// Material requests from the shop floor to the storekeeper. Behind a session, any role except technician
// (auth.js already denies it). No prices.
//   GET    /          open ones (pending, ready) plus anything closed in the last day. Operators see their own,
//                     storekeeper and admin see all. `open` counts the pending ones.
//   POST   /          a new request: items [{ product_id, quantity }] and an optional note
//   PATCH  /:id       changes status: { status }
//
// A request does NOT move stock: the stock-out is a movement. Otherwise a cancelled or half-filled
// request would corrupt the balance. `requester_id` comes from the session, never the body.

const express = require('express');
const { toPositiveInt, toNumber, fail, Rejection } = require('./util');

const MAX_ITEMS = 20;
const MAX_OPEN = 10;       // per user, so a phone resending in a loop can't flood the queue
const MAX_QUANTITY = 100000;
const MAX_NOTE = 300;

/** Allowed status changes and the statuses they may start from, by who asks. */
const FROM = {
    storekeeper: { ready: ['pending'], delivered: ['pending', 'ready'], cancelled: ['pending', 'ready'] },
    own: { cancelled: ['pending', 'ready'] },
};

/** Validates the body of a request. Throws `Rejection`. */
function readRequest(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (!Array.isArray(b.items) || b.items.length === 0) throw new Rejection('Request at least one product');
    if (b.items.length > MAX_ITEMS) throw new Rejection(`A request holds up to ${MAX_ITEMS} products`);
    const seen = new Set();
    const items = b.items.map(r => {
        const product_id = toPositiveInt(r?.product_id);
        if (product_id === null) throw new Rejection('Every item needs a product');
        if (seen.has(product_id)) throw new Rejection('A product can appear only once: add to its quantity instead');
        seen.add(product_id);
        const quantity = toNumber(r.quantity);
        if (quantity === null || quantity <= 0 || quantity > MAX_QUANTITY) throw new Rejection('Quantity must be greater than zero');
        if (Math.round(quantity * 1000) / 1000 !== quantity) throw new Rejection('Quantity allows up to three decimals');
        return { product_id, quantity };
    });
    let note = null;
    if (b.note !== undefined && b.note !== null) {
        if (typeof b.note !== 'string') throw new Rejection('The note must be text');
        note = b.note.trim() || null;
        if (note && note.length > MAX_NOTE) throw new Rejection(`The note can't be longer than ${MAX_NOTE} characters`);
    }
    return { items, note };
}

const LIST = `
    SELECT s.id, s.status, s.note, s.created_at, s.changed_at,
           json_build_object('id', u.id, 'name', u.name) AS requester,
           a.name AS handled_by,
           (SELECT json_agg(json_build_object('product_id', p.id, 'code', p.code, 'name', p.name,
                                              'location', p.location, 'unit', p.unit, 'quantity', r.quantity::text)
                            ORDER BY r.id)
              FROM request_items r JOIN products p ON p.id = r.product_id WHERE r.request_id = s.id) AS items
      FROM material_requests s
      JOIN users u ON u.id = s.requester_id
      LEFT JOIN users a ON a.id = s.handled_by
     WHERE ($1::int IS NULL OR s.requester_id = $1)
       AND (s.status IN ('pending', 'ready') OR s.changed_at > now() - interval '1 day')
     ORDER BY (s.status IN ('pending', 'ready')) DESC, s.created_at DESC
     LIMIT 100`;

// `notify` pushes to the storekeeper's phone (push.js). Optional: without it the request is saved anyway.
module.exports = function createRequestsRoutes(pool, { notify = null } = {}) {
    const router = express.Router();
    const seesAll = u => u.role === 'storekeeper' || u.role === 'admin';

    router.get('/', async (req, res) => {
        try {
            const { rows } = await pool.query(LIST, [seesAll(req.user) ? null : req.user.id]);
            res.json({ requests: rows, open: rows.filter(s => s.status === 'pending').length });
        } catch (err) {
            fail(req, res, err, 'Could not read the requests');
        }
    });

    router.post('/', async (req, res) => {
        let request;
        try {
            request = readRequest(req.body);
        } catch (e) {
            if (e instanceof Rejection) return res.status(e.status).json({ error: e.message });
            throw e;
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // per-user lock: two quick taps would both pass the open-count check
            await client.query('SELECT pg_advisory_xact_lock(7300036, $1)', [req.user.id]);
            const { rows: [{ open }] } = await client.query(
                `SELECT count(*)::int AS open FROM material_requests WHERE requester_id = $1 AND status IN ('pending', 'ready')`,
                [req.user.id]);
            if (open >= MAX_OPEN) throw new Rejection(`You already have ${MAX_OPEN} open requests. Wait for the storekeeper to fill them or cancel one`, 409);
            const ids = request.items.map(r => r.product_id);
            const { rows: existing } = await client.query('SELECT id FROM products WHERE id = ANY($1::int[])', [ids]);
            if (existing.length !== ids.length) throw new Rejection('One of the products no longer exists', 404);
            const { rows: [{ id }] } = await client.query(
                'INSERT INTO material_requests (requester_id, note) VALUES ($1, $2) RETURNING id', [req.user.id, request.note]);
            await client.query(
                `INSERT INTO request_items (request_id, product_id, quantity)
                 SELECT $1, * FROM unnest($2::int[], $3::numeric[])`,
                [id, ids, request.items.map(r => r.quantity)]);
            await client.query('COMMIT');
            res.status(201).json({ id });
            // after responding, not awaited: a failed notification must not undo or delay the request
            const n = request.items.length;
            void notify?.({ title: 'New request at the storeroom', body: `${req.user.name}: ${n} ${n === 1 ? 'product' : 'products'}`, url: '/requests', tag: `request-${id}` },
                { except: req.user.id });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            if (err instanceof Rejection) return res.status(err.status).json({ error: err.message });
            fail(req, res, err, 'Could not send the request');
        } finally {
            client.release();
        }
    });

    router.patch('/:id', async (req, res) => {
        const id = toPositiveInt(req.params.id);
        if (id === null) return res.status(400).json({ error: 'Invalid id' });
        const status = typeof req.body?.status === 'string' ? req.body.status : '';
        try {
            const { rows: [s] } = await pool.query('SELECT requester_id, status FROM material_requests WHERE id = $1', [id]);
            // operators can't tell "doesn't exist" from "someone else's"
            if (!s || (!seesAll(req.user) && s.requester_id !== req.user.id)) return res.status(404).json({ error: 'That request does not exist' });
            const rules = seesAll(req.user) ? FROM.storekeeper : FROM.own;
            if (!Object.hasOwn(rules, status)) return res.status(403).json({ error: 'You are not allowed to make that change' });
            // the condition is in the UPDATE: someone else may have changed it since the read
            const handler = seesAll(req.user) && s.requester_id !== req.user.id ? req.user.id : null;
            const { rowCount } = await pool.query(
                `UPDATE material_requests SET status = $2, handled_by = $3, changed_at = now() WHERE id = $1 AND status = ANY($4::text[])`,
                [id, status, handler, rules[status]]);
            if (rowCount === 0) return res.status(409).json({ error: 'The request changed status in the meantime: reload the list' });
            res.json({ id, status });
        } catch (err) {
            fail(req, res, err, 'Could not change the request');
        }
    });

    return router;
};
module.exports.readRequest = readRequest;
