const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');

// Purchase books: dashboard by period and bringing descriptions into the catalog.
//
// The fake database has two halves. Reads return the row PostgreSQL would build (pg types: counts as numbers,
// numeric as text) and only paginate the detail; money is never recomputed in JS. Rules that PostgreSQL runs
// are covered with assertions on the SQL. Writes (link, bring, unlink) keep state in memory, because what
// matters there depends on the previous state: linking the same description twice means something else if it
// already belonged to another item, and a ROLLBACK only shows if there was something to undo.

// Mimics normalize_description() ONLY inside the fake. That the server does not normalize in JS is checked below:
// the arguments arrive raw.
const normalize = s => String(s).replace(/\s+/g, ' ').trim().toUpperCase();

function emptyReading() {
    return {
        books: [],
        period: { first_book: null, last_book: null, books: 0 },
        summary: {
            purchases: 0, no_amount: 0, notes: 0, amount: null, suppliers: 0,
            first_date: null, last_date: null, possible_duplicates: 0, dates_to_review: 0,
        },
        coverage: {
            with_stock: { purchases: 0, amount: null },
            no_stock: { purchases: 0, amount: null },
            unlinked: { purchases: 0, amount: null, descriptions: 0 },
            in_inventory: { purchases: 0, amount: null },
        },
        monthly_series: [],
        breakdown: [],
        total: 0,
        detail: [],
        groups: [],
    };
}

const LINKED_PRODUCT = {
    id: 1060, code: 'WELD-NOZZLE-5_8', name: 'Nozzle 5/8 T',
    control_type: 'no_balance', alias_id: 12, alias_origin: 'manual',
};

function line(extra = {}) {
    return {
        id: 1, book: { id: 1, file: 'Monthly purchases (AGOSTO).xlsx', period: '2025-08' },
        sheet: '11 Aug to 15 Aug', cell: 'C9', type: 'purchase',
        date: '2025-08-11', date_status: 'explicit date', date_to_review: false,
        description: 'TOBERA 5/8" T/ACME ROSCADA',
        quantity: '5.000', unit_price: '91.380', amount: '456.900000',
        supplier: 'ACME TOOLS', normalized_supplier: 'ACME TOOLS', folio: 'R799',
        requester: 'JD', note: 'SOLICITUD POR STOCK MINIMO',
        possible_duplicate: false, in_inventory: true, product: { ...LINKED_PRODUCT },
        ...extra,
    };
}

function readingWithData() {
    const data = emptyReading();
    data.books = [
        { id: 1, file: 'Monthly (AGOSTO).xlsx', period: '2025-08', lines: 93, no_amount: 0, notes: 0,
          amount: '5144.780000', first_date: '2025-08-11', last_date: '2025-08-29' },
        { id: 5, file: 'Monthly (DICIEMBRE).xlsx', period: '2025-12', lines: 0, no_amount: 2, notes: 1,
          amount: null, first_date: null, last_date: null },
    ];
    data.period = { first_book: '2025-08', last_book: '2026-08', books: 13 };
    data.summary = {
        purchases: 2221, no_amount: 5, notes: 1, amount: '152177.610000', suppliers: 25,
        first_date: '2025-08-11', last_date: '2026-08-11', possible_duplicates: 28, dates_to_review: 33,
    };
    data.coverage = {
        with_stock: { purchases: 306, amount: '7711.970000' },
        no_stock: { purchases: 662, amount: '82604.940000' },
        unlinked: { purchases: 1253, amount: '61860.700000', descriptions: 986 },
        in_inventory: { purchases: 572, amount: '72535.950000' },
    };
    data.monthly_series = [
        { period: '2025-08', purchases: 93, amount: '5144.780000' },
        { period: '2025-12', purchases: 0, amount: null },
    ];
    data.breakdown = [
        { key: '25', name: 'ACME TOOLS', purchases: 1263, amount: '51763.120000', as_typed: false },
        { key: null, name: 'GAS AND WELD SUPPLY', purchases: 3, amount: '900.000000', as_typed: true },
        { key: null, name: 'No supplier', purchases: 3, amount: null, as_typed: true },
    ];
    data.total = 2;
    data.detail = [
        line(),
        line({ id: 2, cell: 'C10', type: 'no_amount', date: null, date_status: 'month identified; day pending',
               date_to_review: true, description: 'CONCEPTO POR IDENTIFICAR', unit_price: null, amount: null,
               supplier: null, normalized_supplier: null, folio: null, requester: null, note: null,
               in_inventory: false, product: null }),
    ];
    data.groups = [
        { description_norm: 'ESCOBA PEÑOLERA', description: 'Escoba peñolera', variants: 2, purchases: 6, months: 5,
          first_date: '2025-09-09', last_date: '2026-07-07', quantity: '28.000', amount: '4436.000000',
          last_price: '170.000', suppliers: ['CLEAN SUPPLIES'], recurring: true,
          suggested: { daily_consumption: '0.093', interval_days: '60.2', minimum: '5.600' }, product: null },
        { description_norm: 'GUANTE', description: 'GUANTE', variants: 1, purchases: 3, months: 3,
          first_date: '2026-06-01', last_date: '2026-06-30', quantity: null, amount: null,
          last_price: null, suppliers: [], recurring: true, suggested: null, product: { ...LINKED_PRODUCT } },
    ];
    return data;
}

async function environment(t, options = {}) {
    const queries = [];
    const reading = options.reading ?? emptyReading();
    const purchases = options.purchases ?? [
        { description: 'TOBERA 5/8" T/ACME ROSCADA', type: 'purchase', amount: '456.900000' },
        { description: 'tobera 5/8"  t/acme roscada', type: 'purchase', amount: '91.380000' },
        { description: 'TOBERA 5/8" T/ACME ROSCADA', type: 'no_amount', amount: null },
        { description: 'DISCO DE CORTE 4 1/2', type: 'purchase', amount: '30.000000' },
        { description: 'ESCOBA PEÑOLERA', type: 'purchase', amount: '170.000000' },
    ];
    const products = [
        { id: 1, code: 'WELD-NOZZLE', name: 'Nozzle' },
        { id: 2, code: 'ABR-DISC', name: 'Disc' },
    ];
    const categories = [4];
    const aliases = [{ id: 12, product_id: 2, alias: 'DISCO DE CORTE 4 1/2', origin: 'manual', created_by: null }];
    let nextAlias = 100, nextProduct = 700;
    // What was inserted inside the open transaction, so it can be rolled back.
    let transaction = null;
    const released = { n: 0 };

    const aliasOf = text => aliases.find(a => normalize(a.alias) === normalize(text));

    async function query(sql, args = []) {
        queries.push({ sql, args });
        if (options.failure) throw new Error('Persistence failure');

        if (sql === 'BEGIN') { transaction = { products: [], aliases: [] }; return { rows: [] }; }
        if (sql === 'COMMIT') { transaction = null; return { rows: [] }; }
        if (sql === 'ROLLBACK') {
            if (transaction) {
                for (const p of transaction.products) products.splice(products.indexOf(p), 1);
                for (const a of transaction.aliases) aliases.splice(aliases.indexOf(a), 1);
            }
            transaction = null;
            return { rows: [] };
        }

        // --- Dashboard and book reads ----------------------------------
        // LIMIT NULL means "no limit" (that is how the with_suggestion status asks for the groups).
        const page = list => list.slice(args.at(-1), args.at(-2) === null ? undefined : args.at(-1) + args.at(-2));
        // Candidates for suggesting a link: the linked forms and the catalog names.
        if (/'link' AS via/.test(sql)) {
            const links = aliases.map(a => {
                const p = products.find(x => x.id === a.product_id);
                return { text: normalize(a.alias), via: 'link', id: p.id, code: p.code, name: p.name };
            });
            return { rows: [...links, ...products.map(p => ({ text: p.name, via: 'name', id: p.id, code: p.code, name: p.name }))] };
        }
        if (/FROM purchase_books l\s+LEFT JOIN purchases c/.test(sql)) {
            return { rows: structuredClone(reading.books) };
        }
        if (/WITH books AS/.test(sql)) {
            const { period, summary, coverage, monthly_series, breakdown } = structuredClone(reading);
            return { rows: [{ period, summary, coverage, monthly_series, breakdown }] };
        }
        if (/AS detail/.test(sql)) {
            return { rows: [{ total: reading.total, detail: page(structuredClone(reading.detail)) }] };
        }
        if (/AS purchase_groups/.test(sql)) {
            return { rows: [{ total: reading.total, purchase_groups: page(structuredClone(reading.groups)) }] };
        }

        // --- Link, bring, unlink ----------------------------------------
        if (/FROM purchases\s+WHERE description_norm = normalize_description\(\$1\)/.test(sql)) {
            const own = purchases.filter(c => normalize(c.description) === normalize(args[0]));
            const bought = own.filter(c => c.type === 'purchase');
            const amount = bought.length
                ? bought.reduce((s, c) => s + Number(c.amount), 0).toFixed(6)
                : null;
            return { rows: [{ lines: own.length, purchases: bought.length, amount }] };
        }
        if (/FROM product_aliases a\s+JOIN products p/.test(sql)) {
            const a = aliasOf(args[0]);
            const p = a && products.find(x => x.id === a.product_id);
            return { rows: p ? [{ alias_id: a.id, id: p.id, code: p.code, name: p.name }] : [] };
        }
        if (/WITH inserted AS/.test(sql)) {
            const [productId, alias, createdBy] = args;
            if (aliasOf(alias)) return { rows: [] };                     // ON CONFLICT DO NOTHING
            const p = products.find(x => x.id === productId);
            if (!p) throw Object.assign(new Error('fk'), { code: '23503' });
            const a = { id: nextAlias++, product_id: productId, alias, origin: 'manual', created_by: createdBy };
            aliases.push(a);
            return { rows: [{ alias_id: a.id, id: p.id, code: p.code, name: p.name }] };
        }
        if (/INSERT INTO products/.test(sql)) {
            // Quantity and count_pending are not parameters: they are fixed in the SQL. If someone turns them
            // into parameters the fake does not know what to store and the test fails here.
            if (!/VALUES \(\$1, \$2, 0, \$3, \$4, \$5, \$6, \$7, \$8, true\)/.test(sql)) {
                throw new Error(`Unexpected product INSERT: ${sql}`);
            }
            const [code, name, price, location, unit, category_id, control_type, minimum] = args;
            if (products.some(p => p.code === code)) throw Object.assign(new Error('dup'), { code: '23505' });
            if (category_id !== null && !categories.includes(category_id)) {
                throw Object.assign(new Error('fk'), { code: '23503' });
            }
            const p = { id: nextProduct++, code, name, price, location, unit, category_id, control_type,
                        minimum, quantity: 0, count_pending: true };
            products.push(p);
            transaction?.products.push(p);
            return { rows: [{ id: p.id, code, name, unit, category_id, control_type,
                              minimum: minimum === null ? null : minimum.toFixed(3), count_pending: true }] };
        }
        if (/INSERT INTO product_aliases/.test(sql)) {
            if (options.aliasFailure) options.aliasFailure({ aliases, products });
            const [productId, alias, createdBy] = args;
            if (aliasOf(alias)) throw Object.assign(new Error('dup'), { code: '23505' });
            const a = { id: nextAlias++, product_id: productId, alias, origin: 'manual', created_by: createdBy };
            aliases.push(a);
            transaction?.aliases.push(a);
            return { rows: [{ id: a.id }] };
        }
        if (/DELETE FROM product_aliases WHERE id = \$1/.test(sql)) {
            const i = aliases.findIndex(a => a.id === args[0]);
            if (i === -1) return { rows: [], rowCount: 0 };
            aliases.splice(i, 1);
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected query in the fake: ${sql}`);
    }

    const pool = {
        query,
        async connect() { return { query, release() { released.n++; } }; },
    };
    const identity = {
        requireSession: () => (req, res, next) => { req.user = { id: 7, role: options.role ?? 'storekeeper' }; next(); },
        requireRole: (...roles) => (req, res, next) =>
            roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Insufficient role' }),
    };
    const app = createApp(pool, options.realSession ? undefined : identity);
    if (options.parser) app.set('query parser', options.parser);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;

    async function request(route, { method = 'GET', body, raw } = {}) {
        const init = { method };
        if (body !== undefined) {
            init.headers = { 'Content-Type': 'application/json' };
            init.body = raw ? body : JSON.stringify(body);
        }
        const r = await fetch(url + route, init);
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : null };
    }
    const post = (route, body) => request(route, { method: 'POST', body });
    const sqls = () => queries.map(q => q.sql);
    return { request, post, queries, sqls, products, aliases, released, url };
}

// Pulls the twins CTE out to check it does not depend on the period.
function twinsCte(sql) {
    const m = /twins AS \(([\s\S]*?)\), book_lines AS/.exec(sql);
    assert.ok(m, 'the query must define the twins CTE');
    return m[1];
}

const READS = ['/api/purchases/summary', '/api/purchases', '/api/purchases/recurring'];

// ============================================================
//  Session and validation: nothing reaches SQL
// ============================================================

test('no session: 401 on every endpoint before any query, even with invalid data', async t => {
    const e = await environment(t, { realSession: true });
    const cases = [
        ['GET', '/api/purchases/books'],
        ['GET', '/api/purchases/summary?from=bad&group_by=nothing'],
        ['GET', '/api/purchases?status=nothing&book_id=abc'],
        ['GET', '/api/purchases/recurring?page=1e100&only_recurring=maybe'],
        ['POST', '/api/purchases/link', {}],
        ['POST', '/api/purchases/bring', { product: 'x' }],
        ['DELETE', '/api/purchases/links/abc'],
    ];
    for (const [method, route, body] of cases) {
        const r = await e.request(route, { method, body });
        assert.equal(r.status, 401, `${method} ${route}`);
        assert.equal(r.body.error_code, 'no_session');
    }
    assert.equal(e.queries.length, 0);
});

test('from and to: malformed months give 400 without SQL on every read with a period', async t => {
    const e = await environment(t);
    const invalid = [
        'null', 'true', '2026', '202601', '2026-1', '2026-00', '2026-13', '26-01', '2026-01-01',
        ' 2026-01', '2026-01 ', '2026-01\n', '2026/01', "2026-01' OR 1=1--", '２０２６-01',
    ];
    for (const route of READS) {
        for (const field of ['from', 'to']) {
            for (const value of invalid) {
                const r = await e.request(`${route}?${field}=${encodeURIComponent(value)}`);
                assert.equal(r.status, 400, `${route} ${field}=${JSON.stringify(value)}`);
                assert.match(r.body.error, new RegExp(field));
            }
        }
    }
    assert.equal(e.queries.length, 0);
});

for (const parser of ['simple', 'extended']) {
    test(`single-text params: lists and objects give 400 without SQL (parser ${parser})`, async t => {
        const e = await environment(t, { parser });
        const params = {
            '/api/purchases/summary': [['from', '2026-01'], ['to', '2026-02'], ['group_by', 'month']],
            '/api/purchases': [['from', '2026-01'], ['to', '2026-02'], ['book_id', '1'], ['status', 'all'],
                               ['q', 'disc'], ['page', '2']],
            '/api/purchases/recurring': [['from', '2026-01'], ['to', '2026-02'], ['status', 'all'],
                                         ['only_recurring', 'false'], ['page', '2']],
        };
        for (const [route, list] of Object.entries(params)) {
            for (const [field, value] of list) {
                for (const query of [`${field}=${value}&${field}=${value}`, `${field}[]=${value}`, `${field}[x]=${value}`]) {
                    const r = await e.request(`${route}?${query}`);
                    assert.equal(r.status, 400, `${route}?${query}`);
                    assert.equal(r.body.error, `${field} must be a single text`);
                }
            }
        }
        assert.equal(e.queries.length, 0);
    });
}

test('from after to gives 400 without SQL; same month and empty values (unbounded) are accepted', async t => {
    const e = await environment(t);
    for (const route of READS) {
        const r = await e.request(`${route}?from=2026-08&to=2025-08`);
        assert.equal(r.status, 400, route);
        assert.match(r.body.error, /from.*to/);
    }
    assert.equal(e.queries.length, 0);

    const same = await e.request('/api/purchases/summary?from=2026-01&to=2026-01');
    assert.equal(same.status, 200);
    assert.deepEqual(e.queries.at(-1).args, ['2026-01', '2026-01']);

    const empty = await e.request('/api/purchases/summary?from=&to=');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.from, null);
    assert.equal(empty.body.to, null);
    assert.deepEqual(e.queries.at(-1).args, []);
    assert.doesNotMatch(e.queries.at(-1).sql, /l\.period [<>]=/);
});

test('group_by, status and only_recurring outside their list give 400 without SQL', async t => {
    const e = await environment(t);
    const cases = [
        ['/api/purchases/summary', 'group_by', ['', 'Supplier', 'year', 'book DESC', '__proto__', 'toString']],
        ['/api/purchases', 'status', ['', 'All', 'linkeds', 'not linked', '__proto__', 'constructor']],
        // `review` and `duplicate` are states of a line, not of a group.
        ['/api/purchases/recurring', 'status', ['', 'review', 'duplicate', 'hasOwnProperty']],
        ['/api/purchases/recurring', 'only_recurring', ['', 'yes', '1', 'TRUE', 'false ']],
    ];
    for (const [route, field, values] of cases) {
        for (const value of values) {
            const r = await e.request(`${route}?${field}=${encodeURIComponent(value)}`);
            assert.equal(r.status, 400, `${route}?${field}=${JSON.stringify(value)}`);
            assert.match(r.body.error, new RegExp(`^${field} must be`));
        }
    }
    assert.equal(e.queries.length, 0);
});

test('book_id that is not a positive integer gives 400 without SQL; empty does not filter', async t => {
    const e = await environment(t);
    for (const value of ['0', '-1', '1.5', 'abc', '1e400', 'true', ' ']) {
        const r = await e.request(`/api/purchases?book_id=${encodeURIComponent(value)}`);
        assert.equal(r.status, 400, JSON.stringify(value));
        assert.equal(r.body.error, 'book_id must be a positive integer');
    }
    assert.equal(e.queries.length, 0);
    assert.equal((await e.request('/api/purchases?book_id=')).status, 200);
    assert.doesNotMatch(e.queries.at(-1).sql, /c\.book_id = \$/);
});

test('pagination: reuses pageOf and rejects offsets that would lose precision', async t => {
    const e = await environment(t);
    for (const route of ['/api/purchases', '/api/purchases/recurring']) {
        for (const [value, page] of [['0', 1], ['text', 1], ['2.9', 2]]) {
            const r = await e.request(`${route}?page=${value}`);
            assert.equal(r.body.page, page, `${route} page=${value}`);
            assert.deepEqual(e.queries.at(-1).args.slice(-2), [50, (page - 1) * 50]);
        }
        const before = e.queries.length;
        const out = await e.request(`${route}?page=1e100`);
        assert.equal(out.status, 400);
        assert.equal(out.body.error, 'page out of range');
        assert.equal(e.queries.length, before);
    }
});

// ============================================================
//  Reads: SQL and response shape
// ============================================================

test('books: one query, ordered by period, counts only purchases and numerics as text', async t => {
    const data = readingWithData();
    const e = await environment(t, { reading: data });
    const r = await e.request('/api/purchases/books');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, data.books);
    assert.equal(e.queries.length, 1);
    const { sql, args } = e.queries[0];
    assert.deepEqual(args, []);
    assert.match(sql, /count\(c\.id\) FILTER \(WHERE c\.type = 'purchase'\)::int\s+AS lines/);
    assert.match(sql, /\(sum\(c\.amount\) FILTER \(WHERE c\.type = 'purchase'\)\)::text AS amount/);
    assert.match(sql, /to_char\(min\(c\.date\)/);
    assert.match(sql, /ORDER BY l\.period, l\.id/);
});

test('summary: period by book month, parameterized and in a single statement', async t => {
    const data = readingWithData();
    const e = await environment(t, { reading: data });
    const r = await e.request('/api/purchases/summary?from=2025-08&to=2026-08');
    assert.equal(r.status, 200);
    assert.equal(e.queries.length, 1);
    const { sql, args } = e.queries[0];
    assert.deepEqual(args, ['2025-08', '2026-08']);
    assert.doesNotMatch(sql, /2025-08|2026-08/);
    // The filter is against the book's month, never the line's date.
    assert.match(sql, /l\.period >= \$1 AND l\.period <= \$2/);
    assert.doesNotMatch(sql, /c\.date\s*[<>]=?/);
    assert.deepEqual(r.body, {
        from: '2025-08', to: '2026-08', group_by: 'supplier',
        period: data.period, summary: data.summary, coverage: data.coverage,
        monthly_series: data.monthly_series, breakdown: data.breakdown,
    });
});

test('summary: linked by alias_norm, coverage by control_type and twins over the whole table', async t => {
    const e = await environment(t);
    await e.request('/api/purchases/summary?from=2025-08&to=2025-09');
    const { sql } = e.queries[0];
    assert.match(sql, /LEFT JOIN product_aliases a ON a\.alias_norm = c\.description_norm/);
    assert.match(sql, /alias_id IS NOT NULL AND control_type <> 'no_balance'/);
    assert.match(sql, /alias_id IS NOT NULL AND control_type = 'no_balance'/);
    assert.match(sql, /count\(DISTINCT description_norm\) FILTER \(WHERE alias_id IS NULL\)/);
    assert.match(sql, /FILTER \(WHERE movement_id IS NOT NULL\)/);
    assert.match(sql, /count\(DISTINCT COALESCE\(normalized_supplier, supplier_text\)\)/);
    assert.match(sql, /date_status NOT IN \('explicit date', 'date inherited from block'\)/);

    // Twins over the WHOLE table: no period or book parameters.
    const twins = twinsCte(sql);
    assert.doesNotMatch(twins, /\$\d|purchase_books|period/);
    assert.match(twins, /count\(\*\) OVER \(PARTITION BY date, supplier_text, folio, description_norm,\s+quantity, unit_price\) > 1/);
    assert.match(twins, /FROM purchases\s+WHERE type = 'purchase'/);

    // A month with no book does not show up: the series comes from the period's books.
    assert.match(sql, /FROM books l\s+LEFT JOIN period_purchases r ON r\.book_id = l\.id/);
});

test('summary: each grouping uses its key and as_typed only for supplier', async t => {
    const e = await environment(t, { reading: readingWithData() });
    const expected = {
        supplier: [/supplier_id::text AS key/, /COALESCE\(normalized_supplier, supplier_text, 'No supplier'\) AS name/,
                   /supplier_id IS NULL AS as_typed/],
        category: [/'unlinked'/, /'uncategorized'/, /'Not linked to catalog'/, /'Uncategorized'/, /false AS as_typed/],
        month: [/period::text AS key, period::text AS name/, /false AS as_typed/],
        book: [/book_id::text AS key, file AS name/, /false AS as_typed/],
    };
    for (const [filter, groupBy] of [['', 'supplier'], ...Object.keys(expected).map(a => [`?group_by=${a}`, a])]) {
        const r = await e.request(`/api/purchases/summary${filter}`);
        assert.equal(r.status, 200);
        assert.equal(r.body.group_by, groupBy);
        const { sql } = e.queries.at(-1);
        for (const pattern of expected[groupBy]) assert.match(sql, pattern, `${groupBy}: ${pattern}`);
        assert.match(sql, /ORDER BY amount DESC NULLS LAST, name, key NULLS LAST/);
        assert.deepEqual(e.queries.at(-1).args, []);
    }
});

for (const [kind, amount, quantity] of [
    ['missing amount', null, null],
    ['recorded zero', '0.000000', '0.000'],
    ['amount above the JS safe integer', '9999999999980000000.000001', '999999999.999'],
]) {
    test(`numerics as text (${kind}): reach the client intact`, async t => {
        const data = readingWithData();
        data.summary.amount = amount;
        data.coverage.unlinked.amount = amount;
        data.monthly_series[0].amount = amount;
        data.breakdown[0].amount = amount;
        data.detail[0] = line({ quantity, amount });
        data.groups[0].amount = amount;
        data.groups[0].quantity = quantity;
        const e = await environment(t, { reading: data });
        const summary = (await e.request('/api/purchases/summary')).body;
        assert.equal(summary.summary.amount, amount);
        assert.equal(summary.coverage.unlinked.amount, amount);
        assert.equal(summary.monthly_series[0].amount, amount);
        assert.equal(summary.breakdown[0].amount, amount);
        const list = (await e.request('/api/purchases')).body;
        assert.equal(list.lines[0].amount, amount);
        assert.equal(list.lines[0].quantity, quantity);
        const groups = (await e.request('/api/purchases/recurring')).body;
        assert.equal(groups.groups[0].amount, amount);
        assert.equal(groups.groups[0].quantity, quantity);

        const [summarySql, listSql, groupsSql] = e.queries.map(q => q.sql);
        assert.match(summarySql, /'amount', \(sum\(amount\) FILTER \(WHERE type = 'purchase'\)\)::text/);
        assert.match(summarySql, /'amount', amount::text/);
        for (const field of ['quantity', 'unit_price', 'amount']) {
            assert.match(listSql, new RegExp(`'${field}', ${field}::text`));
        }
        for (const field of ['quantity', 'amount', 'last_price']) {
            assert.match(groupsSql, new RegExp(`'${field}', ${field}::text`));
        }
        // And no COALESCE that turns "unknown" into zero.
        for (const sql of [summarySql, listSql, groupsSql]) {
            assert.doesNotMatch(sql, /COALESCE\(\s*\(?(?:sum|amount|quantity|unit_price)/i);
        }
    });
}

test('period without books: empty lists, null amounts and zero purchases', async t => {
    const e = await environment(t);
    const r = await e.request('/api/purchases/summary?from=2030-01');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.period, emptyReading().period);
    assert.deepEqual(r.body.summary, emptyReading().summary);
    assert.deepEqual(r.body.coverage, emptyReading().coverage);
    assert.deepEqual(r.body.monthly_series, []);
    assert.deepEqual(r.body.breakdown, []);
    const list = await e.request('/api/purchases?from=2030-01');
    assert.deepEqual(list.body, { total: 0, page: 1, pages: 0, lines: [] });
});

test('list: book reading order, parameterized filters and escaped search', async t => {
    const e = await environment(t, { reading: readingWithData() });
    const r = await e.request(`/api/purchases?from=2025-08&to=2025-09&book_id=3&status=unlinked&q=${encodeURIComponent('50%_x')}&page=2`);
    assert.equal(r.status, 200);
    assert.equal(e.queries.length, 1);
    const { sql, args } = e.queries[0];
    assert.deepEqual(args, ['2025-08', '2025-09', 3, '%50\\%\\_x%', 50, 50]);
    assert.match(sql, /l\.period >= \$1 AND l\.period <= \$2 AND c\.book_id = \$3 AND a\.id IS NULL/);
    for (const column of ['c.description', 'c.folio', 'c.supplier_text', 'c.requester', 'c.note']) {
        assert.ok(sql.includes(`${column} ILIKE $4 ESCAPE '\\'`), column);
    }
    assert.match(sql, /ORDER BY period, book_id, sheet_order, row_num, id\s+LIMIT \$5 OFFSET \$6/);
    assert.match(sql, /'in_inventory', movement_id IS NOT NULL/);
    assert.match(sql, /'supplier', supplier_text, 'normalized_supplier', normalized_supplier/);
    assert.equal(r.body.page, 2);
    assert.equal(r.body.total, 2);
    assert.equal(r.body.pages, 1);
});

test('list: each status adds its condition; twins are still computed over the whole table', async t => {
    const e = await environment(t);
    const count = (sql, text) => sql.split(text).length - 1;
    const review = "date_status NOT IN ('explicit date', 'date inherited from block')";
    const duplicate = 'COALESCE(g.possible_duplicate, false)';
    for (const [status, linked, expectedReview, expectedDuplicate] of [
        ['all', null, 1, 1], ['unlinked', 'a.id IS NULL', 1, 1], ['linked', 'a.id IS NOT NULL', 1, 1],
        ['review', null, 2, 1], ['duplicate', null, 1, 2],
    ]) {
        const r = await e.request(status === 'all' ? '/api/purchases' : `/api/purchases?status=${status}`);
        assert.equal(r.status, 200, status);
        const { sql } = e.queries.at(-1);
        // Once in the SELECT (each line's flag) and once in the WHERE if it filters.
        assert.equal(count(sql, review), expectedReview, `${status}: date to review`);
        assert.equal(count(sql, duplicate), expectedDuplicate, `${status}: duplicate`);
        assert.equal(/a\.id IS (NOT )?NULL/.test(sql), linked !== null, `${status}: linked`);
        if (linked) assert.ok(sql.includes(linked));
        assert.doesNotMatch(twinsCte(sql), /\$\d|purchase_books/);
    }
});

test('list: 57 lines, 50 per page, and a page past the detail is empty', async t => {
    const data = emptyReading();
    data.total = 57;
    data.detail = Array.from({ length: 57 }, (_, i) => line({ id: i + 1 }));
    const e = await environment(t, { reading: data });
    const pages = [];
    for (const page of [1, 2, 3]) {
        const { status, body } = await e.request(`/api/purchases?page=${page}`);
        assert.equal(status, 200);
        assert.equal(body.total, 57);
        assert.equal(body.page, page);
        assert.equal(body.pages, 2);
        pages.push(body.lines);
    }
    assert.deepEqual(pages.map(p => p.length), [50, 7, 0]);
    assert.deepEqual(pages.flat().map(r => r.id), Array.from({ length: 57 }, (_, i) => i + 1));
    assert.equal(e.queries.length, 3);
});

test('list: line shape of the contract; product null when there is no link', async t => {
    const data = readingWithData();
    const e = await environment(t, { reading: data });
    const { body } = await e.request('/api/purchases');
    assert.deepEqual(body.lines, data.detail);
    assert.deepEqual(Object.keys(body.lines[0]), [
        'id', 'book', 'sheet', 'cell', 'type', 'date', 'date_status', 'date_to_review', 'description',
        'quantity', 'unit_price', 'amount', 'supplier', 'normalized_supplier', 'folio', 'requester',
        'note', 'possible_duplicate', 'in_inventory', 'product',
    ]);
    assert.equal(body.lines[1].product, null);
    const { sql } = e.queries[0];
    for (const field of ['id', 'code', 'name', 'control_type', 'alias_id', 'alias_origin']) {
        assert.match(sql, new RegExp(`'${field}', `), field);
    }
    assert.match(sql, /CASE WHEN alias_id IS NULL THEN NULL ELSE json_build_object\(/);
});

test('recurring: unlinked and recurring only by default, with the criteria visible', async t => {
    const data = readingWithData();
    const e = await environment(t, { reading: data });
    const r = await e.request('/api/purchases/recurring');
    assert.equal(r.status, 200);
    // Neither resembles anything in the fake catalog: no suggestion.
    assert.deepEqual(r.body, {
        total: 2, page: 1, pages: 1, criteria: { min_purchases: 3, min_months: 3 },
        groups: data.groups.map(g => ({ ...g, suggestion: null })),
    });
    const { sql, args } = e.queries[0];
    assert.deepEqual(args, [50, 0]);
    // Purchases only: no-amount rows and notes do not say how much was bought.
    assert.match(sql, /WHERE c\.type = 'purchase'/);
    assert.match(sql, /WHERE g\.alias_id IS NULL AND g\.purchases >= 3 AND g\.months >= 3/);
    assert.match(sql, /count\(DISTINCT period\)::int AS months/);
    assert.match(sql, /\(g\.purchases >= 3 AND g\.months >= 3\) AS recurring/);
    assert.match(sql, /ORDER BY amount DESC NULLS LAST, purchases DESC, description, description_norm\s+LIMIT \$1 OFFSET \$2/);

    // The last groups query: the candidates query for link suggestions may come after.
    const groupsQuery = () => e.queries.findLast(q => /AS purchase_groups/.test(q.sql));
    const all = await e.request('/api/purchases/recurring?status=all&only_recurring=false&from=2025-08');
    assert.equal(all.status, 200);
    const other = groupsQuery();
    assert.deepEqual(other.args, ['2025-08', 50, 0]);
    assert.doesNotMatch(other.sql, /g\.alias_id IS/);
    assert.equal(other.sql.split('g.purchases >= 3 AND g.months >= 3').length - 1, 1, 'only in the recurring column');

    await e.request('/api/purchases/recurring?status=linked');
    assert.match(groupsQuery().sql, /WHERE g\.alias_id IS NOT NULL AND g\.purchases >= 3/);
});

test('recurring with_suggestion: only unlinked ones that have one, paginated after deciding it', async t => {
    const data = readingWithData();
    const group = (description_norm, extra = {}) => ({
        description_norm, description: description_norm, variants: 1, purchases: 3, months: 3,
        first_date: null, last_date: null, quantity: null, amount: '10.000000', last_price: null,
        suppliers: [], recurring: true, suggested: null, product: null, ...extra,
    });
    // The fake has the link 'DISCO DE CORTE 4 1/2' -> ABR-DISC.
    data.groups = [
        group('DISCO DE CORTE 4 1/2"'),                         // same form, other punctuation
        group('DISCO DE CORTE 7"'),                             // other measure: no suggestion
        group('ESCOBA PEÑOLERA'),                               // nothing alike
        group('GUANTE', { product: { ...LINKED_PRODUCT } }),    // already linked: never a suggestion
    ];
    data.total = 4;
    const e = await environment(t, { reading: data });
    const r = await e.request('/api/purchases/recurring?status=with_suggestion');
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.pages, 1);
    assert.equal(r.body.groups.length, 1);
    assert.equal(r.body.groups[0].description_norm, 'DISCO DE CORTE 4 1/2"');
    assert.equal(r.body.groups[0].suggestion.product.code, 'ABR-DISC');
    assert.equal(r.body.groups[0].suggestion.reason, 'same_form');
    // In SQL it filters like unlinked and with no limit: the page is built afterwards.
    const sql = e.queries.find(q => /AS purchase_groups/.test(q.sql));
    assert.match(sql.sql, /WHERE g\.alias_id IS NULL/);
    assert.deepEqual(sql.args.slice(-2), [null, 0]);
});

test('recurring: most frequent form, last price and suggested minimum with the 45-minimums method', async t => {
    const e = await environment(t);
    await e.request('/api/purchases/recurring');
    const { sql } = e.queries[0];
    // Most frequent; on a tie, the most recent.
    assert.match(sql, /ORDER BY description_norm, times DESC, last_date DESC NULLS LAST,\s+last_book DESC, last_id DESC/);
    assert.match(sql, /count\(DISTINCT description\)::int AS variants/);
    // Book before date: a line with no day from a later book is more recent than a dated one from an earlier book.
    assert.match(sql, /\(array_agg\(unit_price ORDER BY period DESC, date DESC NULLS LAST[\s\S]*?FILTER \(WHERE unit_price IS NOT NULL\)\)\[1\] AS last_price/);
    // Only with 3 purchases and 60 days; otherwise null. No inventing a minimum.
    // Without the day of every purchase the interval is unknown: no suggestion.
    assert.match(sql, /CASE WHEN purchases >= 3 AND days >= 60\s+AND quantity IS NOT NULL AND no_day = 0/);
    assert.match(sql, /count\(\*\) FILTER \(WHERE date IS NULL\)::int AS no_day/);
    assert.match(sql, /'daily_consumption', round\(quantity \/ days, 3\)::text/);
    assert.match(sql, /'interval_days', round\(days::numeric \/ \(purchases - 1\), 1\)::text/);
    assert.match(sql, /'minimum', round\(quantity \/ days \* \(days::numeric \/ \(purchases - 1\)\), 3\)::text/);
    assert.match(sql, /g\.last_date - g\.first_date AS days/);
});

test('persistence failure: 500 with each read\'s message', async t => {
    t.mock.method(console, 'error', () => {});
    const e = await environment(t, { failure: true });
    for (const [route, error] of [
        ['/api/purchases/books', 'Error querying the purchase books'],
        ['/api/purchases/summary', 'Error querying the purchases summary'],
        ['/api/purchases', 'Error querying the purchases'],
        ['/api/purchases/recurring', 'Error querying the recurring purchases'],
    ]) {
        const r = await e.request(route);
        assert.equal(r.status, 500, route);
        // The 500 carries the request id (the X-Request-Id one), to find it in the log.
        assert.deepEqual(Object.keys(r.body).sort(), ['error', 'id'], route);
        assert.equal(r.body.error, error, route);
    }
});

// ============================================================
//  Link
// ============================================================

test('link: invalid body gives 400 without SQL', async t => {
    const e = await environment(t);
    const cases = [
        [{}, 'description is required'],
        [{ description: '', product_id: 1 }, 'description is required'],
        [{ description: '   ', product_id: 1 }, 'description is required'],
        [{ description: 5, product_id: 1 }, 'description is required'],
        [{ description: ['TOBERA'], product_id: 1 }, 'description is required'],
        [{ description: 'TOBERA' }, 'product_id must be a positive integer'],
        [{ description: 'TOBERA', product_id: 0 }, 'product_id must be a positive integer'],
        [{ description: 'TOBERA', product_id: -2 }, 'product_id must be a positive integer'],
        [{ description: 'TOBERA', product_id: 1.5 }, 'product_id must be a positive integer'],
        [{ description: 'TOBERA', product_id: 'abc' }, 'product_id must be a positive integer'],
        [{ description: 'TOBERA', product_id: true }, 'product_id must be a positive integer'],
        [[], 'description is required'],
    ];
    for (const [body, error] of cases) {
        const r = await e.post('/api/purchases/link', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.error, error);
    }
    // Without a JSON body Express 5 leaves req.body empty: not a 500 either.
    const noBody = await e.request('/api/purchases/link', { method: 'POST' });
    assert.equal(noBody.status, 400);
    assert.equal(e.queries.length, 0);
});

test('link: 404 if no purchase has that normalized form, without creating the equivalence', async t => {
    const e = await environment(t);
    const r = await e.post('/api/purchases/link', { description: 'SOMETHING NOBODY BOUGHT', product_id: 1 });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'No purchase has that description' });
    assert.equal(e.queries.length, 1);
    assert.equal(e.aliases.length, 1);
    assert.equal(e.sqls().some(s => /INSERT/.test(s)), false);
});

test('link: 201 with the session as author even if the body sends one; 200 if already linked; 409 if it belongs to another', async t => {
    const e = await environment(t);
    const description = '  tobera 5/8"   t/acme ROSCADA ';
    const r = await e.post('/api/purchases/link', {
        description, product_id: 1, user_id: 999, created_by: 999, origin: 'purchases',
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, {
        alias_id: 100, product: { id: 1, code: 'WELD-NOZZLE', name: 'Nozzle' },
        // Only purchase lines: the no-amount one gets linked but does not add up.
        purchases: 2, amount: '548.280000',
    });

    // Normalization belongs to Postgres: the server sends the text untouched (except edge spaces) and
    // compares with normalize_description().
    const [backing, insert] = e.queries;
    assert.deepEqual(backing.args, [description.trim()]);
    assert.match(backing.sql, /WHERE description_norm = normalize_description\(\$1\)/);
    assert.match(backing.sql, /count\(\*\) FILTER \(WHERE type = 'purchase'\)::int AS purchases/);
    assert.match(insert.sql, /VALUES \(\$1, \$2, 'manual', \$3\)\s+ON CONFLICT \(alias_norm\) DO NOTHING/);
    assert.deepEqual(insert.args, [1, description.trim(), 7]);
    const created = e.aliases.find(a => a.id === 100);
    assert.equal(created.created_by, 7);
    assert.equal(created.origin, 'manual');

    const again = await e.post('/api/purchases/link', { description: 'TOBERA 5/8" T/ACME ROSCADA', product_id: 1 });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, {
        already_linked: true, alias_id: 100, product: { id: 1, code: 'WELD-NOZZLE', name: 'Nozzle' },
        purchases: 2, amount: '548.280000',
    });

    const foreign = await e.post('/api/purchases/link', { description: 'Tobera 5/8" t/acme roscada', product_id: 2 });
    assert.equal(foreign.status, 409);
    assert.deepEqual(foreign.body, {
        error: 'That description is already linked to WELD-NOZZLE',
        error_code: 'description_linked',
        product: { id: 1, code: 'WELD-NOZZLE', name: 'Nozzle' },
    });
    assert.equal(e.aliases.length, 2);
});

test('link: nonexistent product (23503) gives 404', async t => {
    const e = await environment(t);
    const r = await e.post('/api/purchases/link', { description: 'ESCOBA PEÑOLERA', product_id: 9999 });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { error: 'The product does not exist' });
    assert.equal(e.aliases.length, 1);
});

// ============================================================
//  Bring to the catalog
// ============================================================

const validNew = (extra = {}) => ({
    code: 'clean-broom', name: 'Escoba peñolera', unit: 'Piece', category_id: 4,
    control_type: 'stock', minimum: '5', price: '170.00', location: '  Shelf 3 ',
    ...extra,
});

test('bring: new-product validation is the same as POST /api/products, giving 400 without SQL', async t => {
    const e = await environment(t);
    const invalid = [
        { code: '' }, { code: '   ' }, { code: 7 }, { name: '' }, { name: null },
        { code: 'X'.repeat(51) }, { name: 'N'.repeat(201) }, { location: 'U'.repeat(101) }, { unit: 'u'.repeat(21) },
        { price: -1 }, { price: 'expensive' }, { price: true }, { category_id: 0 }, { category_id: 'abc' }, { category_id: 2.5 },
    ];
    for (const change of invalid) {
        const product = validNew(change);
        const bring = await e.post('/api/purchases/bring', { description: 'ESCOBA PEÑOLERA', product });
        const create = await e.post('/api/products', product);
        assert.equal(bring.status, 400, JSON.stringify(change));
        assert.equal(create.status, 400, JSON.stringify(change));
        // A single validation: same message through both doors of the catalog.
        assert.equal(bring.body.error, create.body.error, JSON.stringify(change));
    }
    for (const [body, error] of [
        [{ product: validNew() }, 'description is required'],
        [{ description: '', product: validNew() }, 'description is required'],
        [{ description: 'ESCOBA PEÑOLERA' }, 'product is required'],
        [{ description: 'ESCOBA PEÑOLERA', product: null }, 'product is required'],
        [{ description: 'ESCOBA PEÑOLERA', product: [validNew()] }, 'product is required'],
        [{ description: 'ESCOBA PEÑOLERA', product: 'CLEAN-BROOM' }, 'product is required'],
    ]) {
        const r = await e.post('/api/purchases/bring', body);
        assert.equal(r.status, 400, JSON.stringify(body));
        assert.equal(r.body.error, error);
    }
    assert.equal(e.queries.length, 0);
    assert.equal(e.released.n, 0, 'no connection is taken just to reject');
});

test('bring: control_type is required and has no default', async t => {
    const e = await environment(t);
    for (const control_type of [undefined, null, '', 'unitary', 'STOCK', 'no balance', ['stock']]) {
        const r = await e.post('/api/purchases/bring', { description: 'ESCOBA PEÑOLERA', product: validNew({ control_type, minimum: null }) });
        assert.equal(r.status, 400, JSON.stringify(control_type));
        assert.equal(r.body.error, 'control_type is required: stock or no_balance');
    }
    assert.equal(e.queries.length, 0);
});

test('bring: optional minimum with the whole-unit rules; no_balance carries no minimum', async t => {
    const e = await environment(t);
    for (const [change, error] of [
        [{ control_type: 'no_balance', minimum: '4' }, 'An item without stock tracking cannot have a minimum'],
        [{ control_type: 'no_balance', minimum: 0 }, 'An item without stock tracking cannot have a minimum'],
        [{ minimum: -1 }, 'minimum cannot be negative'],
        [{ minimum: 'lots' }, 'minimum must be a number'],
        [{ minimum: true }, 'minimum must be a number'],
        [{ minimum: '1.5' }, 'fractions of "piece" are not allowed'],
        [{ minimum: 2.5, unit: 'PAIR' }, 'fractions of "pair" are not allowed'],
    ]) {
        const r = await e.post('/api/purchases/bring', { description: 'ESCOBA PEÑOLERA', product: validNew(change) });
        assert.equal(r.status, 400, JSON.stringify(change));
        assert.equal(r.body.error, error);
    }
    assert.equal(e.queries.length, 0);

    // In a unit that does allow fractions, a fractional minimum passes.
    const kilos = await e.post('/api/purchases/bring', { description: 'ESCOBA PEÑOLERA', product: validNew({ unit: 'kg', minimum: '2.5' }) });
    assert.equal(kilos.status, 201);
    assert.equal(kilos.body.product.minimum, '2.500');
    // Without minimum and without stock tracking: valid, and the minimum stays null.
    const costOnly = await e.post('/api/purchases/bring', { description: 'TOBERA 5/8" T/ACME ROSCADA', product: validNew({ code: 'WELD-NOZ-2', control_type: 'no_balance', minimum: '' }) });
    assert.equal(costOnly.status, 201);
    assert.equal(costOnly.body.product.minimum, null);
    assert.equal(costOnly.body.product.control_type, 'no_balance');
});

test('bring: enters uncounted (quantity 0, count_pending true) and the author comes from the session', async t => {
    const e = await environment(t);
    const r = await e.post('/api/purchases/bring', {
        description: ' escoba   peñolera ', user_id: 999,
        product: validNew({ quantity: 99, count_pending: false, user_id: 999 }),
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, {
        product: {
            id: 700, code: 'CLEAN-BROOM', name: 'Escoba peñolera', unit: 'piece', category_id: 4,
            control_type: 'stock', minimum: '5.000', count_pending: true,
        },
        alias_id: 100, purchases: 1, amount: '170.000000',
    });

    // Order in the contract: check backing, check link, create product, alias, COMMIT.
    const sqls = e.sqls();
    assert.equal(sqls[0], 'BEGIN');
    assert.match(sqls[1], /FROM purchases\s+WHERE description_norm = normalize_description\(\$1\)/);
    assert.match(sqls[2], /FROM product_aliases a\s+JOIN products p/);
    assert.match(sqls[3], /INSERT INTO products/);
    assert.match(sqls[4], /INSERT INTO product_aliases/);
    assert.equal(sqls[5], 'COMMIT');
    assert.equal(sqls.length, 6);
    assert.equal(e.released.n, 1);

    const created = e.queries[3];
    // Quantity 0 and count pending are written in the SQL: nothing in the body reaches them.
    assert.match(created.sql, /VALUES \(\$1, \$2, 0, \$3, \$4, \$5, \$6, \$7, \$8, true\)/);
    assert.deepEqual(created.args, ['CLEAN-BROOM', 'Escoba peñolera', 170, 'Shelf 3', 'piece', 4, 'stock', 5]);
    assert.ok(!created.args.includes(99) && !created.args.includes(false));

    const alias = e.queries[4];
    assert.match(alias.sql, /VALUES \(\$1, \$2, 'manual', \$3\)/);
    assert.deepEqual(alias.args, [700, 'escoba   peñolera', 7]);
    assert.equal(e.aliases.at(-1).created_by, 7);
    assert.equal(e.products.at(-1).count_pending, true);
    assert.equal(e.products.at(-1).quantity, 0);
});

test('bring: 404 without purchases and 409 if already linked, before any INSERT and with ROLLBACK', async t => {
    const e = await environment(t);
    const noPurchases = await e.post('/api/purchases/bring', { description: 'NOTHING', product: validNew() });
    assert.equal(noPurchases.status, 404);
    assert.deepEqual(noPurchases.body, { error: 'No purchase has that description' });

    const linked = await e.post('/api/purchases/bring', { description: 'disco de corte 4 1/2', product: validNew() });
    assert.equal(linked.status, 409);
    assert.deepEqual(linked.body, {
        error: 'That description is already linked to ABR-DISC',
        error_code: 'description_linked',
        product: { id: 2, code: 'ABR-DISC', name: 'Disc' },
    });

    assert.equal(e.sqls().some(s => /INSERT/.test(s)), false);
    assert.equal(e.sqls().filter(s => s === 'ROLLBACK').length, 2);
    assert.equal(e.sqls().includes('COMMIT'), false);
    assert.equal(e.released.n, 2);
    assert.equal(e.products.length, 2);
});

test('bring: repeated code (23505) gives 409 duplicate_code and ROLLBACK without an alias', async t => {
    const e = await environment(t);
    // Lowercase on purpose: the code is normalized the same way as on create.
    const r = await e.post('/api/purchases/bring', { description: 'ESCOBA PEÑOLERA', product: validNew({ code: 'abr-disc' }) });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: 'That code already exists', error_code: 'duplicate_code' });
    const sqls = e.sqls();
    assert.equal(sqls.at(-1), 'ROLLBACK');
    assert.equal(sqls.includes('COMMIT'), false);
    assert.equal(sqls.some(s => /INSERT INTO product_aliases/.test(s)), false);
    assert.equal(e.products.length, 2);
    assert.equal(e.aliases.length, 1);
    assert.equal(e.released.n, 1);
});

test('bring: if the alias fails the whole creation is rolled back (ROLLBACK)', async t => {
    t.mock.method(console, 'error', () => {});
    const e = await environment(t, { aliasFailure: () => { throw new Error('the connection dropped'); } });
    const r = await e.post('/api/purchases/bring', { description: 'ESCOBA PEÑOLERA', product: validNew() });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'Error bringing the item to the catalog');
    const sqls = e.sqls();
    assert.ok(sqls.some(s => /INSERT INTO products/.test(s)), 'the creation was attempted');
    assert.equal(sqls.at(-1), 'ROLLBACK');
    assert.equal(sqls.includes('COMMIT'), false);
    // The new item does not survive without its link.
    assert.equal(e.products.length, 2);
    assert.equal(e.products.some(p => p.code === 'CLEAN-BROOM'), false);
    assert.equal(e.released.n, 1);
});

test('bring: if another link wins the description mid-transaction, 409 with its item', async t => {
    const e = await environment(t, {
        aliasFailure: ({ aliases }) => {
            // Someone else linked the same description between the check and the INSERT.
            if (!aliases.some(a => a.alias === 'ESCOBA PEÑOLERA')) {
                aliases.push({ id: 55, product_id: 1, alias: 'ESCOBA PEÑOLERA', origin: 'manual', created_by: 3 });
            }
        },
    });
    const r = await e.post('/api/purchases/bring', { description: 'escoba peñolera', product: validNew() });
    assert.equal(r.status, 409);
    assert.equal(r.body.error_code, 'description_linked');
    assert.deepEqual(r.body.product, { id: 1, code: 'WELD-NOZZLE', name: 'Nozzle' });
    assert.ok(e.sqls().includes('ROLLBACK'));
    assert.equal(e.products.some(p => p.code === 'CLEAN-BROOM'), false);
});

test('bring: nonexistent category (23503) gives 400 and ROLLBACK', async t => {
    const e = await environment(t);
    const r = await e.post('/api/purchases/bring', { description: 'ESCOBA PEÑOLERA', product: validNew({ category_id: 99 }) });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body, { error: 'The selected category does not exist' });
    assert.equal(e.sqls().at(-1), 'ROLLBACK');
    assert.equal(e.products.length, 2);
});

// ============================================================
//  Unlink
// ============================================================

test('unlink: 400 if the id is not a positive integer (no SQL), 404 if it does not exist, 204 on delete', async t => {
    const e = await environment(t);
    for (const id of ['0', '-1', 'abc', '1.5', '1e400']) {
        const r = await e.request(`/api/purchases/links/${id}`, { method: 'DELETE' });
        assert.equal(r.status, 400, id);
        assert.equal(r.body.error, 'aliasId must be a positive integer');
    }
    assert.equal(e.queries.length, 0);

    const missing = await e.request('/api/purchases/links/999', { method: 'DELETE' });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.body, { error: 'That link does not exist' });

    const deleted = await e.request('/api/purchases/links/12', { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(deleted.body, null);
    assert.equal(e.aliases.length, 0);
    assert.deepEqual(e.queries.at(-1).args, [12]);

    assert.equal((await e.request('/api/purchases/links/12', { method: 'DELETE' })).status, 404);
});

test('Expenses was retired: /api/expenses no longer returns data', async t => {
    const e = await environment(t);
    const r = await fetch(`${e.url}/api/expenses`);
    assert.equal(r.status, 404);
    assert.equal(e.queries.length, 0);
});
