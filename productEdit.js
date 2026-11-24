// Edits a product's details: name, category, location, brand, group, price and (admin only) code.
//   PATCH /api/products/:id      storekeeper and admin; the code only admin
//
// Not editable here: `quantity`/`count_pending` (stock only changes through a movement), `unit` (changing it
// would corrupt every quantity), and `control_type`/`minimum`/`target_level` (own routes). An unknown key is
// rejected by name; a silent 200 that ignored `quantity` would look like the balance got fixed.
// The code identifies the product (shelf labels, purchase books), so changes go to `product_changes` with who did it.

const { toPositiveInt, toNumber, fail, safeRollback, Rejection } = require('./util');

// Column limits: anything longer would reach Postgres as a 22001 and come back as a 500.
const LENGTH = { code: 50, name: 200, location: 100, brand: 60, group_name: 40 };
const COLUMN = { code: 'code', name: 'name', category_id: 'category_id', location: 'location', brand: 'brand', group_name: 'group_name', price: 'price' };
const AUDIT_FIELD = { category_id: 'category' };

/** An optional text: empty or null removes the value. */
function optionalText(value, field) {
    if (value === null || value === '') return null;
    if (typeof value !== 'string') throw new Rejection(`${field} must be text`);
    const clean = value.trim();
    if (clean.length > LENGTH[field]) throw new Rejection(`${field} can't be longer than ${LENGTH[field]} characters`);
    return clean === '' ? null : clean;
}

/**
 * Validates the body. Returns only the keys that came, cleaned. Throws `Rejection`.
 * `isAdmin`: only an admin changes the code.
 */
function readChanges(body, { isAdmin }) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const keys = Object.keys(b);
    if (keys.length === 0) throw new Rejection('Send at least one field: name, category_id, location, brand, group_name, price or code');
    const unknown = keys.filter(k => !(k in COLUMN));
    if (unknown.length > 0) {
        throw new Rejection(`"${unknown[0]}" can't be changed here. Stock only changes with a movement, and unit, control and levels have their own screen`);
    }

    const out = {};
    if ('code' in b) {
        if (!isAdmin) throw new Rejection("Only an admin can change a product's code", 403);
        const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';
        if (code === '') throw new Rejection('The code cannot be empty');
        if (code.length > LENGTH.code) throw new Rejection(`code can't be longer than ${LENGTH.code} characters`);
        out.code = code;
    }
    if ('name' in b) {
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (name === '') throw new Rejection('The name cannot be empty');
        if (name.length > LENGTH.name) throw new Rejection(`name can't be longer than ${LENGTH.name} characters`);
        out.name = name;
    }
    if ('category_id' in b) {
        const id = toPositiveInt(b.category_id);
        // a category can be changed but not removed: every new product requires one
        if (id === null) throw new Rejection('category_id must be a category id (a product cannot be left without a category)');
        out.category_id = id;
    }
    for (const field of ['location', 'brand', 'group_name']) if (field in b) out[field] = optionalText(b[field], field);
    if ('price' in b) {
        if (b.price === null || b.price === '') out.price = null;
        else {
            // products.price is numeric(10,2); accepting more decimals would round silently
            const n = toNumber(b.price);
            if (n === null || n < 0) throw new Rejection('price must be a non-negative number');
            if (!/^\d{1,8}(\.\d{1,2})?$/.test(String(b.price).trim())) throw new Rejection('price allows up to 8 integer digits and 2 decimals');
            out.price = n.toFixed(2);
        }
    }
    return out;
}

const same = (field, before, after) => field === 'price'
    ? (before === null || after === null ? before === after : Number(before) === Number(after))
    : before === after;

/**
 * The route handler. `readProduct(queryable, id)` returns the product row in the same shape as the rest
 * of the catalog (the response replaces what the screen had).
 */
function editProduct(pool, readProduct) {
    return async (req, res) => {
        const client = await pool.connect();
        try {
            const id = toPositiveInt(req.params.id);
            if (id === null) throw new Rejection('id must be a positive integer');
            const changes = readChanges(req.body, { isAdmin: req.user.role === 'admin' });

            await client.query('BEGIN');
            const { rows: [current] } = await client.query(
                `SELECT p.id, p.code, p.name, p.category_id, c.name AS category, p.location, p.brand, p.group_name, p.price::text AS price
                   FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = $1 FOR UPDATE OF p`, [id]);
            if (!current) throw new Rejection('The product does not exist', 404);

            // only what really changes, so resending the same name doesn't pollute the log
            const different = Object.keys(changes).filter(k => !same(k, current[k], changes[k]));
            if (different.length === 0) {
                await client.query('ROLLBACK');
                return res.json({ unchanged: true, product: await readProduct(pool, id) });
            }

            const audit = [];
            for (const k of different) audit.push({ field: AUDIT_FIELD[k] ?? k, before: current[k] === null ? null : String(current[k]), after: changes[k] === null ? null : String(changes[k]) });

            if (changes.category_id !== undefined && different.includes('category_id')) {
                const { rows: [cat] } = await client.query('SELECT name FROM categories WHERE id = $1', [changes.category_id]);
                if (!cat) throw new Rejection('The chosen category does not exist');
                const row = audit.find(b => b.field === 'category');
                row.before = current.category;
                row.after = cat.name;
            }
            if (different.includes('code')) {
                // A product's code can't be another product's barcode/supplier code: scanning would find the wrong one.
                const { rows: [other] } = await client.query(
                    `SELECT p.code, p.name FROM product_codes pc JOIN products p ON p.id = pc.product_id
                      WHERE upper(pc.code) = $1 AND pc.product_id <> $2 LIMIT 1`, [changes.code, id]);
                if (other) throw new Rejection(`That code is already linked to "${other.name}" (${other.code})`, 409);
            }

            const sets = different.map((k, i) => `${COLUMN[k]} = $${i + 2}`);
            await client.query(`UPDATE products SET ${sets.join(', ')} WHERE id = $1`, [id, ...different.map(k => changes[k])]);
            for (const a of audit) {
                await client.query('INSERT INTO product_changes (product_id, user_id, field, before, after) VALUES ($1, $2, $3, $4, $5)',
                    [id, req.user.id, a.field, a.before, a.after]);
            }
            await client.query('COMMIT');
            res.json({ changed: audit.map(a => a.field), product: await readProduct(pool, id) });
        } catch (err) {
            await safeRollback(client);
            if (err instanceof Rejection) return res.status(err.status).json({ error: err.message });
            if (err.code === '23505') return res.status(409).json({ error: 'That code already exists' });
            if (err.code === '23503') return res.status(400).json({ error: 'The chosen category does not exist' });
            fail(req, res, err, 'Error saving the product');
        } finally {
            client.release();
        }
    };
}

module.exports = { editProduct, readChanges };
