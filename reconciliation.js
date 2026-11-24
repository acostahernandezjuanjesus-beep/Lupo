// Invoice lines against stock. Mounted on the invoices router (behind session
// and the storekeeper/admin role). It suggests a product per line, records a
// stock-in for a line, and marks a line "no stock-in". Suggestions never link
// or record anything on their own.
//
// Deliberately not done: undoing a stock-in (fix it with an adjustment), and
// converting units (the invoice may say "6 METRO LINEAL" for a product kept in
// pieces; the person sees both and confirms the quantity).

const { prepareCandidates, suggest } = require('./suggestions');
const { toPositiveInt, fail } = require('./util');

// Same list as index.js: half a pair of gloves does not exist.
const WHOLE_UNITS = ['piece', 'box', 'pack', 'pair'];
const MAX_QUANTITY = 999_999_999;                       // numeric(12,3): 9 integer digits

const toInt = toPositiveInt;

/** A positive quantity with up to 3 decimals as exact text; null if it is not one. */
function isValidQuantity(v) {
    let t = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
    // Invoice lines come from numeric(18,6) ("5.000000"): padding zeros are not a fraction.
    if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
    if (!/^\d{1,9}(\.\d{1,3})?$/.test(t)) return null;
    return Number(t) > 0 && Number(t) <= MAX_QUANTITY ? t : null;
}

// Same-named columns of the line would be overwritten by the product's in the result, hence the aliases.
const PRODUCT = `p.id, p.code, p.name, p.unit AS product_unit, p.control_type, p.count_pending, p.quantity AS balance`;

/** What a description is compared against: already-linked forms (each pointing to its product) and catalog names. */
async function candidates(db) {
    const { rows } = await db.query(`
        SELECT eq.alias_norm AS text, 'link' AS via, pr.id, pr.code, pr.name
          FROM product_aliases eq JOIN products pr ON pr.id = eq.product_id
        UNION ALL
        SELECT pr.name, 'name', pr.id, pr.code, pr.name FROM products pr`);
    return prepareCandidates(rows);
}

/** Product card; the number is only a fact when there is no pending count (the client decides with `count_pending`). */
const productCard = p => p && ({
    id: p.id, code: p.code, name: p.name, unit: p.product_unit, control_type: p.control_type,
    count_pending: p.count_pending, quantity: Number(p.balance),
});

module.exports = function mountReconciliation(r, pool) {
    r.get('/:id/reconciliation', async (req, res) => {
        const id = toInt(req.params.id);
        if (id === null) return res.status(400).json({ error: 'id must be a positive integer' });
        try {
            const { rows: [f] } = await pool.query('SELECT id, purchase_type FROM invoices WHERE id = $1', [id]);
            if (!f) return res.status(404).json({ error: 'The invoice does not exist' });
            const { rows } = await pool.query(
                `SELECT l.sort_order, l.description, l.quantity::text AS quantity, l.unit, l.unit_value::text AS unit_value,
                        l.amount::text AS amount, l.identification_no, l.reconciliation, l.movement_id,
                        ${PRODUCT}
                   FROM invoice_lines l LEFT JOIN products p ON p.id = l.product_id
                  WHERE l.invoice_id = $1 ORDER BY l.sort_order`, [id]);
            const hasPending = rows.some(l => l.reconciliation === 'pending');
            const cand = hasPending ? await candidates(pool) : [];
            // The supplier's line number (NoIdentificacion) against linked supplier codes is an
            // EXACT match, not text similarity, so it beats any name-based suggestion.
            const keys = [...new Set(rows.filter(l => l.reconciliation === 'pending' && l.identification_no).map(l => l.identification_no.trim().toUpperCase()))];
            const byCode = new Map();
            if (keys.length > 0) {
                const { rows: codes } = await pool.query(
                    `SELECT upper(pc.code) AS code, p.id, p.code AS product_code, p.name
                       FROM product_codes pc JOIN products p ON p.id = pc.product_id
                      WHERE pc.type = 'supplier' AND upper(pc.code) = ANY($1)`, [keys]);
                for (const c of codes) byCode.set(c.code, { id: c.id, code: c.product_code, name: c.name });
            }
            const suggestionFor = l => {
                const exact = l.identification_no ? byCode.get(l.identification_no.trim().toUpperCase()) : null;
                return exact
                    ? { product: exact, reason: 'supplier_code', via: 'code', similarity: 1, has_numbers: false }
                    : suggest(l.description, cand);
            };
            const lines = rows.map(l => ({
                sort_order: l.sort_order, description: l.description, quantity: l.quantity, unit: l.unit,
                unit_value: l.unit_value, amount: l.amount, identification_no: l.identification_no,
                reconciliation: l.reconciliation, movement_id: l.movement_id,
                product: l.id ? productCard(l) : null,
                suggestion: l.reconciliation === 'pending' ? suggestionFor(l) : null,
            }));
            res.json({
                invoice: { id: f.id, purchase_type: f.purchase_type },
                summary: { total: lines.length, reconciled: lines.filter(l => l.reconciliation !== 'pending').length },
                lines,
            });
        } catch (err) {
            fail(req, res, err, 'Error loading the reconciliation');
        }
    });

    /** Validates the two route ids or answers 400. */
    const ids = (req, res) => {
        const id = toInt(req.params.id), order = toInt(req.params.order);
        if (id === null || order === null) { res.status(400).json({ error: 'id and line must be positive integers' }); return null; }
        return { id, order };
    };

    r.post('/:id/lines/:order/stock-in', async (req, res) => {
        const k = ids(req, res); if (!k) return;
        const b = req.body ?? {};
        const productId = toInt(b.product_id);
        if (productId === null) return res.status(400).json({ error: 'product_id must be a positive integer' });
        if (b.learn !== undefined && typeof b.learn !== 'boolean') return res.status(400).json({ error: 'learn must be true or false' });

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const { rows: [l] } = await client.query(
                `SELECT l.*, f.purchase_type, f.series, f.folio, f.issuer_name, f.supplier_id
                   FROM invoice_lines l JOIN invoices f ON f.id = l.invoice_id
                  WHERE l.invoice_id = $1 AND l.sort_order = $2 FOR UPDATE OF l`, [k.id, k.order]);
            if (!l) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'The line does not exist' }); }
            if (l.reconciliation !== 'pending') {
                await client.query('ROLLBACK');
                return res.status(409).json({ error_code: 'already_reconciled', error: 'This line is already reconciled.' });
            }
            if (l.purchase_type === 'direct_to_job') {
                await client.query('ROLLBACK');
                return res.status(409).json({ error_code: 'direct_to_job',
                    error: 'This invoice is direct to job: the material does not enter the warehouse. Mark it "no stock-in", or fix the purchase type if that is wrong.' });
            }

            // The quantity the person confirmed (may differ from the invoice because of
            // units: boxes vs pieces) or the printed one.
            const quantity = isValidQuantity(b.quantity ?? l.quantity);
            if (quantity === null) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'quantity must be a number greater than 0 (up to 3 decimals)' });
            }

            const { rows: [p] } = await client.query(`SELECT ${PRODUCT} FROM products p WHERE p.id = $1 FOR UPDATE`, [productId]);
            if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'The product does not exist' }); }
            if (WHOLE_UNITS.includes(p.product_unit) && !Number.isInteger(Number(quantity))) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `fractions of "${p.product_unit}" cannot be recorded` });
            }

            // Copy the invoice unit price only when the quantity is the printed one: after a
            // unit conversion that price is no longer per this unit, and copying it would invent a cost.
            const sameQuantity = Number(quantity) === Number(l.quantity);
            const price = sameQuantity && l.unit_value !== null ? Number(l.unit_value).toFixed(2) : null;
            const folio = [l.series, l.folio].filter(Boolean).join('-').slice(0, 40) || null;
            const note = `Invoice ${folio ?? `#${k.id}`}${l.issuer_name ? ` from ${l.issuer_name}` : ''} · line ${k.order}: ${l.description}`.slice(0, 500);

            const newBalance = Number(p.balance) + Number(quantity);
            // The author comes from the session, never from the body.
            const { rows: [mov] } = await client.query(
                `INSERT INTO movements (product_id, type, quantity, user_id, supplier_id, unit_price, folio, note)
                 VALUES ($1, 'in', $2, $3, $4, $5, $6, $7)
                 RETURNING id, product_id, type, quantity, date`,
                [productId, quantity, req.user.id, l.supplier_id, price, folio, note]);
            await client.query('UPDATE products SET quantity = $1 WHERE id = $2', [newBalance, productId]);
            await client.query(
                `UPDATE invoice_lines SET reconciliation = 'stock_in', product_id = $3, movement_id = $4,
                        reconciled_at = now(), reconciled_by = $5
                  WHERE invoice_id = $1 AND sort_order = $2`, [k.id, k.order, productId, mov.id, req.user.id]);

            // Remember the description so the next invoice with that wording arrives suggested.
            let learned = false;
            if (b.learn === true) {
                const { rowCount } = await client.query(
                    `INSERT INTO product_aliases (product_id, alias, origin, created_by)
                     VALUES ($1, $2, 'manual', $3) ON CONFLICT (alias_norm) DO NOTHING`,
                    [productId, l.description, req.user.id]);
                learned = rowCount > 0;
            }
            await client.query('COMMIT');
            res.status(201).json({
                movement: mov, learned,
                // With a pending count the starting balance was a zero nobody measured, and a
                // no_balance product keeps no stock number: announce none in both cases.
                new_balance: p.count_pending || p.control_type === 'no_balance' ? null : newBalance,
                count_pending: p.count_pending,
            });
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch { /* connection already dead */ }
            if (err.code === '23503') return res.status(404).json({ error: 'The product or supplier no longer exists' });
            fail(req, res, err, 'Error recording the stock-in');
        } finally {
            client.release();
        }
    });

    r.post('/:id/lines/:order/no-stock-in', async (req, res) => {
        const k = ids(req, res); if (!k) return;
        const b = req.body ?? {};
        let productId = null;
        if (b.product_id !== undefined && b.product_id !== null) {
            productId = toInt(b.product_id);
            if (productId === null) return res.status(400).json({ error: 'product_id must be a positive integer' });
        }
        try {
            const { rowCount } = await pool.query(
                `UPDATE invoice_lines SET reconciliation = 'no_stock_in', product_id = $3, reconciled_at = now(), reconciled_by = $4
                  WHERE invoice_id = $1 AND sort_order = $2 AND reconciliation = 'pending'`,
                [k.id, k.order, productId, req.user.id]);
            if (rowCount === 0) return await notPending(pool, k, res);
            res.json({ reconciliation: 'no_stock_in' });
        } catch (err) {
            if (err.code === '23503') return res.status(404).json({ error: 'The product does not exist' });
            fail(req, res, err, 'Error marking the line');
        }
    });

    r.post('/:id/lines/:order/undo', async (req, res) => {
        const k = ids(req, res); if (!k) return;
        try {
            // Only "no stock-in": a stock-in already moved the balance and is not undone here.
            const { rowCount } = await pool.query(
                `UPDATE invoice_lines SET reconciliation = 'pending', product_id = NULL, reconciled_at = NULL, reconciled_by = NULL
                  WHERE invoice_id = $1 AND sort_order = $2 AND reconciliation = 'no_stock_in'`, [k.id, k.order]);
            if (rowCount === 0) {
                const { rows: [l] } = await pool.query('SELECT reconciliation FROM invoice_lines WHERE invoice_id = $1 AND sort_order = $2', [k.id, k.order]);
                if (!l) return res.status(404).json({ error: 'The line does not exist' });
                return res.status(409).json(l.reconciliation === 'stock_in'
                    ? { error_code: 'stock_in_recorded', error: 'That line generated a stock-in and already moved the balance. Fix a mistake with an adjustment, not from here.' }
                    : { error_code: 'already_pending', error: 'That line is already pending.' });
            }
            res.json({ reconciliation: 'pending' });
        } catch (err) {
            fail(req, res, err, 'Error returning the line to pending');
        }
    });
};

async function notPending(pool, k, res) {
    const { rows: [l] } = await pool.query('SELECT reconciliation FROM invoice_lines WHERE invoice_id = $1 AND sort_order = $2', [k.id, k.order]);
    if (!l) return res.status(404).json({ error: 'The line does not exist' });
    return res.status(409).json({ error_code: 'already_reconciled', error: 'This line is already reconciled.' });
}

module.exports.isValidQuantity = isValidQuantity;
