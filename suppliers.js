// Suppliers router: who we buy from and what the books say about them. Behind a session and the storekeeper/admin
// role (it carries amounts, operators don't see them).
//
// Two kinds of suppliers: CATALOG ones (`suppliers`) and names that are only WRITTEN on a purchase line
// (`purchases.supplier_text` with no `supplier_id`). Lookalikes are never merged on their own: the written name
// gets the closest catalog one SUGGESTED and a person decides. Decisions are remembered as aliases
// (`supplier_aliases`) so the next book, invoice or scan links by itself. Lines are never rewritten, they only get
// `supplier_id`. Writes run in a transaction under a lock, otherwise two people creating the same name at once
// would both pass the duplicate check. Only 'purchase' type lines count, like the Purchases dashboard.

const express = require('express');
const auth = require('./auth');
const { toPositiveInt, fail, safeRollback, Rejection } = require('./util');
const { latestPurchases } = require('./recent');
const { suggestSupplier } = require('./books');

const MAX_NAME = 120;   // suppliers.name is varchar(120)
const MAX_NOTE = 1000;
const MAX_TAGS = 8;      // the table CHECK says the same
const MAX_TAG = 30;
// the generic RFCs for "general public" and "foreign" show up on anyone's invoices, they identify nobody
const GENERIC_RFCS = new Set(['XAXX010101000', 'XEXX010101000']);
const RE_RFC = /^[A-ZÑ&0-9]{12,13}$/;

const LAST_DATE = 'to_char(max(c.date), \'YYYY-MM-DD\')';

/** Most bought first; no amount last; ties by name. */
const byAmount = (a, b) => (a.amount === null) - (b.amount === null)
    || Number(b.amount) - Number(a.amount)
    || a.name.localeCompare(b.name, 'es');

const trimText = v => typeof v === 'string' ? v.trim() : v;

/** Validates a supplier card body. `partial`: on an update only the keys that came are checked. */
function readCard(body, { partial }) {
    const b = body && typeof body === 'object' ? body : {};
    const out = {};
    if (!partial || 'name' in b) {
        const name = trimText(b.name);
        if (typeof name !== 'string' || name === '' || name.length > MAX_NAME) {
            throw new Rejection(`Name is required and up to ${MAX_NAME} characters`);
        }
        out.name = name;
    }
    if ('rfc' in b) {
        const rfc = b.rfc === null || b.rfc === '' ? null : String(trimText(b.rfc)).toUpperCase();
        if (rfc !== null && (!RE_RFC.test(rfc) || GENERIC_RFCS.has(rfc))) {
            throw new Rejection('RFC must be 12 or 13 letters and digits (and not the generic one for general public or foreign)');
        }
        out.rfc = rfc;
    }
    if ('note' in b) {
        const note = b.note === null ? null : trimText(b.note);
        if (note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) throw new Rejection(`Note is up to ${MAX_NOTE} characters`);
        out.note = note === '' ? null : note;
    }
    if ('tags' in b) out.tags = readTags(b.tags);
    return out;
}

/** Clean tags: collapsed spaces, no empty ones, no case-insensitive repeats. */
function readTags(value) {
    if (!Array.isArray(value)) throw new Rejection('Tags must be a list');
    const seen = new Set(), out = [];
    for (const v of value) {
        if (typeof v !== 'string') throw new Rejection('Each tag must be text');
        const t = v.trim().replace(/\s+/g, ' ');
        if (t === '') continue;
        if (t.length > MAX_TAG) throw new Rejection(`Each tag is up to ${MAX_TAG} characters`);
        if (seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        out.push(t);
    }
    if (out.length > MAX_TAGS) throw new Rejection(`A supplier takes up to ${MAX_TAGS} tags`);
    return out;
}

/** A tag is spelled the same on every supplier: if "Steel" exists, "steel" is saved as "Steel". */
async function unifyTags(q, tags) {
    if (tags.length === 0) return tags;
    // the preset list wins, then spellings other suppliers already use
    const { rows } = await q.query(`
        SELECT tag FROM (SELECT name AS tag, 0 AS sort_order FROM supplier_tags
                         UNION ALL SELECT DISTINCT unnest(tags), 1 FROM suppliers) t ORDER BY sort_order DESC, tag`);
    const written = new Map(rows.map(r => [r.tag.toLowerCase(), r.tag]));
    return tags.map(t => written.get(t.toLowerCase()) ?? t);
}

const MAX_CONTACTS = 20;
const CONTACT_LIMITS = { name: 120, email: 120, address: 300 };
const MAX_PHONES = 5;      // the table CHECK says the same
const MAX_PHONE = 40;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A whole contact (replaced as a unit): every field optional, empty = no data, but not all empty. */
function readContact(body) {
    const b = body && typeof body === 'object' ? body : {};
    const out = {};
    for (const [field, max] of Object.entries(CONTACT_LIMITS)) {
        const v = b[field] === undefined || b[field] === null ? null : trimText(b[field]);
        if (v !== null && typeof v !== 'string') throw new Rejection(`${field} must be text`);
        if (v !== null && v.length > max) throw new Rejection(`${field[0].toUpperCase()}${field.slice(1)}: up to ${max} characters`);
        out[field] = v === '' ? null : v;
    }
    if (out.email !== null && !RE_EMAIL.test(out.email)) throw new Rejection('The email does not look valid');
    // `phones` is the list; a lone `phone` is still accepted as a single one
    const list = b.phones ?? (b.phone === undefined || b.phone === null ? [] : [b.phone]);
    if (!Array.isArray(list)) throw new Rejection('Phones must be a list');
    out.phones = [];
    for (const v of list) {
        if (typeof v !== 'string') throw new Rejection('Each phone must be text');
        const t = v.trim().replace(/\s+/g, ' ');
        if (t.length > MAX_PHONE) throw new Rejection(`Each phone is up to ${MAX_PHONE} characters`);
        if (t !== '' && !out.phones.includes(t)) out.phones.push(t);
    }
    if (out.phones.length > MAX_PHONES) throw new Rejection(`A contact takes up to ${MAX_PHONES} phones`);
    if (out.phones.length === 0 && [out.name, out.email, out.address].every(v => v === null)) throw new Rejection('Enter at least one detail for the contact');
    return out;
}

/** Another supplier already called this, by name or by alias. */
async function clash(q, name, exceptId = 0) {
    const { rows: [other] } = await q.query(`
        SELECT p.id, p.name, 'name' AS matched_by FROM suppliers p
         WHERE normalize_supplier(p.name) = normalize_supplier($1) AND p.id <> $2
        UNION ALL
        SELECT p.id, p.name, 'alias' FROM supplier_aliases a JOIN suppliers p ON p.id = a.supplier_id
         WHERE a.alias_norm = normalize_supplier($1) AND p.id <> $2
        LIMIT 1`, [name, exceptId]);
    return other ?? null;
}

const rejectClash = (other, name) => {
    throw new Rejection(`"${name}" is already ${other.matched_by === 'name' ? 'the name' : 'an alias'} of "${other.name}"`, 409, { supplier: { id: other.id, name: other.name } });
};

/** Links to this supplier everything that has no supplier yet and carries this name (book lines and invoices). */
async function linkName(q, supplierId, name) {
    const c = await q.query(
        `UPDATE purchases SET supplier_id = $1
          WHERE supplier_id IS NULL AND normalize_supplier(supplier_text) = normalize_supplier($2)`, [supplierId, name]);
    const f = await q.query(
        `UPDATE invoices SET supplier_id = $1
          WHERE supplier_id IS NULL AND normalize_supplier(issuer_name) = normalize_supplier($2)`, [supplierId, name]);
    return { purchases: c.rowCount, invoices: f.rowCount };
}

/** Invoices with this RFC and no supplier yet. The XML carries the issuer's RFC, the firmest identifier. */
async function linkRfc(q, supplierId, rfc) {
    if (rfc === null) return 0;
    const { rowCount } = await q.query(`UPDATE invoices SET supplier_id = $1 WHERE supplier_id IS NULL AND upper(issuer_rfc) = $2`, [supplierId, rfc]);
    return rowCount;
}

async function addAlias(q, supplier, alias, origin, userId) {
    if (alias.toLowerCase().replace(/\s+/g, ' ') === supplier.name.toLowerCase().replace(/\s+/g, ' ')) return null;
    const { rows: [row] } = await q.query(
        `INSERT INTO supplier_aliases (supplier_id, alias, origin, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (alias_norm) DO NOTHING RETURNING id, alias, origin`, [supplier.id, alias, origin, userId]);
    return row ?? null;
}

/**
 * The supplier of an invoice: by RFC if it has one (firmest), else by name or alias. Returns the id or null.
 * Only links what exists, never creates suppliers.
 */
async function resolveSupplier(q, { rfc, name }) {
    if (rfc) {
        const { rows: [p] } = await q.query('SELECT id FROM suppliers WHERE rfc = $1', [String(rfc).toUpperCase()]);
        if (p) return p.id;
    }
    if (name) {
        const { rows: [p] } = await q.query(`
            SELECT id FROM suppliers WHERE normalize_supplier(name) = normalize_supplier($1)
            UNION ALL
            SELECT supplier_id FROM supplier_aliases WHERE alias_norm = normalize_supplier($1)
            LIMIT 1`, [name]);
        if (p) return p.id;
    }
    return null;
}

module.exports = function createSuppliersRoutes(pool) {
    const router = express.Router();
    const adminOnly = auth.requireRole('admin');

    /** A write: locked transaction; `Rejection`s go out as what they are (400/404/409), not as 500. */
    const write = (message, fn) => async (req, res) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT pg_advisory_xact_lock(hashtext('suppliers'))`);
            const response = await fn(client, req);
            await client.query('COMMIT');
            res.status(response.status ?? 200).json(response.body);
        } catch (err) {
            await safeRollback(client);
            if (err instanceof Rejection) return res.status(err.status).json({ error: err.message, ...err.extra });
            // unique index on RFC or name: someone else won between the check and the INSERT
            if (err.code === '23505') return res.status(409).json({ error: 'A supplier with that name or RFC already exists' });
            fail(req, res, err, message);
        } finally {
            client.release();
        }
    };

    const existing = async (q, id, { lock = false } = {}) => {
        const { rows: [p] } = await q.query(
            `SELECT id, name, rfc, note, tags, archived_at FROM suppliers WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
        if (!p) throw new Rejection('That supplier does not exist', 404);
        return p;
    };
    const idOf = req => {
        const id = toPositiveInt(req.params.id);
        if (id === null) throw new Rejection('invalid id');
        return id;
    };

    router.get('/', async (req, res) => {
        const withArchived = req.query.archived === '1';
        try {
            const { rows } = await pool.query(`
                SELECT p.id, p.name, true AS in_catalog, p.rfc, p.tags, p.archived_at IS NOT NULL AS archived, count(c.id)::int AS lines,
                       sum(c.amount)::text AS amount, ${LAST_DATE} AS last_date
                  FROM suppliers p
                  LEFT JOIN purchases c ON c.supplier_id = p.id AND c.type = 'purchase'
                 WHERE ($1 OR p.archived_at IS NULL)
                 GROUP BY p.id, p.name, p.rfc, p.tags, p.archived_at
                UNION ALL
                SELECT NULL, c.supplier_text, false, NULL, '{}'::text[], false, count(*)::int, sum(c.amount)::text, ${LAST_DATE}
                  FROM purchases c
                 WHERE c.type = 'purchase' AND c.supplier_id IS NULL AND c.supplier_text IS NOT NULL
                 GROUP BY c.supplier_text`, [withArchived]);
            // lines with no supplier at all aren't a supplier: counted apart, only if there are any
            const { rows: [none] } = await pool.query(`
                SELECT count(*)::int AS lines, sum(amount)::text AS amount
                  FROM purchases
                 WHERE type = 'purchase' AND supplier_id IS NULL AND supplier_text IS NULL`);
            const { rows: presetTags } = await pool.query('SELECT id, name FROM supplier_tags ORDER BY name_norm');
            const current = rows.filter(p => p.in_catalog && !p.archived);
            const suppliers = rows.map(p => p.in_catalog ? p : { ...p, suggested: suggestSupplier(p.name, current) });
            res.json({
                suppliers: suppliers.sort(byAmount),
                no_supplier: none.lines > 0 ? none : null,
                preset_tags: presetTags,
            });
        } catch (err) {
            fail(req, res, err, 'Error loading the suppliers');
        }
    });

    router.get('/detail', async (req, res) => {
        const id = req.query.id === undefined ? null : toPositiveInt(req.query.id);
        const name = typeof req.query.text === 'string' ? req.query.text : null;
        if ((id === null) === (name === null)) {
            return res.status(400).json({ error: 'Ask for a supplier by id (catalog) or by text (written in a book), not both' });
        }
        // the criterion is fixed and the value is a parameter: nothing from the client enters the SQL
        const [who, value] = id !== null
            ? ['c.supplier_id = $1', id]
            : ['c.supplier_id IS NULL AND c.supplier_text = $1', name];
        try {
            let card = null, aliases = [], contacts = [], links = null;
            if (id !== null) {
                const { rows: [p] } = await pool.query('SELECT id, name, rfc, note, tags, archived_at IS NOT NULL AS archived FROM suppliers WHERE id = $1', [id]);
                if (!p) return res.status(404).json({ error: 'That supplier does not exist' });
                card = p;
                ({ rows: aliases } = await pool.query(`
                    SELECT a.id, a.alias, a.origin, a.created_at, u.name AS created_by
                      FROM supplier_aliases a LEFT JOIN users u ON u.id = a.created_by
                     WHERE a.supplier_id = $1 ORDER BY a.alias_norm`, [id]));
                // contacts are admin-only, storekeepers don't even get them
                if (req.user.role === 'admin') {
                    ({ rows: contacts } = await pool.query(
                        'SELECT id, name, phones, email, address FROM supplier_contacts WHERE supplier_id = $1 ORDER BY id', [id]));
                }
                ({ rows: [links] } = await pool.query(`
                    SELECT (SELECT count(*) FROM purchases WHERE supplier_id = $1)::int AS purchases,
                           (SELECT count(*) FROM invoices WHERE supplier_id = $1)::int AS invoices,
                           (SELECT count(*) FROM movements WHERE supplier_id = $1)::int AS movements`, [id]));
            }

            const { rows: [t] } = await pool.query(`
                SELECT count(*)::int AS lines, sum(c.amount)::text AS amount,
                       to_char(min(c.date), 'YYYY-MM-DD') AS first_date, ${LAST_DATE} AS last_date
                  FROM purchases c WHERE c.type = 'purchase' AND ${who}`, [value]);
            // a catalog supplier may have no purchases (made by hand); a written-only one exists through its lines
            if (id === null && t.lines === 0) return res.status(404).json({ error: 'That supplier has no purchases in the books' });

            const { rows: dated } = await pool.query(`
                SELECT c.id, c.date::text AS date, c.folio, c.amount::text AS amount, NULL AS supplier
                  FROM purchases c WHERE c.type = 'purchase' AND c.date IS NOT NULL AND ${who}`, [value]);
            const { rows: topPurchased } = await pool.query(`
                SELECT min(c.description) AS description, count(*)::int AS lines, sum(c.amount)::text AS amount
                  FROM purchases c WHERE c.type = 'purchase' AND c.amount IS NOT NULL AND ${who}
                 GROUP BY c.description_norm ORDER BY sum(c.amount) DESC, min(c.description) LIMIT 5`, [value]);

            res.json({
                ...t, card, aliases, contacts, links,
                latest: latestPurchases(dated, 10).map(({ date, folio, lines, amount }) => ({ date, folio, lines, amount })),
                top_purchased: topPurchased,
            });
        } catch (err) {
            fail(req, res, err, 'Error loading the supplier');
        }
    });

    router.post('/', write('Error creating the supplier', async (q, req) => {
        const card = readCard(req.body, { partial: false });
        const other = await clash(q, card.name);
        if (other) rejectClash(other, card.name);
        const { rows: [p] } = await q.query(
            `INSERT INTO suppliers (name, rfc, note, tags) VALUES ($1, $2, $3, $4) RETURNING id, name, rfc, note, tags`,
            [card.name, card.rfc ?? null, card.note ?? null, await unifyTags(q, card.tags ?? [])]);
        // lines or invoices already carrying this name (or its RFC) get linked
        const linked = await linkName(q, p.id, p.name);
        linked.invoices += await linkRfc(q, p.id, p.rfc);
        return { status: 201, body: { ...p, linked } };
    }));

    router.patch('/:id', write('Error saving the supplier', async (q, req) => {
        const id = idOf(req);
        const card = readCard(req.body, { partial: true });
        const current = await existing(q, id, { lock: true });
        let linked = { purchases: 0, invoices: 0 };
        if (card.name !== undefined && card.name !== current.name) {
            const other = await clash(q, card.name, id);
            if (other) rejectClash(other, card.name);
            // the old name keeps finding it (books carrying it still link), and an alias that is now its own name is redundant
            await addAlias(q, { id, name: card.name }, current.name, 'rename', req.user.id);
            await q.query('DELETE FROM supplier_aliases WHERE supplier_id = $1 AND alias_norm = normalize_supplier($2)', [id, card.name]);
            linked = await linkName(q, id, card.name);
        }
        if (card.tags !== undefined) card.tags = await unifyTags(q, card.tags);
        const next = { name: current.name, rfc: current.rfc, note: current.note, tags: current.tags, ...card };
        await q.query('UPDATE suppliers SET name = $2, rfc = $3, note = $4, tags = $5 WHERE id = $1',
            [id, next.name, next.rfc, next.note, next.tags]);
        if (card.rfc !== undefined && card.rfc !== current.rfc) linked.invoices += await linkRfc(q, id, card.rfc);
        return { body: { id, ...next, linked } };
    }));

    router.post('/:id/aliases', write('Error saving the alias', async (q, req) => {
        const id = idOf(req);
        const alias = trimText(req.body?.alias);
        if (typeof alias !== 'string' || alias === '' || alias.length > MAX_NAME) throw new Rejection(`Name is required and up to ${MAX_NAME} characters`);
        const supplier = await existing(q, id, { lock: true });
        const other = await clash(q, alias, id);
        if (other) rejectClash(other, alias);
        const row = await addAlias(q, supplier, alias, 'manual', req.user.id);
        if (!row) throw new Rejection(`"${alias}" is already the name or an alias of this supplier`, 409);
        return { status: 201, body: { ...row, linked: await linkName(q, id, alias) } };
    }));

    router.delete('/:id/aliases/:aliasId', write('Error removing the alias', async (q, req) => {
        const id = idOf(req), aliasId = toPositiveInt(req.params.aliasId);
        if (aliasId === null) throw new Rejection('invalid aliasId');
        const { rowCount } = await q.query('DELETE FROM supplier_aliases WHERE id = $1 AND supplier_id = $2', [aliasId, id]);
        if (rowCount === 0) throw new Rejection('That alias does not exist', 404);
        // what's already linked stays linked: removing the alias only changes what comes later
        return { body: { ok: true } };
    }));

    router.post('/:id/contacts', adminOnly, write('Error saving the contact', async (q, req) => {
        const id = idOf(req);
        const c = readContact(req.body);
        await existing(q, id, { lock: true });
        const { rows: [{ n }] } = await q.query('SELECT count(*)::int AS n FROM supplier_contacts WHERE supplier_id = $1', [id]);
        if (n >= MAX_CONTACTS) throw new Rejection(`A supplier takes up to ${MAX_CONTACTS} contacts`, 409);
        const { rows: [row] } = await q.query(
            `INSERT INTO supplier_contacts (supplier_id, name, phones, email, address) VALUES ($1, $2, $3, $4, $5)
             RETURNING id, name, phones, email, address`, [id, c.name, c.phones, c.email, c.address]);
        return { status: 201, body: row };
    }));

    router.put('/:id/contacts/:contactId', adminOnly, write('Error saving the contact', async (q, req) => {
        const id = idOf(req), contactId = toPositiveInt(req.params.contactId);
        if (contactId === null) throw new Rejection('invalid contactId');
        const c = readContact(req.body);
        const { rows: [row] } = await q.query(
            `UPDATE supplier_contacts SET name = $3, phones = $4, email = $5, address = $6
              WHERE id = $2 AND supplier_id = $1 RETURNING id, name, phones, email, address`,
            [id, contactId, c.name, c.phones, c.email, c.address]);
        if (!row) throw new Rejection('That contact does not exist', 404);
        return { body: row };
    }));

    router.delete('/:id/contacts/:contactId', adminOnly, write('Error removing the contact', async (q, req) => {
        const id = idOf(req), contactId = toPositiveInt(req.params.contactId);
        if (contactId === null) throw new Rejection('invalid contactId');
        const { rowCount } = await q.query('DELETE FROM supplier_contacts WHERE id = $1 AND supplier_id = $2', [contactId, id]);
        if (rowCount === 0) throw new Rejection('That contact does not exist', 404);
        return { body: { ok: true } };
    }));

    router.post('/tags', adminOnly, write('Error saving the tag', async (q, req) => {
        const [name] = readTags([req.body?.name]);
        if (name === undefined) throw new Rejection('Enter the tag');
        const { rows: [row] } = await q.query(
            'INSERT INTO supplier_tags (name) VALUES ($1) ON CONFLICT (name_norm) DO NOTHING RETURNING id, name', [name]);
        if (!row) throw new Rejection(`"${name}" is already in the list`, 409);
        return { status: 201, body: row };
    }));

    router.delete('/tags/:tagId', adminOnly, write('Error removing the tag', async (q, req) => {
        const tagId = toPositiveInt(req.params.tagId);
        if (tagId === null) throw new Rejection('invalid tagId');
        const { rowCount } = await q.query('DELETE FROM supplier_tags WHERE id = $1', [tagId]);
        if (rowCount === 0) throw new Rejection('That tag is not in the list', 404);
        // suppliers that already carry it keep it: it just stops being offered
        return { body: { ok: true } };
    }));

    router.post('/adopt', write('Error linking the supplier', async (q, req) => {
        const name = trimText(req.body?.name);
        if (typeof name !== 'string' || name === '' || name.length > MAX_NAME) throw new Rejection(`Name is required and up to ${MAX_NAME} characters`);
        // `supplier_id` = "same as this one": link to an existing supplier instead of creating another
        const chosen = req.body.supplier_id === undefined ? null : toPositiveInt(req.body.supplier_id);
        if (req.body.supplier_id !== undefined && chosen === null) throw new Rejection('supplier_id must be a positive integer');

        // only a name really written on a line with no supplier can be adopted: this links what exists,
        // it isn't a way to invent suppliers (creating one is for that)
        const { rows: [found] } = await q.query(
            `SELECT count(*)::int AS n FROM purchases WHERE supplier_id IS NULL AND supplier_text = $1`, [name]);
        if (found.n === 0) throw new Rejection('No line without a catalog supplier carries that name', 404);

        let supplier, created = false;
        if (chosen !== null) {
            supplier = await existing(q, chosen, { lock: true }).catch(() => { throw new Rejection('That supplier is not in the catalog', 404); });
        } else {
            // an existing one with the same name (any case) or alias is used: another would be a duplicate
            const other = await clash(q, name);
            if (other) supplier = await existing(q, other.id, { lock: true });
            else {
                ({ rows: [supplier] } = await q.query('INSERT INTO suppliers (name) VALUES ($1) RETURNING id, name', [name]));
                created = true;
            }
        }
        // "same one": the book's name becomes an alias, so the next book carrying it links by itself
        if (!created) await addAlias(q, supplier, name, 'equivalence', req.user.id);
        const { purchases } = await linkName(q, supplier.id, name);
        return { status: created ? 201 : 200, body: { id: supplier.id, name: supplier.name, linked: purchases, created } };
    }));

    router.post('/:id/merge', adminOnly, write('Error merging the suppliers', async (q, req) => {
        const sourceId = idOf(req), targetId = toPositiveInt(req.body?.into);
        if (targetId === null) throw new Rejection('into must be the id of the supplier that stays');
        if (targetId === sourceId) throw new Rejection('A supplier cannot be merged into itself');
        // always lock in the same order so two crossed merges don't wait on each other
        const [lower, higher] = [sourceId, targetId].sort((a, b) => a - b);
        await existing(q, lower, { lock: true });
        await existing(q, higher, { lock: true });
        const source = await existing(q, sourceId), target = await existing(q, targetId);

        const moved = {};
        for (const table of ['purchases', 'invoices', 'movements']) {
            moved[table] = (await q.query(`UPDATE ${table} SET supplier_id = $2 WHERE supplier_id = $1`, [sourceId, targetId])).rowCount;
        }
        await q.query('UPDATE supplier_aliases SET supplier_id = $2 WHERE supplier_id = $1', [sourceId, targetId]);
        await q.query('UPDATE supplier_contacts SET supplier_id = $2 WHERE supplier_id = $1', [sourceId, targetId]);
        // an RFC belongs to one supplier: free the vanishing one's, and the survivor inherits it if it had none
        await q.query('UPDATE suppliers SET rfc = NULL WHERE id = $1', [sourceId]);
        if (target.rfc === null && source.rfc !== null) await q.query('UPDATE suppliers SET rfc = $2 WHERE id = $1', [targetId, source.rfc]);
        // tags of the vanishing one move over, no repeats, up to the cap
        const joined = [...target.tags];
        for (const t of source.tags) if (!joined.some(j => j.toLowerCase() === t.toLowerCase())) joined.push(t);
        await q.query('UPDATE suppliers SET tags = $2 WHERE id = $1', [targetId, joined.slice(0, MAX_TAGS)]);
        // its name becomes an alias of the survivor so books carrying it keep linking
        await q.query('DELETE FROM supplier_aliases WHERE supplier_id = $1 AND alias_norm = normalize_supplier($2)', [targetId, target.name]);
        await addAlias(q, target, source.name, 'merge', req.user.id);
        await q.query('DELETE FROM suppliers WHERE id = $1', [sourceId]);
        return { body: { id: targetId, name: target.name, moved } };
    }));

    const archive = (archived, message) => write(message, async (q, req) => {
        const id = idOf(req);
        await existing(q, id, { lock: true });
        await q.query(`UPDATE suppliers SET archived_at = ${archived ? 'COALESCE(archived_at, now())' : 'NULL'} WHERE id = $1`, [id]);
        return { body: { id, archived } };
    });
    router.post('/:id/archive', adminOnly, archive(true, 'Error archiving the supplier'));
    router.post('/:id/unarchive', adminOnly, archive(false, 'Error restoring the supplier'));

    router.delete('/:id', adminOnly, write('Error deleting the supplier', async (q, req) => {
        const id = idOf(req);
        const p = await existing(q, id, { lock: true });
        const { rows: [links] } = await q.query(`
            SELECT (SELECT count(*) FROM purchases WHERE supplier_id = $1)::int AS purchases,
                   (SELECT count(*) FROM invoices WHERE supplier_id = $1)::int AS invoices,
                   (SELECT count(*) FROM movements WHERE supplier_id = $1)::int AS movements`, [id]);
        // movements keep only the id: deleting one with history would lose who supplied a stock-in
        if (links.purchases + links.invoices + links.movements > 0) {
            throw new Rejection(`"${p.name}" has linked history: merge it into another supplier or archive it`, 409, { links });
        }
        await q.query('DELETE FROM suppliers WHERE id = $1', [id]);   // its aliases go with it (ON DELETE CASCADE)
        return { body: { ok: true } };
    }));

    return router;
};

module.exports.resolveSupplier = resolveSupplier;
