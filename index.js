const express = require('express');
const auth = require('./auth');
const { levelSql, LEVELS } = require('./stockLevels');
const { suggest, linkCandidates: candidatesFor } = require('./suggestions');
const { latestPurchases, priceChanges } = require('./recent');
const { editProduct } = require('./productEdit');
const { LoginLimiter } = require('./loginLimiter');
const { noNulls } = require('./noNulls');
const { headers, requestId, accessLog } = require('./security');
const { toNumber, toPositiveInt, escapeLike, safeRollback, fail } = require('./util');

// The pool and the identity module are injected so tests can exercise the HTTP contract without real sessions.
// `accessLog`: function that receives each per-request line (nothing is logged without it).
function createApp(pool, identity = auth, { accessLog: logLine = null } = {}) {
const app = express();
app.disable('x-powered-by');

// Behind ONE proxy, set LUPO_PROXY=1 or everyone shares the proxy's address (and its login quota).
// X-Forwarded-For is never trusted unless asked: otherwise anyone could fake a new address per attempt.
const proxyHops = Number(process.env.LUPO_PROXY ?? 0);
if (proxyHops > 0) app.set('trust proxy', proxyHops);
app.use(requestId, accessLog(logLine), headers);
// Two quotas: failures per address AND typed username, and a looser one per address alone.
// The second catches someone trying one password against many usernames.
const accountLimiter = new LoginLimiter();
const originLimiter = new LoginLimiter({ max: 60 });
/** Reserves both quotas or neither. -> { allowed: false, wait } or { allowed: true, release() } */
function reserveLogin(ip, key) {
    const origin = originLimiter.reserve(ip);
    if (!origin.allowed) return origin;
    const account = accountLimiter.reserve(`${ip}|${key}`);
    // Give the origin slot back, or hammering ONE username would use up everyone's.
    if (!account.allowed) { origin.release(); return account; }
    return { allowed: true, release: () => { account.release(); origin.release(); } };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 100 KB for everything except invoices and book imports: they carry whole XML/base64 files
// and their routers set their own limit AFTER the session and role checks.
const smallJson = express.json({ limit: '100kb' });
const OWN_BODY_LIMIT_PATHS = ['/api/invoices', '/api/purchases/import'];
app.use((req, res, next) => OWN_BODY_LIMIT_PATHS.some(p => req.path.startsWith(p)) ? next() : smallJson(req, res, next));
// A null byte in any body text is a 400, not a PostgreSQL 500.
app.use(noNulls);

const withSession = identity.requireSession(pool);
const withRole = (...roles) => identity.requireRole(...roles);

app.use('/api/admin', require('./admin')(pool));

const PAGE_SIZE = 50;

const ROLES_WITH_COST = ['storekeeper', 'admin'];
const canSeePrice = user => ROLES_WITH_COST.includes(user?.role);

// The price is OMITTED for roles that can't see it, not sent as null: null would mean "no price recorded".
// `last_purchase` follows the same rule. It comes from the purchase books, not the catalog:
// null = no linked purchase; key missing = you can't see it. "Latest" sorts by book period first, then date.
const LAST_PURCHASE = `
      LEFT JOIN LATERAL (
          SELECT json_build_object(
                     'price', pu.unit_price::text,
                     'date', to_char(pu.date, 'YYYY-MM-DD'),
                     'period', pb.period,
                     'supplier', COALESCE(sp.name, pu.supplier_text)) AS last_purchase
            FROM product_aliases pa
            JOIN purchases pu ON pu.description_norm = pa.alias_norm
                             AND pu.type = 'purchase' AND pu.unit_price IS NOT NULL
            JOIN purchase_books pb ON pb.id = pu.book_id
            LEFT JOIN suppliers sp ON sp.id = pu.supplier_id
           WHERE pa.product_id = p.id
           ORDER BY pb.period DESC, pu.date DESC NULLS LAST, pu.sheet_order DESC, pu.row_num DESC, pu.id DESC
           LIMIT 1) lp ON true`;

// One product row shape for every query; the client reads it with `toProduct()`.
const SELECT_PRODUCT = (withPrice = true) => `
    SELECT p.id, p.code, p.name, p.quantity, ${withPrice ? 'p.price, lp.last_purchase,' : ''} p.location, p.unit,
           p.minimum, p.target_level, p.restock_control, p.count_pending, p.control_type,
           p.brand, p.group_name,
           p.category_id, c.name AS category,
           COALESCE((SELECT json_agg(json_build_object('code', pc.code, 'description', pc.description) ORDER BY pc.id)
                       FROM product_codes pc WHERE pc.product_id = p.id AND pc.type = 'supplier'), '[]'::json) AS supplier_codes
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id${withPrice ? LAST_PURCHASE : ''}`;

// API helpers (the shared validation ones live in util.js)

function pageOf(req) {
    const n = toNumber(req.query.page);
    return n !== null && n >= 1 ? Math.floor(n) : 1;
}

function hasValue(v) {
    return v !== undefined && v !== null && v !== '';
}

// Products

const NO_LOCATION = 'no_location';
const CONTROL_FILTERS = ['stock', 'no_balance'];
// Sort keys map to SQL; the client only ever picks a key.
const SORT_ORDERS = {
    code: 'p.code, p.id',
    name: 'p.name, p.code, p.id',
    category: 'c.name NULLS LAST, p.code, p.id',
    location: 'p.location NULLS LAST, p.code, p.id',
};

const MAX_SEARCH_TERMS = 6;

/**
 * The `?q=` condition of the catalog, with its parameters pushed onto `values`.
 * Matches name, internal code or ANY linked code (barcode, box, supplier number or its description).
 * Either the WHOLE text as typed (also without spaces, since scanners paste barcodes unspaced),
 * or ALL the words in any order.
 */
function searchCondition(text, values) {
    const matches = (pattern, noSpaces = pattern) => {
        values.push(pattern);
        const n = values.length;
        values.push(noSpaces);
        const m = values.length;
        return `(p.name ILIKE $${n} ESCAPE '\\'`
            + ` OR p.code ILIKE $${n} ESCAPE '\\'`
            + ` OR p.id IN (SELECT pc.product_id FROM product_codes pc`
            + `             WHERE pc.code ILIKE $${n} ESCAPE '\\' OR replace(pc.code, ' ', '') ILIKE $${m} ESCAPE '\\'`
            + `                OR pc.description ILIKE $${n} ESCAPE '\\'))`;
    };
    const whole = matches(`%${escapeLike(text)}%`, `%${escapeLike(text.replace(/\s+/g, ''))}%`);
    const words = text.trim().split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
    if (words.length < 2) return whole;
    return `(${whole} OR (${words.map(w => matches(`%${escapeLike(w)}%`)).join(' AND ')}))`;
}

app.get('/api/products', withSession, async (req, res) => {
    const { q, category_id, level, location, control } = req.query;
    // A huge ?page used to reach PostgreSQL as an infinite OFFSET and come back as a 500.
    const pageRead = readPage(req);
    if (pageRead.error) return res.status(400).json({ error: pageRead.error });
    const page = pageRead.page;
    // Object.hasOwn: "constructor" or "__proto__" would inherit something and end up in the ORDER BY.
    const sortKey = req.query.sort ?? 'code';
    if (typeof sortKey !== 'string' || !Object.hasOwn(SORT_ORDERS, sortKey)) {
        return res.status(400).json({ error: 'invalid sort' });
    }
    const sort = SORT_ORDERS[sortKey];

    const conditions = [];
    const values = [];

    if (hasValue(q)) conditions.push(searchCondition(String(q), values));
    if (hasValue(category_id)) {
        const id = toPositiveInt(category_id);
        if (id === null) {
            return res.status(400).json({ error: 'category_id must be a positive integer' });
        }
        values.push(id);
        conditions.push(`p.category_id = $${values.length}`);
    }

    if (hasValue(level)) {
        if (level === 'gases') {
            // The category classifies gas; the code prefix doesn't.
            conditions.push("p.category_id IN (SELECT id FROM categories WHERE name = 'Industrial gases')");
        } else if (LEVELS.includes(level)) {
            values.push(level);
            conditions.push(`(${levelSql('p')}) = $${values.length}`);
        } else {
            return res.status(400).json({ error: 'invalid level' });
        }
    }
    if (hasValue(location)) {
        // A repeated param arrives as an array, and String() would silently search for a location that doesn't exist.
        if (typeof location !== 'string' || location.length > PRODUCT_MAX_LENGTH.location) {
            return res.status(400).json({ error: 'invalid location' });
        }
        if (location === NO_LOCATION) {
            conditions.push("(p.location IS NULL OR btrim(p.location) = '')");
        } else {
            values.push(location);
            conditions.push(`p.location = $${values.length}`);
        }
    }
    if (hasValue(control)) {
        if (!CONTROL_FILTERS.includes(control)) {
            return res.status(400).json({ error: 'invalid control' });
        }
        values.push(control);
        conditions.push(`p.control_type = $${values.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const totalQ = await pool.query(
            `SELECT COUNT(*) FROM products p ${where}`, values
        );
        const total = Number(totalQ.rows[0].count);

        const dataQ = await pool.query(
            `${SELECT_PRODUCT(canSeePrice(req.user))}
               ${where}
              ORDER BY ${sort}
              LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, PAGE_SIZE, (page - 1) * PAGE_SIZE]
        );

        res.json({
            products: dataQ.rows,
            total,
            page,
            pages: Math.ceil(total / PAGE_SIZE),
        });
    } catch (err) {
        fail(req, res, err, 'Error querying products');
    }
});

// Units that can't be fractional. Half a pair of gloves is a typo, not a quantity.
const WHOLE_UNITS = ['piece', 'box', 'pack', 'pair'];

// Column length limits; checked here so an oversized value is a clear 400 instead of a Postgres 22001 turned 500.
const PRODUCT_MAX_LENGTH = { code: 50, name: 200, location: 100, unit: 20 };

/** A non-negative quantity in `unit`, whole when the unit can't be fractional. Shared by new-product stock and minimums. */
function validateQuantity(value, unit, field, ifNegative) {
    const n = toNumber(value);
    if (n === null) return { error: `${field} must be a number` };
    if (n < 0) return { error: ifNegative };
    // Columns are numeric(12,3): beyond that Postgres rounds silently or fails with a 500.
    if (!/^\d{1,9}(\.\d{1,3})?$/.test(String(value).trim())) {
        return { error: `${field} allows up to 9 integer digits and 3 decimals` };
    }
    if (WHOLE_UNITS.includes(unit) && !Number.isInteger(n)) {
        return { error: `fractions of "${unit}" are not allowed` };
    }
    return { value: n };
}

/**
 * Validation for adding a product, shared by the three ways in: direct create, "bring to catalog"
 * from Purchases, and create from a scanned code. Quantity is not here: only direct create accepts it.
 */
function validateNewProduct(body) {
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const location = typeof body.location === 'string' && body.location.trim()
        ? body.location.trim()
        : null;
    const unit = typeof body.unit === 'string' && body.unit.trim()
        ? body.unit.trim().toLowerCase()
        : 'piece';

    if (!code || !name) {
        return { error: 'code and name are required' };
    }
    for (const [field, value] of Object.entries({ code, name, location, unit })) {
        if (value !== null && value.length > PRODUCT_MAX_LENGTH[field]) {
            return { error: `${field} cannot exceed ${PRODUCT_MAX_LENGTH[field]} characters` };
        }
    }

    let price = null;
    if (hasValue(body.price)) {
        price = toNumber(body.price);
        if (price === null || price < 0) {
            return { error: 'price must be a non-negative number' };
        }
        // products.price is numeric(10,2); purchase books carry thousandths, which would be rounded silently.
        if (!/^\d{1,8}(\.\d{1,2})?$/.test(String(body.price).trim())) {
            return { error: 'price allows up to 8 integer digits and 2 decimals (cents)' };
        }
    }

    let categoryId = null;
    if (hasValue(body.category_id)) {
        categoryId = toPositiveInt(body.category_id);
        if (categoryId === null) {
            return { error: 'category_id must be a positive integer' };
        }
    }

    return { product: { code, name, location, unit, price, categoryId } };
}

const NEW_CONTROL_TYPES = ['stock', 'no_balance'];

/**
 * What the UNCOUNTED creations ("bring to catalog", create from scanned code) need on top of
 * `validateNewProduct`: control type and minimum. There is deliberately no default control type.
 */
function validateNewControl(data, unit) {
    if (!NEW_CONTROL_TYPES.includes(data.control_type)) {
        return { error: 'control_type is required: stock or no_balance' };
    }
    let minimum = null;
    if (hasValue(data.minimum)) {
        // No balance to compare a minimum against.
        if (data.control_type === 'no_balance') {
            return { error: 'An item without stock tracking cannot have a minimum' };
        }
        const parsed = validateQuantity(data.minimum, unit, 'minimum', 'minimum cannot be negative');
        if (parsed.error) {
            return { error: parsed.error };
        }
        minimum = parsed.value;
    }
    return { control: { controlType: data.control_type, minimum } };
}

/**
 * INSERT for an uncounted product, inside the caller's transaction. Quantity 0 and count_pending true
 * are written in the SQL, not as parameters, so nothing in the body can change them.
 */
async function insertUncounted(client, newProduct, control) {
    const { code, name, location, unit, price, categoryId } = newProduct;
    const { rows: [product] } = await client.query(
        `INSERT INTO products (code, name, quantity, price, location, unit, category_id,
                               control_type, minimum, count_pending)
         VALUES ($1, $2, 0, $3, $4, $5, $6, $7, $8, true)
         RETURNING id, code, name, unit, category_id, control_type,
                   minimum::text AS minimum, count_pending`,
        [code, name, price, location, unit, categoryId, control.controlType, control.minimum]
    );
    return product;
}

// Creating a product changes the catalog for everyone: storekeeper or admin only.
app.post('/api/products', withSession, withRole('storekeeper', 'admin'), async (req, res) => {
    // Express 5 leaves req.body undefined without a JSON body.
    const body = req.body ?? {};
    const newProduct = validateNewProduct(body);
    if (newProduct.error) {
        return res.status(400).json({ error: newProduct.error });
    }
    const { code, name, location, unit, price, categoryId } = newProduct.product;
    const { quantity } = body;

    let quantityNum = 0;
    if (hasValue(quantity)) {
        const parsed = validateQuantity(quantity, unit, 'quantity', 'quantity cannot be negative');
        if (parsed.error) {
            return res.status(400).json({ error: parsed.error });
        }
        quantityNum = parsed.value;
    }

    try {
        const { rows } = await pool.query(
            `INSERT INTO products (code, name, quantity, price, location, unit, category_id, count_pending)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, code, name, quantity, price, location, unit, category_id`,
            [code, name, quantityNum, price, location, unit, categoryId, !hasValue(quantity)]
        );
        res.status(201).json(rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(409).json({ error: 'That code already exists' });
        }
        if (err.code === '23503') {
            return res.status(400).json({ error: 'The selected category does not exist' });
        }
        fail(req, res, err, 'Error creating product');
    }
});

// Barcodes: the internal code is ours, the printed one is the manufacturer's. These endpoints keep the two matched.

// Resolves a scanned code against both universes: the drawer label carries the internal code, the box the barcode.
app.get('/api/products/by-code', withSession, async (req, res) => {
    const code = hasValue(req.query.code) ? String(req.query.code).trim() : '';
    if (code === '') {
        return res.status(400).json({ error: 'code is required' });
    }

    try {
        const { rows } = await pool.query(
            `${SELECT_PRODUCT(canSeePrice(req.user))}
              WHERE p.id IN (SELECT product_id FROM product_codes WHERE upper(code) = upper($1))
                 OR upper(p.code) = upper($1)
              LIMIT 1`,
            [code]
        );

        if (rows.length === 0) {
            // The code comes back in the 404 so the screen can offer to link it.
            return res.status(404).json({
                error: 'No product has that code',
                error_code: 'unknown_code',
                code,
            });
        }
        res.json(rows[0]);
    } catch (err) {
        fail(req, res, err, 'Error resolving the code');
    }
});

app.get('/api/products/:id/codes', withSession, async (req, res) => {
    const productId = toPositiveInt(req.params.id);
    if (productId === null) {
        return res.status(400).json({ error: 'id must be a positive integer' });
    }
    try {
        const { rows } = await pool.query(
            `SELECT c.id, c.code, c.format, c.type, c.description, c.pieces::float8 AS pieces, c.created_at, u.name AS created_by
               FROM product_codes c
               LEFT JOIN users u ON u.id = c.created_by
              WHERE c.product_id = $1
              ORDER BY c.created_at`,
            [productId]
        );
        res.json(rows);
    } catch (err) {
        fail(req, res, err, 'Error querying codes');
    }
});

const CODE_TYPES = ['barcode', 'supplier'];

// No real barcode comes close to this; anything longer is a QR holding something else, or junk.
const MAX_BARCODE_LENGTH = 200;

/** Reads a scanned code to link. Linking to an existing product and creating a new one with its code must accept the same thing. */
function readBarcode(value, field) {
    const code = hasValue(value) ? String(value).trim() : '';
    if (code === '') return { error: `${field} is required` };
    if (code.length > MAX_BARCODE_LENGTH) {
        return { error: `${field} cannot exceed ${MAX_BARCODE_LENGTH} characters` };
    }
    return { code };
}

/** The format the scanner reports (ean_13, code_128...). Optional; the column is varchar(24). */
const readFormat = value => hasValue(value) ? String(value).slice(0, 24) : null;

/** Which product already owns a code, by either path `by-code` uses: a linked code or an internal code. */
async function codeOwner(connection, code) {
    const { rows } = await connection.query(
        `SELECT c.id, c.product_id, p.code AS product_code, p.name
           FROM product_codes c
           JOIN products p ON p.id = c.product_id
          WHERE c.code = $1
         UNION ALL
         SELECT NULL, p.id, p.code, p.name
           FROM products p
          WHERE upper(p.code) = upper($1)
          LIMIT 1`,
        [code]
    );
    return rows[0] ?? null;
}

/** The 409 for a code that already has an owner, naming it. */
function codeTaken(owner) {
    return {
        error: `That code is already linked to ${owner.product_code}`,
        error_code: 'code_taken',
        product: { id: owner.product_id, code: owner.product_code, name: owner.name },
    };
}

// Linking changes the catalog for everyone, and a wrong link sends the next scan to the wrong product.
app.post('/api/products/:id/codes', withSession, withRole('storekeeper', 'admin'), async (req, res) => {
    const productId = toPositiveInt(req.params.id);
    if (productId === null) {
        return res.status(400).json({ error: 'id must be a positive integer' });
    }
    const parsed = readBarcode((req.body ?? {}).code, 'code');
    if (parsed.error) {
        return res.status(400).json({ error: parsed.error });
    }
    const type = hasValue((req.body ?? {}).type) ? (req.body ?? {}).type : 'barcode';
    if (!CODE_TYPES.includes(type)) return res.status(400).json({ error: 'type must be barcode or supplier' });
    // Supplier numbers are stored UPPERCASE so the UNIQUE index sees "z-1" and "Z-1" as one.
    const code = type === 'supplier' ? parsed.code.toUpperCase() : parsed.code;
    const format = type === 'supplier' ? 'supplier' : readFormat((req.body ?? {}).format);
    let description = null;
    if (hasValue((req.body ?? {}).description)) {
        description = typeof req.body.description === 'string' ? req.body.description.trim() : null;
        if (description === null || description.length > 300) return res.status(400).json({ error: 'description must be text of up to 300 characters' });
        if (description === '') description = null;
    }

    try {
        // ON CONFLICT rather than check-then-insert: another scan fits between the two queries.
        const { rows } = await pool.query(
            `INSERT INTO product_codes (product_id, code, format, type, description, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (code) DO NOTHING
             RETURNING id, product_id, code, format, type, description, created_at`,
            [productId, code, format, type, description, req.user.id]
        );
        if (rows.length > 0) return res.status(201).json(rows[0]);

        // Linking the same code to the same product again is just a double scan, not an error.
        const { rows: owner } = await pool.query(
            `SELECT c.id, c.product_id, p.code AS product_code, p.name
               FROM product_codes c
               JOIN products p ON p.id = c.product_id
              WHERE c.code = $1`,
            [code]
        );
        if (owner.length === 0) {
            return res.status(500).json({ error: 'Error linking the code' });
        }
        if (owner[0].product_id === productId) {
            return res.json({ already_linked: true, id: owner[0].id, code });
        }
        return res.status(409).json(codeTaken(owner[0]));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(404).json({ error: 'The product does not exist' });
        }
        fail(req, res, err, 'Error linking the code');
    }
});

// Creates a product from an unknown scanned code and links the code, in one transaction.
// Uncounted, like the Purchases route: holding one doesn't say how many are on the shelf.
app.post('/api/products/with-code', withSession, withRole('storekeeper', 'admin'), async (req, res) => {
    const body = req.body ?? {};
    const parsed = readBarcode(body.barcode, 'barcode');
    if (parsed.error) {
        return res.status(400).json({ error: parsed.error });
    }
    const barcode = parsed.code;
    const format = readFormat(body.format);

    const data = body.product;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return res.status(400).json({ error: 'product is required' });
    }
    const newProduct = validateNewProduct(data);
    if (newProduct.error) {
        return res.status(400).json({ error: newProduct.error });
    }
    const control = validateNewControl(data, newProduct.product.unit);
    if (control.error) {
        return res.status(400).json({ error: control.error });
    }

    const client = await pool.connect();
    // A 23505 means different things on the product INSERT (internal code repeated) and the barcode INSERT.
    let step = 'check';
    try {
        await client.query('BEGIN');

        // Also checked against INTERNAL codes, or `by-code` would find two products for one scan.
        const owner = await codeOwner(client, barcode);
        if (owner) {
            await safeRollback(client);
            return res.status(409).json(codeTaken(owner));
        }

        step = 'product';
        const product = await insertUncounted(client, newProduct.product, control.control);

        step = 'code';
        const { rows: [linked] } = await client.query(
            `INSERT INTO product_codes (product_id, code, format, created_by)
             VALUES ($1, $2, $3, $4)
             RETURNING id, code, format`,
            [product.id, barcode, format, req.user.id]
        );

        await client.query('COMMIT');
        res.status(201).json({ product, code: linked });
    } catch (err) {
        await safeRollback(client);
        if (err.code === '23505' && step === 'product') {
            return res.status(409).json({ error: 'That code already exists', error_code: 'duplicate_code' });
        }
        if (err.code === '23503' && step === 'product') {
            return res.status(400).json({ error: 'The selected category does not exist' });
        }
        if (err.code === '22003' && step === 'product') {
            return res.status(400).json({ error: 'price or minimum out of range' });
        }
        if (err.code === '23505' && step === 'code') {
            // Someone linked it between the check and the INSERT; the creation is already rolled back.
            try {
                const winner = await codeOwner(client, barcode);
                if (winner) return res.status(409).json(codeTaken(winner));
            } catch (other) {
                console.error(other);
            }
            return res.status(409).json({
                error: 'That code was just linked to another product',
                error_code: 'code_taken',
            });
        }
        fail(req, res, err, 'Error creating the product');
    } finally {
        client.release();
    }
});

// A wrong link is worse than none: it sends scans to the wrong product and the error spreads to the balances.
app.delete('/api/products/:id/codes/:codeId', withSession, withRole('storekeeper', 'admin'), async (req, res) => {
    const productId = toPositiveInt(req.params.id);
    const codeId = toPositiveInt(req.params.codeId);
    if (productId === null || codeId === null) {
        return res.status(400).json({ error: 'id and codeId must be positive integers' });
    }
    try {
        // product_id in the WHERE so a badly built client route can't delete another product's code.
        const { rowCount } = await pool.query(
            'DELETE FROM product_codes WHERE id = $1 AND product_id = $2',
            [codeId, productId]
        );
        if (rowCount === 0) {
            return res.status(404).json({ error: 'That code is not linked to that product' });
        }
        res.status(204).end();
    } catch (err) {
        fail(req, res, err, 'Error unlinking the code');
    }
});

// Not public: a list of who exists would help anyone on the network pick a lockout target or password-guess.
// Logged-in users get id and name only (never the login), to choose who takes material.
app.get('/api/users', withSession, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name FROM users
              WHERE active AND password_hash IS NOT NULL AND role <> 'technician'   -- maintenance staff don't take material
              ORDER BY name`
        );
        res.json(rows);
    } catch (err) {
        fail(req, res, err, 'Error querying users');
    }
});

app.post('/api/session', async (req, res) => {
    const body = req.body ?? {};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const { password } = body;

    // Validate lengths before scrypt, and reject control characters (a null byte in the username used to 500).
    // Login doesn't enforce new-password length: existing 8-character passwords still work.
    if (!auth.isValidUsername(username) || !auth.loginPassword(password)) {
        return res.status(400).json({ error: 'Enter your username and password' });
    }

    // The limit is per ORIGIN (address + typed username), and the slot is RESERVED before verifying;
    // counting afterwards let simultaneous bursts through whole.
    const slot = reserveLogin(req.ip, username.toLowerCase());
    if (!slot.allowed) {
        res.set('Retry-After', String(slot.wait));
        return res.status(429).json({
            error: `Too many attempts from this device. Wait ${Math.ceil(slot.wait / 60)} min.`,
            error_code: 'too_many_attempts',
            wait_seconds: slot.wait,
        });
    }

    try {
        const r = await auth.openSession(pool, username, password);

        if (!r.ok && r.reason === 'temp_expired') {
            // Right password, expired temporary one: no session, but not a failed attempt either.
            slot.release();
            return res.status(403).json({
                error: 'Your temporary password has expired. Ask the administrator for a new one.',
                error_code: 'temp_password_expired',
            });
        }

        if (!r.ok) {
            // Failures are answered progressively slower per TYPED username, existing or not, so response
            // time can't reveal which usernames exist. The reserved slot stays taken.
            await sleep(auth.failDelay(accountLimiter.recordFailure(username.toLowerCase())));
            return res.status(401).json({
                error: 'Incorrect username or password',
                error_code: 'invalid_credentials',
            });
        }

        slot.release();                                 // success doesn't count against the origin
        accountLimiter.forget(username.toLowerCase());
        res.status(201).json({ token: r.token, user: r.user });
    } catch (err) {
        slot.release();                                 // our error isn't the caller's failure
        fail(req, res, err, 'Error signing in');
    }
});

// Changing your own password is one of the few things allowed while it is temporary (see requireSession in auth.js).
app.post('/api/session/password', withSession, async (req, res) => {
    const { current, new_password: newPassword } = req.body ?? {};
    if (!auth.loginPassword(current) || typeof newPassword !== 'string' || newPassword.includes('\u0000')) {
        return res.status(400).json({ error: 'Enter your current password and the new one' });
    }
    // A stolen session could guess the current password from here: same per-origin limit as signing in.
    const slot = reserveLogin(req.ip, `change:${req.user.id}`);
    if (!slot.allowed) {
        res.set('Retry-After', String(slot.wait));
        return res.status(429).json({ error: `Too many attempts. Wait ${Math.ceil(slot.wait / 60)} min.`, error_code: 'too_many_attempts', wait_seconds: slot.wait });
    }
    try {
        const r = await auth.changePassword(pool, req.user.id, auth.tokenOf(req), current, newPassword);
        if (!r.ok && r.reason === 'current') {
            await sleep(auth.failDelay(accountLimiter.recordFailure(`change:${req.user.id}`)));
            return res.status(401).json({ error: 'The current password is not correct', error_code: 'wrong_current_password' });
        }
        slot.release();                                 // right current password: not a failure
        if (!r.ok) {
            if (r.reason === 'same') return res.status(400).json({ error: 'The new password must be different from the current one' });
            return res.status(400).json({ error: r.detail });
        }
        accountLimiter.forget(`change:${req.user.id}`);
        res.status(204).end();
    } catch (err) {
        slot.release();
        fail(req, res, err, 'Error changing the password');
    }
});

app.get('/api/session', withSession, (req, res) => {
    res.json({ user: req.user });
});

app.delete('/api/session', withSession, async (req, res) => {
    try {
        await auth.closeSession(pool, auth.tokenOf(req));
        res.status(204).end();
    } catch (err) {
        fail(req, res, err, 'Error signing out');
    }
});

// Categories

// Home screen figures. An endpoint because /api/products paginates, so counting from the browser would give the page's number.
app.get('/api/summary', withSession, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT
              (SELECT count(*) FROM products)                                     AS products,
              (SELECT count(*) FROM products WHERE count_pending)                 AS uncounted,
              (SELECT count(*) FROM products WHERE minimum IS NOT NULL)           AS with_minimum,
              -- The ones that can really be compared against their minimum.
              (SELECT count(*) FROM products
                WHERE minimum IS NOT NULL AND NOT count_pending)                  AS with_minimum_counted,
              (SELECT count(*) FROM products
                WHERE (${levelSql()}) = 'below_min')                              AS below_min,
              (SELECT count(*) FROM products
                WHERE (${levelSql()}) = 'restock')                                AS restock,
              -- Same condition as the exemption in POST /api/movements: not uncounted products
              -- (their balance starts from a zero nobody measured), not no_balance ones either.
              (SELECT count(*) FROM products
                WHERE quantity < 0 AND NOT count_pending
                  AND control_type <> 'no_balance')                               AS negative_balance,
              (SELECT count(*) FROM movements WHERE origin = 'operational')       AS movements,
              (SELECT count(*) FROM movements
                WHERE origin = 'operational' AND date >= date_trunc('day', now())) AS movements_today,
              (SELECT count(*) FROM movements
                WHERE origin = 'operational' AND type = 'out'
                  AND date >= date_trunc('day', now()))                           AS outs_today,
              (SELECT count(*) FROM movements WHERE over_negative)                AS over_negative,
              (SELECT count(*) FROM users WHERE active)                           AS active_users,
              -- Only stock-tracked products: a no_balance one falls in no level, and counting it
              -- as "no minimum" would mix "not measured" with "minimum still to define".
              (SELECT count(*) FROM products WHERE control_type <> 'no_balance')  AS with_stock,
              (SELECT COALESCE(json_object_agg(level, n), '{}'::json)
                 FROM (SELECT (${levelSql()}) AS level, count(*)::int AS n
                         FROM products WHERE control_type <> 'no_balance'
                        GROUP BY 1) x)                                            AS levels
        `);
        // Postgres returns count() as a string. `levels` is already an object; fill in all five
        // levels so an empty one arrives as 0 instead of a missing key.
        const { levels, ...counts } = rows[0];
        const r = Object.fromEntries(
            Object.entries(counts).map(([k, v]) => [k, Number(v)])
        );
        r.levels = Object.fromEntries(LEVELS.map(n => [n, Number(levels?.[n] ?? 0)]));
        res.json(r);
    } catch (err) {
        fail(req, res, err, 'Error querying the summary');
    }
});

// Each category also carries its code PREFIX and a few example codes, so the new-product form can start the
// code with it. Derived from existing codes (the category's most used prefix), not a fixed list. Just a hint.
app.get('/api/categories', withSession, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            WITH prefixes AS (
                SELECT p.category_id, split_part(p.code, '-', 1) AS prefix, count(*) AS n
                  FROM products p WHERE p.category_id IS NOT NULL GROUP BY 1, 2
            ), best AS (
                SELECT DISTINCT ON (category_id) category_id, prefix
                  FROM prefixes ORDER BY category_id, n DESC, prefix
            )
            SELECT c.id, c.name, b.prefix,
                   COALESCE((SELECT json_agg(e.code) FROM (
                        SELECT p.code FROM products p
                         WHERE p.category_id = c.id AND split_part(p.code, '-', 1) = b.prefix
                         ORDER BY p.code LIMIT 3) e), '[]'::json) AS examples
              FROM categories c LEFT JOIN best b ON b.category_id = c.id
             ORDER BY c.name`);
        res.json(rows);
    } catch (err) {
        fail(req, res, err, 'Error querying categories');
    }
});

// Storekeeper and admin only. Categories can't be renamed or deleted: products use them, and renaming
// changes what others already entered.
const MAX_CATEGORY_LENGTH = 50; // categories.name is varchar(50)
// Control/format characters (zero-width space, soft hyphen, direction marks: what a PDF copy brings) and
// blank-looking "spaces" (braille blank, hangul filler). Without this an invisible or look-alike category
// would be created, and it could never be removed.
const INVISIBLE_NAME_CHARS = /[\p{Cc}\p{Cf}⠀ㅤﾠ]/gu;
const CATEGORY_LOCK_KEY = 'lupo.categories';

app.post('/api/categories', withSession, withRole('storekeeper', 'admin'), async (req, res) => {
    const body = req.body ?? {};
    // NFC so an accent typed as a separate mark equals the precomposed one; repeated/edge spaces don't count either.
    const name = typeof body.name === 'string'
        ? body.name.normalize('NFC').replace(INVISIBLE_NAME_CHARS, '').replace(/\s+/g, ' ').trim()
        : '';
    if (!name) return res.status(400).json({ error: 'name is required' });
    // [...name] counts characters, not UTF-16 units: PostgreSQL measures varchar(50) in characters.
    if ([...name].length > MAX_CATEGORY_LENGTH) {
        return res.status(400).json({ error: `name cannot exceed ${MAX_CATEGORY_LENGTH} characters` });
    }
    // "---" or "..." says nothing and can't be told apart from another one.
    if (!/[\p{L}\p{N}]/u.test(name)) {
        return res.status(400).json({ error: 'name must contain at least one letter or number' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Case-insensitive uniqueness. The UNIQUE index only sees exact text, and INSERT ... WHERE NOT EXISTS
        // isn't atomic across transactions ("Welding" and "WELDING" at once would both get in),
        // so an advisory lock serialises them.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CATEGORY_LOCK_KEY]);
        const { rows } = await client.query(
            `INSERT INTO categories (name)
             SELECT $1::varchar WHERE NOT EXISTS (SELECT 1 FROM categories WHERE lower(name) = lower($1))
             RETURNING id, name`, [name]);
        await client.query('COMMIT');
        if (rows.length === 0) return res.status(409).json({ error: 'A category with that name already exists' });
        // Same shape as GET /api/categories; a new category has no products, so no prefix or examples.
        res.status(201).json({ id: rows[0].id, name: rows[0].name, prefix: null, examples: [] });
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        // The UNIQUE index is still the safety net for the exact text.
        if (err.code === '23505') return res.status(409).json({ error: 'A category with that name already exists' });
        fail(req, res, err, 'Error creating the category');
    } finally {
        client.release();
    }
});

// Locations in use, with product counts, for the inventory filter. Products with no location are counted apart.
app.get('/api/locations', withSession, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT location, count(*)::int AS products
              FROM products
             WHERE location IS NOT NULL AND btrim(location) <> ''
             GROUP BY location
             ORDER BY location`);
        const { rows: [none] } = await pool.query(`
            SELECT count(*)::int AS products
              FROM products
             WHERE location IS NULL OR btrim(location) = ''`);
        res.json({ locations: rows, no_location: none.products });
    } catch (err) {
        fail(req, res, err, 'Error querying locations');
    }
});

// Purchases: the warehouse's purchase books
//
// Everything sits behind session AND role (operators don't see costs), and the role is checked BEFORE
// validating params so an operator can't even probe which filters exist. numerics go out as text so
// big amounts don't lose cents as JS Numbers.

const STOREKEEPER_ONLY = [withSession, withRole('storekeeper', 'admin')];

// Invoices (accounts payable).
app.use('/api/invoices', ...STOREKEEPER_ONLY, require('./invoices')(pool));

// Purchase book import from Excel. Mounted BEFORE the /api/purchases/* routes below so none of them shadows it.
app.use('/api/purchases/import', ...STOREKEEPER_ONLY, require('./books')(pool));
app.use('/api/suppliers', ...STOREKEEPER_ONLY, require('./suppliers')(pool));

// Material requests: any role with a session (operators only see their own); the phone push is storekeeper/admin only.
const push = require('./push')(pool);
app.use('/api/push', ...STOREKEEPER_ONLY, push.router);
app.use('/api/requests', withSession, require('./requests')(pool, { notify: push.notify }));

// Requisition: what to order and why, computed in code. Products with no data are only counted, not listed.
app.get('/api/requisition', ...STOREKEEPER_ONLY, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, code, name, quantity::float8 AS quantity, unit, minimum::float8 AS minimum,
                    target_level::float8 AS target_level, count_pending, control_type
               FROM products`);
        res.json(require('./requisition').requisition(rows));
    } catch (err) {
        fail(req, res, err, 'Error computing the requisition');
    }
});

// Edit a product's details: name, category, location, brand, group and price; the code only by an admin (productEdit.js).
app.patch('/api/products/:id', ...STOREKEEPER_ONLY,
    editProduct(pool, async (q, id) => (await q.query(`${SELECT_PRODUCT(true)} WHERE p.id = $1`, [id])).rows[0]));

// Sets how far to order up to (target_level) and from where (minimum) for ONE product. Rules:
//  - a no_balance product has neither (no balance to measure against);
//  - the target needs a minimum and must exceed it;
//  - null (or "") clears the value back to "never defined", not zero.
app.patch('/api/products/:id/levels', ...STOREKEEPER_ONLY, async (req, res) => {
    const productId = toPositiveInt(req.params.id);
    if (productId === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const body = req.body ?? {};
    const fields = ['minimum', 'target_level'].filter(c => body[c] !== undefined);
    if (fields.length === 0) return res.status(400).json({ error: 'send minimum, target_level or both' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [p] } = await client.query(
            'SELECT id, unit, control_type, minimum::text AS minimum, target_level::text AS target_level FROM products WHERE id = $1 FOR UPDATE', [productId]);
        if (!p) { await safeRollback(client); return res.status(404).json({ error: 'The product does not exist' }); }
        if (p.control_type === 'no_balance') {
            await safeRollback(client);
            return res.status(409).json({ error_code: 'no_balance', error: 'An item without stock tracking has no minimum or target level: there is no balance to measure them against.' });
        }
        const next = { minimum: p.minimum, target_level: p.target_level };
        for (const c of fields) {
            if (body[c] === null || (typeof body[c] === 'string' && body[c].trim() === '')) { next[c] = null; continue; }
            const parsed = validateQuantity(body[c], p.unit, c, `${c} cannot be negative`);
            if (parsed.error) { await safeRollback(client); return res.status(400).json({ error: parsed.error }); }
            next[c] = String(parsed.value);
        }
        if (next.target_level !== null && next.minimum === null) {
            await safeRollback(client);
            return res.status(400).json({ error: 'Set the minimum first: the target level is measured against it.' });
        }
        if (next.target_level !== null && Number(next.target_level) <= Number(next.minimum)) {
            await safeRollback(client);
            return res.status(400).json({ error: `The target level (${next.target_level}) must be above the minimum (${next.minimum}).` });
        }
        const { rows: [out] } = await client.query(
            `UPDATE products SET minimum = $1, target_level = $2 WHERE id = $3
             RETURNING id, minimum::float8 AS minimum, target_level::float8 AS target_level`,
            [next.minimum, next.target_level, productId]);
        await client.query('COMMIT');
        res.json(out);
    } catch (err) {
        await safeRollback(client);
        fail(req, res, err, 'Error saving the levels');
    } finally {
        client.release();
    }
});

// Switches whether a product is stock-tracked. Admin only: it moves what the dashboard, inventory and requisition say.
//  - To 'stock' the product enters UNCOUNTED, always: its stored balance never meant anything. Keeps its minimum.
//  - To 'no_balance' it loses minimum and target level (nothing to measure them against).
app.patch('/api/products/:id/control', withSession, withRole('admin'), async (req, res) => {
    const productId = toPositiveInt(req.params.id);
    if (productId === null) return res.status(400).json({ error: 'id must be a positive integer' });
    const next = (req.body ?? {}).control_type;
    if (!NEW_CONTROL_TYPES.includes(next)) return res.status(400).json({ error: 'control_type must be stock or no_balance' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [p] } = await client.query('SELECT id, control_type FROM products WHERE id = $1 FOR UPDATE', [productId]);
        if (!p) { await safeRollback(client); return res.status(404).json({ error: 'The product does not exist' }); }
        if (p.control_type === next) { await safeRollback(client); return res.json({ id: p.id, control_type: next, unchanged: true }); }
        if (p.control_type === 'unit') {
            await safeRollback(client);
            return res.status(409).json({ error_code: 'unit', error: 'A unit-controlled item (a tool with its own code) cannot be changed from here.' });
        }
        const { rows: [out] } = await client.query(
            next === 'stock'
                ? `UPDATE products SET control_type = 'stock', count_pending = true WHERE id = $1
                   RETURNING id, control_type, count_pending, minimum::float8 AS minimum, target_level::float8 AS target_level`
                : `UPDATE products SET control_type = 'no_balance', minimum = NULL, target_level = NULL WHERE id = $1
                   RETURNING id, control_type, count_pending, minimum::float8 AS minimum, target_level::float8 AS target_level`,
            [productId]);
        await client.query('COMMIT');
        res.json(out);
    } catch (err) {
        await safeRollback(client);
        fail(req, res, err, 'Error changing the control type');
    } finally {
        client.release();
    }
});

// Recurring: at least 3 purchases in at least 3 book months. Two purchases give no interval to average,
// and three in one month are a split order, not a habit.
const MIN_PURCHASES = 3;
const MIN_MONTHS = 3;
// Under two months of history isn't a pattern.
const MIN_SUGGESTED_DAYS = 60;

// The period is the BOOK'S MONTH, not the row's date, so a week crossing months doesn't split a book.
const BOOK_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// Each query param is ONE text. `?from=a&from=b` arrives as a list and `from[x]=a` as an object (extended
// parser) or a bracketed key (simple parser); all would reach Postgres or be coerced into another filter.
function singleText(query, names) {
    for (const name of names) {
        if ((query[name] !== undefined && typeof query[name] !== 'string')
            || Object.keys(query).some(key => key.startsWith(`${name}[`))) {
            return `${name} must be a single text`;
        }
    }
    return null;
}

// Empty = unbounded: the dashboard starts with whole books.
function readPeriod(query) {
    const period = {};
    for (const name of ['from', 'to']) {
        const value = query[name];
        if (!hasValue(value)) {
            period[name] = null;
            continue;
        }
        if (!BOOK_MONTH.test(value)) {
            return { error: `${name} must be a book month YYYY-MM` };
        }
        period[name] = value;
    }
    // 'YYYY-MM' sorts the same as text and as a date.
    if (period.from !== null && period.to !== null && period.from > period.to) {
        return { error: 'from cannot be after to' };
    }
    return period;
}

function periodConditions({ from, to }, values) {
    const conditions = [];
    if (from !== null) {
        values.push(from);
        conditions.push(`l.period >= $${values.length}`);
    }
    if (to !== null) {
        values.push(to);
        conditions.push(`l.period <= $${values.length}`);
    }
    return conditions;
}

// pageOf() accepts any number; an offset past the safe integer range would reach Postgres rounded, i.e. another page.
function readPage(req) {
    const page = pageOf(req);
    const offset = (page - 1) * PAGE_SIZE;
    if (!Number.isSafeInteger(offset)) {
        return { error: 'page out of range' };
    }
    return { page, offset };
}

// A closed-list value. `undefined` takes the default; empty text doesn't, since `?status=` is a malformed filter.
function readOption(query, name, options) {
    const value = query[name] === undefined ? options[0] : query[name];
    return options.includes(value) ? { value } : { error: `${name} must be ${options.join(', ')}` };
}

const WHERE = conditions => (conditions.length ? `WHERE ${conditions.join(' AND ')}` : '');

// "Date to review" in one expression so the dashboard notice, the table filter and each row's flag agree.
// Only the two forms the book states outright are accepted; inferred and pending-day ones are flagged.
// (These status strings are written by the book parser in books.js.)
const DATE_TO_REVIEW = `(c.date IS NULL
    OR c.date_status NOT IN ('explicit date', 'date inherited from block'))`;

/**
 * A book row with everything derived from it, shared by the dashboard, the reading and the recurring lists.
 *
 * `twins` is computed over the WHOLE table, not the period or page: the typical repeated row is a week
 * crossing months, noted in two books, and filtering first would hide it. Twins are flagged but stay in
 * the totals, since two real deliveries can look identical. PARTITION BY groups NULLs together.
 *
 * A row is linked when its normalized form matches an equivalence; alias_norm is unique, so at most one.
 */
const BOOK_LINES = where => `
    twins AS (
        SELECT id,
               count(*) OVER (PARTITION BY date, supplier_text, folio, description_norm,
                                           quantity, unit_price) > 1 AS possible_duplicate
          FROM purchases
         WHERE type = 'purchase'
    ), book_lines AS (
        SELECT c.id, c.book_id, l.file, l.period, c.sheet, c.sheet_order, c.cell, c.row_num, c.type,
               c.date, c.date_status, ${DATE_TO_REVIEW} AS date_to_review,
               c.description, c.description_norm, c.quantity, c.unit_price, c.amount,
               c.supplier_text, c.supplier_id, pr.name AS normalized_supplier,
               c.folio, c.requester, c.note, c.movement_id,
               COALESCE(g.possible_duplicate, false) AS possible_duplicate,
               a.id AS alias_id, a.origin AS alias_origin,
               p.id AS product_id, p.code AS product_code, p.name AS product_name,
               p.control_type, p.category_id, cat.name AS category
          FROM purchases c
          JOIN purchase_books l ON l.id = c.book_id
          LEFT JOIN twins g ON g.id = c.id
          LEFT JOIN product_aliases a ON a.alias_norm = c.description_norm
          LEFT JOIN products p ON p.id = a.product_id
          LEFT JOIN categories cat ON cat.id = p.category_id
          LEFT JOIN suppliers pr ON pr.id = c.supplier_id
         ${where}
    )`;

// The product a description got linked to, with the equivalence that links it (the screen needs alias_id to remove it).
const LINKED_PRODUCT = `CASE WHEN alias_id IS NULL THEN NULL ELSE json_build_object(
        'id', product_id, 'code', product_code, 'name', product_name,
        'control_type', control_type, 'alias_id', alias_id, 'alias_origin', alias_origin) END`;

app.get('/api/purchases/books', ...STOREKEEPER_ONLY, async (req, res) => {
    try {
        // `lines` and the amount count only purchases: no-amount rows and notes are part of the book
        // but summing them would pass off something with no cost as a purchase.
        const { rows } = await pool.query(`
            SELECT l.id, l.file, l.period,
                   count(c.id) FILTER (WHERE c.type = 'purchase')::int  AS lines,
                   count(c.id) FILTER (WHERE c.type = 'no_amount')::int AS no_amount,
                   count(c.id) FILTER (WHERE c.type = 'note')::int      AS notes,
                   (sum(c.amount) FILTER (WHERE c.type = 'purchase'))::text AS amount,
                   to_char(min(c.date) FILTER (WHERE c.type = 'purchase'), 'YYYY-MM-DD') AS first_date,
                   to_char(max(c.date) FILTER (WHERE c.type = 'purchase'), 'YYYY-MM-DD') AS last_date
              FROM purchase_books l
              LEFT JOIN purchases c ON c.book_id = l.id
             GROUP BY l.id, l.file, l.period
             ORDER BY l.period, l.id`);
        res.json(rows);
    } catch (err) {
        fail(req, res, err, 'Error querying the purchase books');
    }
});

// How each dashboard breakdown is built. The expressions are fixed and picked with an already-validated
// `group_by`: nothing from the client reaches the SQL.
const BREAKDOWNS = {
    // Without an exact catalog match the name is the book's text as is: similar names are never merged.
    supplier: {
        key: 'supplier_id::text',
        name: "COALESCE(normalized_supplier, supplier_text, 'No supplier')",
        typed: 'supplier_id IS NULL',
    },
    // "Uncategorized" (linked to an item with no category) and "Not linked" (the catalog doesn't know the
    // description) have different fixes; merging them would hide which one weighs more.
    category: {
        key: `CASE WHEN alias_id IS NULL THEN 'unlinked'
                   WHEN category_id IS NULL THEN 'uncategorized'
                   ELSE category_id::text END`,
        name: `CASE WHEN alias_id IS NULL THEN 'Not linked to catalog'
                    WHEN category_id IS NULL THEN 'Uncategorized'
                    ELSE category END`,
        typed: 'false',
    },
    month: { key: 'period::text', name: 'period::text', typed: 'false' },
    book: { key: 'book_id::text', name: 'file', typed: 'false' },
};

app.get('/api/purchases/summary', ...STOREKEEPER_ONLY, async (req, res) => {
    const error = singleText(req.query, ['from', 'to', 'group_by']);
    if (error) return res.status(400).json({ error });
    const period = readPeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const groupBy = readOption(req.query, 'group_by', Object.keys(BREAKDOWNS));
    if (groupBy.error) return res.status(400).json({ error: groupBy.error });

    const values = [];
    const where = WHERE(periodConditions(period, values));
    const d = BREAKDOWNS[groupBy.value];

    try {
        // One statement keeps period, summary, coverage, series and breakdown on the same snapshot.
        const { rows } = await pool.query(`
            WITH books AS (
                SELECT l.id, l.period FROM purchase_books l ${where}
            ), ${BOOK_LINES(where)}, period_purchases AS (
                SELECT * FROM book_lines WHERE type = 'purchase'
            ), breakdown AS (
                SELECT key, name, as_typed, count(*)::int AS purchases, sum(amount) AS amount
                  FROM (SELECT ${d.key} AS key, ${d.name} AS name,
                               ${d.typed} AS as_typed, amount
                          FROM period_purchases) x
                 GROUP BY key, name, as_typed
            ), series AS (
                -- From the books, not the rows: a month with no book is a gap, not zero spend.
                -- First/last date say whether a book is complete (partial books skew the "high month" median).
                SELECT l.period, count(r.id)::int AS purchases, sum(r.amount) AS amount,
                       to_char(min(r.date), 'YYYY-MM-DD') AS first_date,
                       to_char(max(r.date), 'YYYY-MM-DD') AS last_date
                  FROM books l
                  LEFT JOIN period_purchases r ON r.book_id = l.id
                 GROUP BY l.period
            )
            SELECT
                (SELECT json_build_object('first_book', min(period), 'last_book', max(period),
                                          'books', count(*)::int)
                   FROM books) AS period,
                (SELECT json_build_object(
                        'purchases', count(*) FILTER (WHERE type = 'purchase')::int,
                        'no_amount', count(*) FILTER (WHERE type = 'no_amount')::int,
                        'notes', count(*) FILTER (WHERE type = 'note')::int,
                        'amount', (sum(amount) FILTER (WHERE type = 'purchase'))::text,
                        'suppliers', count(DISTINCT COALESCE(normalized_supplier, supplier_text))
                                         FILTER (WHERE type = 'purchase')::int,
                        'first_date', to_char(min(date) FILTER (WHERE type = 'purchase'), 'YYYY-MM-DD'),
                        'last_date', to_char(max(date) FILTER (WHERE type = 'purchase'), 'YYYY-MM-DD'),
                        'possible_duplicates', count(*) FILTER (WHERE type = 'purchase' AND possible_duplicate)::int,
                        'dates_to_review', count(*) FILTER (WHERE type = 'purchase' AND date_to_review)::int)
                   FROM book_lines) AS summary,
                (SELECT json_build_object(
                        'with_stock', json_build_object(
                            'purchases', count(*) FILTER (WHERE alias_id IS NOT NULL AND control_type <> 'no_balance')::int,
                            'amount', (sum(amount) FILTER (WHERE alias_id IS NOT NULL AND control_type <> 'no_balance'))::text),
                        'no_stock', json_build_object(
                            'purchases', count(*) FILTER (WHERE alias_id IS NOT NULL AND control_type = 'no_balance')::int,
                            'amount', (sum(amount) FILTER (WHERE alias_id IS NOT NULL AND control_type = 'no_balance'))::text),
                        'unlinked', json_build_object(
                            'purchases', count(*) FILTER (WHERE alias_id IS NULL)::int,
                            'amount', (sum(amount) FILTER (WHERE alias_id IS NULL))::text,
                            'descriptions', count(DISTINCT description_norm) FILTER (WHERE alias_id IS NULL)::int),
                        'in_inventory', json_build_object(
                            'purchases', count(*) FILTER (WHERE movement_id IS NOT NULL)::int,
                            'amount', (sum(amount) FILTER (WHERE movement_id IS NOT NULL))::text))
                   FROM period_purchases) AS coverage,
                (SELECT COALESCE(json_agg(json_build_object(
                            'period', period, 'purchases', purchases, 'amount', amount::text,
                            'first_date', first_date, 'last_date', last_date) ORDER BY period), '[]'::json)
                   FROM series) AS monthly_series,
                (SELECT COALESCE(json_agg(json_build_object(
                            'key', key, 'name', name, 'purchases', purchases, 'amount', amount::text,
                            'as_typed', as_typed)
                        ORDER BY amount DESC NULLS LAST, name, key NULLS LAST), '[]'::json)
                   FROM breakdown) AS breakdown`,
        values);

        const data = rows[0];
        res.json({
            from: period.from,
            to: period.to,
            group_by: groupBy.value,
            period: data.period,
            summary: data.summary,
            coverage: data.coverage,
            monthly_series: data.monthly_series,
            breakdown: data.breakdown,
        });
    } catch (err) {
        fail(req, res, err, 'Error querying the purchases summary');
    }
});

const LINE_STATUSES = {
    all: null,
    unlinked: 'a.id IS NULL',
    linked: 'a.id IS NOT NULL',
    review: DATE_TO_REVIEW,
    duplicate: 'COALESCE(g.possible_duplicate, false)',
};

app.get('/api/purchases', ...STOREKEEPER_ONLY, async (req, res) => {
    const error = singleText(req.query, ['from', 'to', 'book_id', 'status', 'q', 'page', 'supplier_id', 'supplier_text']);
    if (error) return res.status(400).json({ error });
    const period = readPeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const status = readOption(req.query, 'status', Object.keys(LINE_STATUSES));
    if (status.error) return res.status(400).json({ error: status.error });
    const page = readPage(req);
    if (page.error) return res.status(400).json({ error: page.error });

    const values = [];
    const conditions = periodConditions(period, values);
    if (hasValue(req.query.book_id)) {
        const bookId = toPositiveInt(req.query.book_id);
        if (bookId === null) {
            return res.status(400).json({ error: 'book_id must be a positive integer' });
        }
        values.push(bookId);
        conditions.push(`c.book_id = $${values.length}`);
    }
    // By supplier (what the Suppliers screen links to): by id if it is in the catalog; if it only appears
    // written in the books, by that exact text with no catalog supplier. Both together make no sense.
    if (hasValue(req.query.supplier_id) && hasValue(req.query.supplier_text)) {
        return res.status(400).json({ error: 'Filter by supplier_id or supplier_text, not both' });
    }
    if (hasValue(req.query.supplier_id)) {
        const supplierId = toPositiveInt(req.query.supplier_id);
        if (supplierId === null) {
            return res.status(400).json({ error: 'supplier_id must be a positive integer' });
        }
        values.push(supplierId);
        conditions.push(`c.supplier_id = $${values.length}`);
    }
    if (hasValue(req.query.supplier_text)) {
        values.push(req.query.supplier_text);
        conditions.push(`c.supplier_id IS NULL AND c.supplier_text = $${values.length}`);
    }
    if (LINE_STATUSES[status.value]) conditions.push(LINE_STATUSES[status.value]);
    if (hasValue(req.query.q)) {
        values.push(`%${escapeLike(req.query.q)}%`);
        const n = values.length;
        // Who asked and the note are searchable too.
        conditions.push(`(${['c.description', 'c.folio', 'c.supplier_text', 'c.requester', 'c.note']
            .map(column => `${column} ILIKE $${n} ESCAPE '\\'`).join(' OR ')})`);
    }

    try {
        // Total and page in one statement so they can't disagree if the book changes between queries.
        const { rows } = await pool.query(`
            WITH ${BOOK_LINES(WHERE(conditions))}, page_rows AS (
                SELECT * FROM book_lines
                 ORDER BY period, book_id, sheet_order, row_num, id
                 LIMIT $${values.length + 1} OFFSET $${values.length + 2}
            )
            SELECT (SELECT count(*)::int FROM book_lines) AS total,
                   (SELECT COALESCE(json_agg(json_build_object(
                        'id', id,
                        'book', json_build_object('id', book_id, 'file', file, 'period', period),
                        'sheet', sheet, 'cell', cell, 'type', type,
                        'date', to_char(date, 'YYYY-MM-DD'), 'date_status', date_status,
                        'date_to_review', date_to_review,
                        'description', description,
                        'quantity', quantity::text, 'unit_price', unit_price::text, 'amount', amount::text,
                        'supplier', supplier_text, 'normalized_supplier', normalized_supplier,
                        'folio', folio, 'requester', requester, 'note', note,
                        'possible_duplicate', possible_duplicate,
                        'in_inventory', movement_id IS NOT NULL,
                        'product', ${LINKED_PRODUCT})
                    -- Reading order of the book: book, sheet, row.
                    ORDER BY period, book_id, sheet_order, row_num, id), '[]'::json)
                      FROM page_rows) AS detail`,
        [...values, PAGE_SIZE, page.offset]);

        const { total, detail } = rows[0];
        res.json({
            total,
            page: page.page,
            pages: Math.ceil(total / PAGE_SIZE),
            lines: detail,
        });
    } catch (err) {
        fail(req, res, err, 'Error querying the purchases');
    }
});

// `with_suggestion` filters in SQL like `unlinked`; which groups have a suggestion is decided afterwards in JS
// (suggestions.js), so that status fetches every unlinked group of the period and paginates here.
const GROUP_STATUSES = {
    unlinked: 'alias_id IS NULL', linked: 'alias_id IS NOT NULL', all: null, with_suggestion: 'alias_id IS NULL',
};

const linkCandidates = () => candidatesFor(pool);

// Recent items for the Home screen: latest purchases and price changes (recent.js). Includes prices, so operators never see it.
app.get('/api/purchases/recent', ...STOREKEEPER_ONLY, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT c.id, c.date::text AS date, c.folio, c.description, c.description_norm, c.unit_price::text AS unit_price,
                    c.amount::text AS amount, COALESCE(sp.name, c.supplier_text) AS supplier,
                    pr.code, pr.name AS product
               FROM purchases c
               LEFT JOIN suppliers sp ON sp.id = c.supplier_id
               LEFT JOIN product_aliases a ON a.alias_norm = c.description_norm
               LEFT JOIN products pr ON pr.id = a.product_id
              WHERE c.type = 'purchase' AND c.date IS NOT NULL`);
        res.json({ latest: latestPurchases(rows), prices: priceChanges(rows) });
    } catch (err) {
        fail(req, res, err, 'Error reading the recent purchases');
    }
});

app.get('/api/purchases/recurring', ...STOREKEEPER_ONLY, async (req, res) => {
    const error = singleText(req.query, ['from', 'to', 'status', 'only_recurring', 'page']);
    if (error) return res.status(400).json({ error });
    const period = readPeriod(req.query);
    if (period.error) return res.status(400).json({ error: period.error });
    const status = readOption(req.query, 'status', Object.keys(GROUP_STATUSES));
    if (status.error) return res.status(400).json({ error: status.error });
    const onlyRecurring = readOption(req.query, 'only_recurring', ['true', 'false']);
    if (onlyRecurring.error) return res.status(400).json({ error: onlyRecurring.error });
    const page = readPage(req);
    if (page.error) return res.status(400).json({ error: page.error });
    const withSuggestion = status.value === 'with_suggestion';

    const values = [];
    // Purchases only: no-amount rows and notes say nothing about quantity or price.
    const conditions = [...periodConditions(period, values), "c.type = 'purchase'"];
    const groupFilters = [];
    if (GROUP_STATUSES[status.value]) groupFilters.push(`g.${GROUP_STATUSES[status.value]}`);
    if (onlyRecurring.value === 'true') {
        groupFilters.push(`g.purchases >= ${MIN_PURCHASES} AND g.months >= ${MIN_MONTHS}`);
    }

    try {
        const { rows } = await pool.query(`
            WITH ${BOOK_LINES(WHERE(conditions))}, forms AS (
                SELECT description_norm, description, count(*) AS times,
                       max(date) AS last_date, max(period) AS last_book, max(id) AS last_id
                  FROM book_lines
                 GROUP BY description_norm, description
            ), main_form AS (
                -- Most frequent written form, latest on a tie: the one the warehouse recognises.
                SELECT DISTINCT ON (description_norm) description_norm, description
                  FROM forms
                 ORDER BY description_norm, times DESC, last_date DESC NULLS LAST,
                          last_book DESC, last_id DESC
            ), grouped AS (
                SELECT description_norm,
                       count(DISTINCT description)::int AS variants,
                       count(*)::int AS purchases,
                       count(DISTINCT period)::int AS months,
                       min(date) AS first_date, max(date) AS last_date,
                       count(*) FILTER (WHERE date IS NULL)::int AS no_day,
                       sum(quantity) AS quantity, sum(amount) AS amount,
                       -- Book first, then date: a row with no day from a later book is newer than any dated row of an earlier one.
                       (array_agg(unit_price ORDER BY period DESC, date DESC NULLS LAST,
                                                      sheet_order DESC, row_num DESC, id DESC)
                            FILTER (WHERE unit_price IS NOT NULL))[1] AS last_price,
                       COALESCE(array_agg(DISTINCT COALESCE(normalized_supplier, supplier_text))
                            FILTER (WHERE COALESCE(normalized_supplier, supplier_text) IS NOT NULL),
                            '{}') AS suppliers,
                       alias_id, alias_origin, product_id, product_code, product_name, control_type
                  FROM book_lines
                 GROUP BY description_norm, alias_id, alias_origin, product_id, product_code,
                          product_name, control_type
            ), filtered AS (
                SELECT g.*, f.description,
                       (g.purchases >= ${MIN_PURCHASES} AND g.months >= ${MIN_MONTHS}) AS recurring,
                       g.last_date - g.first_date AS days
                  FROM grouped g
                  JOIN main_form f USING (description_norm)
                 ${WHERE(groupFilters)}
            ), page_rows AS (
                SELECT * FROM filtered
                 ORDER BY amount DESC NULLS LAST, purchases DESC, description, description_norm
                 LIMIT $${values.length + 1} OFFSET $${values.length + 2}
            )
            SELECT (SELECT count(*)::int FROM filtered) AS total,
                   (SELECT COALESCE(json_agg(json_build_object(
                        'description_norm', description_norm, 'description', description,
                        'variants', variants, 'purchases', purchases, 'months', months,
                        'first_date', to_char(first_date, 'YYYY-MM-DD'),
                        'last_date', to_char(last_date, 'YYYY-MM-DD'),
                        'quantity', quantity::text, 'amount', amount::text,
                        'last_price', last_price::text,
                        'suppliers', suppliers, 'recurring', recurring,
                        -- Daily consumption x mean interval. Assumes buying is consuming: a proposal, not a measurement.
                        -- Needs 3 purchases and 60 days, and no purchase without a day (min/max would ignore it).
                        'suggested', CASE WHEN purchases >= ${MIN_PURCHASES} AND days >= ${MIN_SUGGESTED_DAYS}
                                          AND quantity IS NOT NULL AND no_day = 0
                            THEN json_build_object(
                                'daily_consumption', round(quantity / days, 3)::text,
                                'interval_days', round(days::numeric / (purchases - 1), 1)::text,
                                'minimum', round(quantity / days * (days::numeric / (purchases - 1)), 3)::text)
                            END,
                        'product', ${LINKED_PRODUCT})
                    ORDER BY amount DESC NULLS LAST, purchases DESC, description, description_norm), '[]'::json)
                      FROM page_rows) AS purchase_groups`,
        // With a suggestion, fetch every unlinked group (LIMIT NULL = no limit) and paginate after knowing which have one.
        [...values, withSuggestion ? null : PAGE_SIZE, withSuggestion ? 0 : page.offset]);

        // Only unlinked groups get a suggestion (a linked one already has its product).
        let { total, purchase_groups: groups } = rows[0];
        const candidates = groups.some(g => !g.product) ? await linkCandidates() : [];
        groups = groups.map(g => ({ ...g, suggestion: g.product ? null : suggest(g.description_norm, candidates) }));
        if (withSuggestion) {
            const withOne = groups.filter(g => g.suggestion);
            total = withOne.length;
            groups = withOne.slice(page.offset, page.offset + PAGE_SIZE);
        }
        res.json({
            total,
            page: page.page,
            pages: Math.ceil(total / PAGE_SIZE),
            criteria: { min_purchases: MIN_PURCHASES, min_months: MIN_MONTHS },
            groups,
        });
    } catch (err) {
        fail(req, res, err, 'Error querying the recurring purchases');
    }
});

// The description goes in as the book wrote it; Postgres normalizes it with normalize_description().
// Normalizing in JS would eventually differ from the database and create a link that links nothing.
function readDescription(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// How many book rows back a description. With none, no equivalence is created.
async function backingOf(connection, description) {
    const { rows } = await connection.query(
        `SELECT count(*)::int AS lines,
                count(*) FILTER (WHERE type = 'purchase')::int AS purchases,
                (sum(amount) FILTER (WHERE type = 'purchase'))::text AS amount
           FROM purchases
          WHERE description_norm = normalize_description($1)`,
        [description]
    );
    return rows[0];
}

async function linkOf(connection, description) {
    const { rows } = await connection.query(
        `SELECT a.id AS alias_id, p.id, p.code, p.name
           FROM product_aliases a
           JOIN products p ON p.id = a.product_id
          WHERE a.alias_norm = normalize_description($1)`,
        [description]
    );
    return rows[0] ?? null;
}

function descriptionLinked(link) {
    return {
        error: `That description is already linked to ${link.code}`,
        error_code: 'description_linked',
        product: { id: link.id, code: link.code, name: link.name },
    };
}

/** How many purchases a product's detail carries: the most recent; the rest are in Purchases. */
const PURCHASES_PER_PRODUCT = 20;

// A product's purchases, for its inventory detail. Same role as Purchases (they are costs). Same "linked"
// definition and order as `LAST_PURCHASE`, so the first row is always the price the inventory table shows.
app.get('/api/products/:id/purchases', ...STOREKEEPER_ONLY, async (req, res) => {
    const productId = toPositiveInt(req.params.id);
    if (productId === null) {
        return res.status(400).json({ error: 'id must be a positive integer' });
    }
    try {
        const { rows } = await pool.query(`
            WITH linked AS (
                SELECT pu.id, pu.date, pb.period, pu.description, pu.quantity, pu.unit_price,
                       pu.amount, COALESCE(sp.name, pu.supplier_text) AS supplier, pu.folio,
                       pu.sheet_order, pu.row_num
                  FROM product_aliases pa
                  JOIN purchases pu ON pu.description_norm = pa.alias_norm AND pu.type = 'purchase'
                  JOIN purchase_books pb ON pb.id = pu.book_id
                  LEFT JOIN suppliers sp ON sp.id = pu.supplier_id
                 WHERE pa.product_id = $1
            )
            -- No quantity total on purpose: books don't store the unit ("ROLL OF 15 Kg", "PER KILO"),
            -- so summing would show "10 kg" of something that was 150. Each row carries its quantity as is.
            SELECT json_build_object(
                       'purchases', count(*)::int,
                       'amount', sum(amount)::text,
                       'first_date', to_char(min(date), 'YYYY-MM-DD'),
                       'last_date', to_char(max(date), 'YYYY-MM-DD')) AS summary,
                   COALESCE((
                       SELECT json_agg(r) FROM (
                           SELECT id, to_char(date, 'YYYY-MM-DD') AS date, period, description,
                                  quantity::text AS quantity, unit_price::text AS price,
                                  amount::text AS amount, supplier, folio
                             FROM linked
                            ORDER BY period DESC, date DESC NULLS LAST, sheet_order DESC, row_num DESC, id DESC
                            LIMIT $2) r), '[]'::json) AS purchases
              FROM linked`,
            [productId, PURCHASES_PER_PRODUCT]
        );
        res.json(rows[0]);
    } catch (err) {
        fail(req, res, err, 'Error querying the product purchases');
    }
});

// Linking changes the catalog for everyone: a wrong link puts one thing's purchases on another's account.
app.post('/api/purchases/link', ...STOREKEEPER_ONLY, async (req, res) => {
    const body = req.body ?? {};
    const description = readDescription(body.description);
    if (description === null) {
        return res.status(400).json({ error: 'description is required' });
    }
    const productId = toPositiveInt(body.product_id);
    if (productId === null) {
        return res.status(400).json({ error: 'product_id must be a positive integer' });
    }

    try {
        const backing = await backingOf(pool, description);
        if (backing.lines === 0) {
            return res.status(404).json({ error: 'No purchase has that description' });
        }

        // ON CONFLICT rather than check-then-insert: the unique index on alias_norm is the real arbiter of
        // "one description, one item". The author comes from the session, never the body.
        const { rows } = await pool.query(
            `WITH inserted AS (
                INSERT INTO product_aliases (product_id, alias, origin, created_by)
                VALUES ($1, $2, 'manual', $3)
                ON CONFLICT (alias_norm) DO NOTHING
                RETURNING id, product_id
            )
            SELECT n.id AS alias_id, p.id, p.code, p.name
              FROM inserted n
              JOIN products p ON p.id = n.product_id`,
            [productId, description, req.user.id]
        );
        if (rows.length > 0) {
            const { alias_id, id, code, name } = rows[0];
            return res.status(201).json({
                alias_id, product: { id, code, name },
                purchases: backing.purchases, amount: backing.amount,
            });
        }

        // Not inserted: the description already had an owner. Same item again is just a double confirm; another item is a 409.
        const link = await linkOf(pool, description);
        if (!link) {
            return res.status(500).json({ error: 'Error linking the description' });
        }
        if (link.id === productId) {
            return res.json({
                already_linked: true, alias_id: link.alias_id,
                product: { id: link.id, code: link.code, name: link.name },
                purchases: backing.purchases, amount: backing.amount,
            });
        }
        return res.status(409).json(descriptionLinked(link));
    } catch (err) {
        if (err.code === '23503') {
            return res.status(404).json({ error: 'The product does not exist' });
        }
        fail(req, res, err, 'Error linking the description');
    }
});

// Creates a product from a purchase description and links it, in one transaction: a new product without
// its link would be a duplicate waiting to be created again.
app.post('/api/purchases/bring', ...STOREKEEPER_ONLY, async (req, res) => {
    const body = req.body ?? {};
    const description = readDescription(body.description);
    if (description === null) {
        return res.status(400).json({ error: 'description is required' });
    }
    const data = body.product;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        return res.status(400).json({ error: 'product is required' });
    }
    const newProduct = validateNewProduct(data);
    if (newProduct.error) {
        return res.status(400).json({ error: newProduct.error });
    }
    const control = validateNewControl(data, newProduct.product.unit);
    if (control.error) {
        return res.status(400).json({ error: control.error });
    }

    const client = await pool.connect();
    // A 23505 means different things on the product INSERT (repeated code) and the alias INSERT (linked meanwhile).
    let step = 'check';
    try {
        await client.query('BEGIN');

        const backing = await backingOf(client, description);
        if (backing.lines === 0) {
            await safeRollback(client);
            return res.status(404).json({ error: 'No purchase has that description' });
        }
        const link = await linkOf(client, description);
        if (link) {
            await safeRollback(client);
            return res.status(409).json(descriptionLinked(link));
        }

        step = 'product';
        const product = await insertUncounted(client, newProduct.product, control.control);

        step = 'alias';
        const { rows: [alias] } = await client.query(
            `INSERT INTO product_aliases (product_id, alias, origin, created_by)
             VALUES ($1, $2, 'manual', $3)
             RETURNING id`,
            [product.id, description, req.user.id]
        );

        await client.query('COMMIT');
        res.status(201).json({
            product, alias_id: alias.id,
            purchases: backing.purchases, amount: backing.amount,
        });
    } catch (err) {
        await safeRollback(client);
        if (err.code === '23505' && step === 'product') {
            return res.status(409).json({ error: 'That code already exists', error_code: 'duplicate_code' });
        }
        if (err.code === '23503' && step === 'product') {
            return res.status(400).json({ error: 'The selected category does not exist' });
        }
        if (err.code === '22003' && step === 'product') {
            return res.status(400).json({ error: 'price or minimum out of range' });
        }
        if (err.code === '23505' && step === 'alias') {
            // Linked between the check and the INSERT; the creation is already rolled back.
            try {
                const winner = await linkOf(client, description);
                if (winner) return res.status(409).json(descriptionLinked(winner));
            } catch (other) {
                console.error(other);
            }
            return res.status(409).json({
                error: 'That description was just linked to another item',
                error_code: 'description_linked',
            });
        }
        fail(req, res, err, 'Error bringing the item to the catalog');
    } finally {
        client.release();
    }
});

// Removes an equivalence. A wrong link is worse than none: it puts one thing's purchases on another's
// account and skews that item's suggested minimum.
app.delete('/api/purchases/links/:aliasId', ...STOREKEEPER_ONLY, async (req, res) => {
    const aliasId = toPositiveInt(req.params.aliasId);
    if (aliasId === null) {
        return res.status(400).json({ error: 'aliasId must be a positive integer' });
    }
    try {
        const { rowCount } = await pool.query('DELETE FROM product_aliases WHERE id = $1', [aliasId]);
        if (rowCount === 0) {
            return res.status(404).json({ error: 'That link does not exist' });
        }
        res.status(204).end();
    } catch (err) {
        fail(req, res, err, 'Error removing the link');
    }
});

// Movements

const SIGN = { in: 1, return: 1, out: -1, loan: -1 };
const TYPES = [...Object.keys(SIGN), 'adjustment'];

// Column is varchar(40); longer would reach Postgres as a 22001 and come back as a 500.
const MAX_FOLIO_LENGTH = 40;
const MAX_NOTE_LENGTH = 1000;

app.post('/api/movements', withSession, async (req, res) => {
    // Express 5 leaves req.body undefined without a JSON body.
    const body = req.body ?? {};
    const { type, quantity, count, folio, note } = body;
    // Only `true` confirms: the string "false" is truthy in JS, and the negative-balance warning must not be skippable by a type slip.
    const allow_negative = body.allow_negative === true;
    const track_stock = body.track_stock === true;

    // toPositiveInt rather than "!product_id": the ! operator also rejects 0, which is the same class of bug as quantity: "2".
    const productId = toPositiveInt(body.product_id);
    if (productId === null) {
        return res.status(400).json({ error: 'product_id must be a positive integer' });
    }
    if (!type) {
        return res.status(400).json({ error: 'type is required' });
    }
    if (!TYPES.includes(type)) {
        return res.status(400).json({ error: `invalid type: "${type}"` });
    }
    // An adjustment SETS the balance from someone's claimed count: it is the warehouse's control operation,
    // and whoever takes the material must not be the one correcting the books.
    if (type === 'adjustment' && req.user.role === 'operator') {
        return res.status(403).json({ error: 'The physical count is recorded by the warehouse', error_code: 'no_permission' });
    }

    // Same validation as product creation (`validateQuantity`): 0.0001 used to round to zero in numeric(12,3),
    // hit the CHECK quantity > 0 and come back as a 500. The unit isn't known yet; fractions are checked
    // later with the product in hand, inside the transaction.
    let countNum = null;
    let quantityNum = null;
    if (type === 'adjustment') {
        if (!hasValue(count)) {
            return res.status(400).json({ error: 'an adjustment needs the physical count (non-negative)' });
        }
        const parsed = validateQuantity(count, null, 'count', 'an adjustment needs the physical count (non-negative)');
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        countNum = parsed.value;
    } else {
        const parsed = hasValue(quantity)
            ? validateQuantity(quantity, null, 'quantity', 'quantity must be greater than 0')
            : { error: 'quantity must be greater than 0' };
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        if (parsed.value <= 0) return res.status(400).json({ error: 'quantity must be greater than 0' });
        quantityNum = parsed.value;
    }

    if (hasValue(folio) && (typeof folio !== 'string' || folio.length > MAX_FOLIO_LENGTH)) {
        return res.status(400).json({ error: `folio must be text of up to ${MAX_FOLIO_LENGTH} characters` });
    }
    if (hasValue(note) && (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH)) {
        return res.status(400).json({ error: `note must be text of up to ${MAX_NOTE_LENGTH} characters` });
    }

    // The author comes from the session, never the body (a `user_id` in the body is silently ignored).
    const userId = req.user.id;

    // The responsible person IS declared: whoever took the item may not be whoever operates the system.
    // Omitted when they're the same person.
    let responsibleId = null;
    if (hasValue(body.responsible_id)) {
        responsibleId = toPositiveInt(body.responsible_id);
        if (responsibleId === null) {
            return res.status(400).json({ error: 'responsible_id must be a positive integer' });
        }
        if (responsibleId === userId) responsibleId = null;
    }

    let supplierId = null;
    if (hasValue(body.supplier_id)) {
        supplierId = toPositiveInt(body.supplier_id);
        if (supplierId === null) {
            return res.status(400).json({ error: 'supplier_id must be a positive integer' });
        }
    }

    let unitPrice = null;
    if (hasValue(body.unit_price)) {
        // Cost is entered by whoever can see it (`canSeePrice`). Rejected rather than ignored: data that is sent and not saved misleads.
        if (!canSeePrice(req.user)) {
            return res.status(403).json({ error: 'Your role cannot enter prices', error_code: 'no_permission' });
        }
        unitPrice = toNumber(body.unit_price);
        if (unitPrice === null || unitPrice < 0) {
            return res.status(400).json({ error: 'unit_price must be a non-negative number' });
        }
        // Column is numeric(12,2): a huge number would reach the database (22003) and come back as a 500.
        if (!/^\d{1,10}(\.\d{1,2})?$/.test(String(body.unit_price).trim())) {
            return res.status(400).json({ error: 'unit_price allows up to 10 integer digits and 2 decimals (cents)' });
        }
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: prod } = await client.query(
            `SELECT id, code, name, quantity, unit, control_type, count_pending
               FROM products WHERE id = $1 FOR UPDATE`,
            [productId]
        );
        if (prod.length === 0) {
            await safeRollback(client);
            return res.status(404).json({ error: 'The product does not exist' });
        }
        const product = prod[0];

        // Half a pair of gloves is a typo in an exit just as in a new product.
        const entered = type === 'adjustment' ? countNum : quantityNum;
        if (WHOLE_UNITS.includes(product.unit) && !Number.isInteger(entered)) {
            await safeRollback(client);
            return res.status(400).json({ error: `fractions of "${product.unit}" are not allowed` });
        }
        const currentBalance = Number(product.quantity);

        // Counting an item that isn't stock-tracked means it IS: it becomes tracked, with the counted quantity.
        // That moves the dashboard and requisition for everyone, so:
        //  - admin only (like /api/products/:id/control);
        //  - with the warning shown, and clicking Register IS the confirmation (`track_stock`), like `allow_negative`.
        // An in or out on a no_balance item stays as before: logged without a balance.
        const promotes = type === 'adjustment' && product.control_type === 'no_balance';
        if (promotes && req.user.role !== 'admin') {
            await safeRollback(client);
            return res.status(403).json({ error_code: 'no_balance_admin_only',
                error: 'This item is not stock-tracked. Counting it would make it tracked, and only an administrator can decide that.' });
        }
        if (promotes && !track_stock) {
            await safeRollback(client);
            return res.status(409).json({ error_code: 'no_balance', confirm_with: 'track_stock',
                error: 'This item is not stock-tracked. Counting it will make it tracked, with the quantity you counted.',
                product: { id: product.id, code: product.code, name: product.name } });
        }

        let movQuantity;
        let newBalance;
        let finalNote = note ?? null;

        if (type === 'adjustment') {
            const difference = countNum - currentBalance;
            if (difference === 0) {
                // Confirming the same balance is also counting: no zero-quantity movement, but the pending flag is resolved.
                await client.query('UPDATE products SET count_pending = false WHERE id = $1', [productId]);
                await client.query('COMMIT');
                return res.json({ unchanged: true, new_balance: currentBalance });
            }
            movQuantity = Math.abs(difference);
            newBalance = countNum;
            // The first count of an uncounted product has no surplus or shortfall: its old balance started from a
            // zero nobody measured. The movement quantity is still the difference so the log adds up with the
            // balance; only the note's claim changes.
            if (promotes) {
                finalNote = `First physical count: ${countNum} — now stock-tracked` + (note ? ` — ${note}` : '');
            } else if (product.count_pending) {
                finalNote = `First physical count: ${countNum}` + (note ? ` — ${note}` : '');
            } else {
                const direction = difference > 0 ? 'surplus' : 'shortfall';
                finalNote = `Physical count: ${countNum} (${direction} of ${movQuantity})`
                    + (note ? ` — ${note}` : '');
            }
        } else {
            movQuantity = quantityNum;
            newBalance = currentBalance + movQuantity * SIGN[type];
        }

        // Negative balances don't block the record: they ask for confirmation once and are saved flagged
        // (if the tool already left, refusing to log it doesn't bring it back).
        // no_balance products are exempt (no balance by design), and so are uncounted ones: their balance
        // starts from a zero nobody measured, so -1 only means the count is still pending.
        const exempt = product.control_type === 'no_balance' || product.count_pending;
        const goesNegative = newBalance < 0 && !exempt;

        if (goesNegative && !allow_negative) {
            await safeRollback(client);
            return res.status(409).json({
                error: 'The movement leaves the balance negative',
                error_code: 'negative_balance',
                confirm_with: 'allow_negative',
                product: {
                    id: product.id,
                    code: product.code,
                    name: product.name,
                },
                current_balance: currentBalance,
                requested_quantity: movQuantity,
                resulting_balance: newBalance,
            });
        }

        const { rows: mov } = await client.query(
            `INSERT INTO movements
                (product_id, type, quantity, user_id, responsible_id, supplier_id,
                 unit_price, folio, note, over_negative)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, product_id, type, quantity, note, date, over_negative,
                       user_id, responsible_id`,
            [productId, type, movQuantity, userId, responsibleId, supplierId,
                unitPrice, folio ?? null, finalNote, goesNegative]
        );

        // An adjustment comes from a physical count, so by definition it resolves count_pending.
        await client.query(
            `UPDATE products
                SET quantity = $1,
                    count_pending = CASE WHEN $2 THEN false ELSE count_pending END,
                    control_type = CASE WHEN $4 THEN 'stock' ELSE control_type END
              WHERE id = $3`,
            [newBalance, type === 'adjustment', productId, promotes]
        );

        await client.query('COMMIT');
        res.status(201).json({
            movement: mov[0],
            new_balance: newBalance,
            over_negative: goesNegative,
            ...(promotes ? { now_tracks_stock: true } : {}),
        });
    } catch (err) {
        await safeRollback(client);
        if (err.code === '23503') {
            return res.status(400).json({ error: 'User or supplier does not exist' });
        }
        fail(req, res, err, 'Error recording the movement');
    } finally {
        client.release();
    }
});

app.get('/api/movements', withSession, async (req, res) => {
    const { product_id, type } = req.query;
    const pageRead = readPage(req);
    if (pageRead.error) return res.status(400).json({ error: pageRead.error });
    const page = pageRead.page;

    const conditions = [];
    const values = [];

    // Operators can NOT see who has a tool: not privacy, but control. If they know who holds it they ask the
    // coworker directly and the exit never goes through the warehouse. It's in the server WHERE because hiding
    // the menu link doesn't hide the endpoint. They do see their own, including who recorded it for them.
    // `responsible_id` can be null when an operator scans themselves (omitted if equal to the author),
    // hence `user_id` is checked too.
    if (req.user.role === 'operator') {
        values.push(req.user.id);
        conditions.push(`(m.user_id = $${values.length} OR m.responsible_id = $${values.length})`);
    }

    if (hasValue(product_id)) {
        const id = toPositiveInt(product_id);
        if (id === null) {
            return res.status(400).json({ error: 'product_id must be a positive integer' });
        }
        values.push(id);
        conditions.push(`m.product_id = $${values.length}`);
    }
    if (hasValue(type)) {
        if (!TYPES.includes(type)) {
            return res.status(400).json({ error: `invalid type: "${type}"` });
        }
        values.push(type);
        conditions.push(`m.type = $${values.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    try {
        const totalQ = await pool.query(
            `SELECT COUNT(*) FROM movements m ${where}`, values
        );
        const total = Number(totalQ.rows[0].count);

        // Unit price is cost: OMITTED for those who can't see it, like the catalog.
        const dataQ = await pool.query(
            // `origin` marks historical rows: they carry no author or time (all at midnight),
            // so the screen must not show "12:00 AM" as if someone recorded it then.
            `SELECT m.id, m.type, m.quantity, ${canSeePrice(req.user) ? 'm.unit_price,' : ''} m.folio, m.note, m.date, m.origin,
                    m.over_negative, m.product_id, p.code, p.name AS product,
                    m.user_id, u.name AS user,
                    m.responsible_id, COALESCE(r.name, u.name) AS responsible
               FROM movements m
               JOIN products p ON p.id = m.product_id
               LEFT JOIN users u ON u.id = m.user_id
               LEFT JOIN users r ON r.id = m.responsible_id
               ${where}
              ORDER BY m.date DESC, m.id DESC
              LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
            [...values, PAGE_SIZE, (page - 1) * PAGE_SIZE]
        );

        res.json({
            movements: dataQ.rows,
            total,
            page,
            pages: Math.ceil(total / PAGE_SIZE),
        });
    } catch (err) {
        fail(req, res, err, 'Error querying movements');
    }
});

// Production: health, the built client and errors

// Healthcheck: answers whether the API is alive AND reaches the database. No session.
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ ok: true });
    } catch (err) {
        console.error('health:', err.message);
        res.status(503).json({ ok: false, error: 'No database connection' });
    }
});

// An unknown /api route is a JSON 404, not the index.html below.
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// In production Express serves client/dist; in development Vite does.
if (process.env.SERVE_CLIENT === '1') {
    const path = require('node:path');
    const dist = path.join(__dirname, 'client', 'dist');
    // assets/ files are hashed, so they cache forever. index.html points at the new hashes and must not be cached.
    app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(dist, { index: false, maxAge: 0 }));
    // react-router routes (/inventory, /scan...) don't exist as files: they all get index.html.
    app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        res.set('Cache-Control', 'no-cache');
        res.sendFile(path.join(dist, 'index.html'));
    });
}

// Without this an uncaught error answers Express's HTML with the stack and server paths.
// Details go to the log; the client only learns that it failed.
// eslint-disable-next-line no-unused-vars -- Express recognises an error handler by its 4 parameters
app.use((err, req, res, next) => {
    // Body-parser errors (malformed JSON, too large, odd charset, aborted request) carry their own 4xx:
    // they are the sender's fault, not the server's.
    const status = err.status ?? err.statusCode;
    if (status >= 400 && status < 500 && !res.headersSent) {
        const text = { 'entity.parse.failed': 'The body is not valid JSON', 'entity.too.large': 'The body is too large' };
        return res.status(status).json({ error: text[err.type] ?? 'Invalid request' });
    }
    console.error(`[${req.id}]`, err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'Internal server error', id: req.id });
});

return app;
}

if (require.main === module) {
    require('./operations').start(createApp, require('./db'));
}
module.exports = { createApp };
