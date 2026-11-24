/* global window, document */
// Creating a category from the new-product form, in a real Chromium against the BUILT app (client/dist),
// not a stand-in for the component. The API is MOCKED here (page.route), no server is started; the real
// endpoint is covered by test/api.test.cjs, test/permissions.test.cjs and test/categories-race.test.cjs.
//
// Scenarios:
//  1. No categories: says so, lets you create one, selects it, enables "Create" and sends `category_id`;
//     Enter in the new-name field does NOT submit the product; a duplicate name (409) is reported without
//     losing what was typed.
//  2. The list is slow: says "Loading categories…" and does NOT offer to create (never "none yet").
//  3. The list fails: shows the error, offers Retry, and the field turns on after retrying.
//  4. Another device created "Welding" and this list is stale: creating "welding" gives 409, the list is
//     fetched again and the category ends up SELECTED.
//  5. A name typed but not created: "Create" is off and says why; Cancel turns it back on.
//  6. What is typed in "Code" while the category is being created is not wiped.
//  7. Focus: opening the form lands in its field, and the buttons are visible on a phone (375x667).
//  8. Switching path in the scan modal with a pending name does not leave the save button disabled.
//
// Usage: (cd client && npm run build) && node scripts/verify-categories.cjs
// Needs `playwright` and a Chromium (not project dependencies). CHROMIUM_PATH=/path/to/chromium.
// SCREENSHOT=/path/img.png saves how the form looks in scenario 1.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const DIST = path.join(__dirname, '..', 'client', 'dist');
const ORIGIN = 'http://lupo.test';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadPlaywright() {
    try { return require('playwright'); } catch {
        throw new Error('playwright is missing (npm i -g playwright) and so is a Chromium; see the top of this file.');
    }
}

// One mocked "database" per scenario. `ops` tunes what the API answers (delays, failures, existing categories).
async function newPage(browser, ops = {}) {
    const page = await browser.newPage({ viewport: ops.viewport || { width: 1280, height: 960 } });
    const state = {
        categories: (ops.categories || []).map((name, i) => ({ id: i + 1, name, prefix: null, examples: [] })),
        received: { categories: [], products: [] },
        gets: 0,
        respond409: false,
        failGet: ops.failGet || 0,           // how many GET /api/categories fail before answering properly
        delayGet: ops.delayGet || 0,
        delayPost: ops.delayPost || 0,
        // What "another device" already created and this list does not have yet (scenario 4).
        foreign: [],
    };
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route(`${ORIGIN}/**`, async route => {
        const request = route.request();
        const { pathname } = new URL(request.url());
        if (pathname.startsWith('/api/')) {
            const method = request.method();
            if (pathname === '/api/session') return json(route, { user: { id: 1, name: 'Test Admin', role: 'admin', must_change_password: false } });
            if (pathname === '/api/categories' && method === 'GET') {
                state.gets++;
                if (state.delayGet) await sleep(state.delayGet);
                if (state.failGet > 0) { state.failGet--; return json(route, { error: 'Could not query categories' }, 500); }
                return json(route, state.categories);
            }
            if (pathname === '/api/categories' && method === 'POST') {
                const { name } = request.postDataJSON();
                state.received.categories.push(name);
                if (state.delayPost) await sleep(state.delayPost);
                const key = name.toLowerCase();
                const exists = [...state.categories, ...state.foreign].some(c => c.name.toLowerCase() === key);
                if (state.respond409 || exists) {
                    // The other device already created it: from now on the server lists it.
                    for (const f of state.foreign) if (!state.categories.includes(f)) state.categories.push(f);
                    return json(route, { error: 'A category with that name already exists' }, 409);
                }
                const created = { id: state.categories.length + 1, name, prefix: null, examples: [] };
                state.categories.push(created);
                return json(route, created, 201);
            }
            if (pathname === '/api/products' && method === 'POST') {
                state.received.products.push(request.postDataJSON());
                return json(route, { id: 1, code: 'TEST-1', name: 'Test' }, 201);
            }
            if (pathname === '/api/products') return json(route, { products: [], total: 0, page: 1, pages: 1 });
            if (pathname === '/api/locations') return json(route, { locations: [], no_location: 0 });
            if (pathname === '/api/summary') return json(route, { with_minimum: 0, with_minimum_counted: 0, products: 0 });
            if (pathname.startsWith('/api/products/by-code')) return json(route, { error: 'does not exist' }, 404);
            return json(route, {});
        }
        const file = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
        const exists = file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile();
        const final = exists ? file : path.join(DIST, 'index.html');   // app routes: index.html
        return route.fulfill({ status: 200, contentType: TYPES[path.extname(final)] || 'application/octet-stream', body: fs.readFileSync(final) });
    });
    await page.addInitScript(() => { window.localStorage.setItem('lupo.token', 'test'); });
    return { page, state };
}

async function openCreate(page) {
    await page.goto(`${ORIGIN}/inventory`);
    await page.getByRole('button', { name: /Add product/ }).first().click();
    await page.locator('#create-category').waitFor();
}
const save = page => page.getByRole('button', { name: /^Create$/ }).last();
const firstOption = page => page.locator('#create-category option').first().textContent();

const SCENARIOS = [
    ['1. No categories: says so, creates with Enter without submitting the product, selects it, and a 409 is reported', {}, async ({ page, state }) => {
        await openCreate(page);
        assert.match(await firstOption(page), /No categories yet: create the first one/);
        await page.locator('#create-code').fill('TEST-1');
        await page.locator('#create-name').fill('Test product');
        assert.equal(await save(page).isDisabled(), true);
        await page.getByRole('button', { name: /Create new category/ }).click();
        const field = page.locator('#create-category-new');
        await field.fill('  Test   - Consumables ');
        if (process.env.SCREENSHOT) await page.screenshot({ path: process.env.SCREENSHOT });
        await field.press('Enter');
        await page.waitForFunction(() => document.querySelector('#create-category').value === '1');
        assert.deepEqual(state.received.categories, ['Test - Consumables']);
        assert.equal(state.received.products.length, 0, 'Enter in the new category must not submit the product');
        assert.equal(await page.locator('#create-code').inputValue(), 'TEST-1');
        assert.equal(await save(page).isDisabled(), false);
        await save(page).click();
        await page.waitForFunction(() => document.body.innerText.includes('TEST-1 created'));
        assert.equal(state.received.products[0].category_id, 1);
        // A name the server rejects while it is not in the list (409 with nothing to select): reported.
        state.respond409 = true;
        await page.getByRole('button', { name: /Create new category/ }).click();
        await page.locator('#create-category-new').fill('Odd');
        await page.getByRole('button', { name: /^Create category$/ }).click();
        await page.waitForFunction(() => document.body.innerText.includes('A category with that name already exists'));
        assert.equal(await page.locator('#create-category-new').inputValue(), 'Odd');
    }],

    ['2. The list is slow: "Loading categories…", field off and NOT offering to create', { delayGet: 1500 }, async ({ page }) => {
        await page.goto(`${ORIGIN}/inventory`);
        await page.getByRole('button', { name: /Add product/ }).first().click();
        await page.locator('#create-category').waitFor();
        assert.match(await firstOption(page), /Loading categories…/);
        assert.equal(await page.locator('#create-category').isDisabled(), true);
        assert.equal(await page.getByRole('button', { name: /Create new category/ }).isDisabled(), true);
        assert.doesNotMatch(await page.locator('body').innerText(), /No categories yet/);
        await page.waitForFunction(() => /No categories yet/.test(document.querySelector('#create-category option').textContent));
    }],

    ['3. The list fails: error, Retry, and the field turns on when it comes back', { failGet: 3 }, async ({ page }) => {
        await page.goto(`${ORIGIN}/inventory`);
        await page.getByRole('button', { name: /Add product/ }).first().click();
        await page.getByText('Could not load the categories').waitFor({ timeout: 15000 });
        assert.match(await firstOption(page), /Loading categories…/);
        assert.equal(await page.getByRole('button', { name: /Create new category/ }).isDisabled(), true);
        assert.doesNotMatch(await page.locator('body').innerText(), /No categories yet/);
        await page.getByRole('button', { name: /Retry/ }).first().click();
        await page.waitForFunction(() => !document.querySelector('#create-category').disabled, null, { timeout: 15000 });
    }],

    ['4. Stale list and "already exists": it is fetched again and the category ends up SELECTED', { categories: ['Drill bit'] }, async ({ page, state }) => {
        await openCreate(page);
        const before = state.gets;
        state.foreign.push({ id: 2, name: 'Welding', prefix: null, examples: [] });   // another device created it
        await page.getByRole('button', { name: /Create new category/ }).click();
        await page.locator('#create-category-new').fill('welding');
        await page.getByRole('button', { name: /^Create category$/ }).click();
        await page.waitForFunction(() => document.querySelector('#create-category').value === '2');
        assert.ok(state.gets > before, 'the list was fetched again');
        assert.equal(await page.locator('#create-category option:checked').textContent(), 'Welding');
        assert.equal(await page.locator('#create-category-new').isVisible(), false, 'the form closed');
        assert.doesNotMatch(await page.locator('body').innerText(), /Could not create the category/);
    }],

    ['5. Name typed but not created: "Create" is off and says why; Cancel turns it back on', { categories: ['Drill bit'] }, async ({ page }) => {
        await openCreate(page);
        await page.locator('#create-code').fill('DRL-1');
        await page.locator('#create-name').fill('Test drill bit');
        await page.locator('#create-category').selectOption('1');
        assert.equal(await save(page).isDisabled(), false);
        await page.getByRole('button', { name: /Create new category/ }).click();
        assert.equal(await save(page).isDisabled(), false, 'opening the empty form does not disable saving');
        await page.locator('#create-category-new').fill('Welding');
        assert.equal(await save(page).isDisabled(), true);
        assert.match(await page.locator('body').innerText(), /Press "Create category" to use it/);
        await page.getByRole('button', { name: /^Cancel$/ }).click();
        assert.equal(await save(page).isDisabled(), false);
        assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'create-category', 'focus goes back to the select');
    }],

    ['6. What is typed in "Code" while the category is being created is not wiped', { delayPost: 1200 }, async ({ page }) => {
        await openCreate(page);
        await page.getByRole('button', { name: /Create new category/ }).click();
        await page.locator('#create-category-new').fill('Welding');
        await page.getByRole('button', { name: /^Create category$/ }).click();
        await page.locator('#create-code').fill('WLD-123');          // while the POST is still in flight
        await page.waitForFunction(() => document.querySelector('#create-category').value === '1', null, { timeout: 15000 });
        assert.equal(await page.locator('#create-code').inputValue(), 'WLD-123');
    }],

    ['7. Focus when the form opens, and the buttons are visible on a phone (375x667)', { categories: ['Drill bit'], viewport: { width: 375, height: 667 } }, async ({ page }) => {
        await openCreate(page);
        await page.getByRole('button', { name: /Create new category/ }).click();
        await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'create-category-new');
        await sleep(400);                                              // let the scroll settle
        assert.equal(await page.evaluate(() => document.activeElement.id), 'create-category-new', 'focus stays in the field');
        for (const name of [/^Create category$/, /^Cancel$/]) {
            const box = await page.getByRole('button', { name }).boundingBox();
            assert.ok(box && box.y >= 0 && box.y + box.height <= 667, `${name} inside the screen: ${JSON.stringify(box)}`);
        }
        await page.locator('#create-category-new').fill('Welding');
        await page.locator('#create-category-new').press('Enter');
        await page.waitForFunction(() => document.querySelector('#create-category').value === '2');
        assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'create-category', 'after creating, focus stays on the select and not on the body');
    }],

    ['8. In the scan modal, switching path with a pending name does not leave saving disabled', { categories: ['Drill bit'] }, async ({ page }) => {
        await page.goto(`${ORIGIN}/scan`);
        await page.locator('#scan-manual').fill('7500000000017');
        await page.getByRole('button', { name: /^Search$/ }).click();
        await page.getByRole('button', { name: /Add this code/ }).click();
        await page.locator('label[for="code-path-create"]').click();
        await page.locator('#code-category').waitFor();
        await page.getByRole('button', { name: /Create new category/ }).click();
        await page.locator('#code-category-new').fill('Pending');
        // Switch path and come back: the field unmounts and mounts again, without the name.
        await page.locator('label[for="code-path-link"]').click();
        await page.locator('label[for="code-path-create"]').click();
        await page.locator('#code-category').waitFor();
        assert.equal(await page.locator('#code-category-new').isVisible(), false, 'the new-category form starts closed');
        // With everything else filled in, the save button is NOT disabled by a name that no longer exists.
        await page.locator('#internal-code').fill('DRL-9');
        await page.locator('#code-name').fill('New drill bit');
        await page.locator('#code-category').selectOption('1');
        await page.locator('label[for="code-type-stock"]').click();
        const primary = page.getByRole('button', { name: /Create with this code/ });
        assert.equal(await primary.isDisabled(), false);
    }],
];

(async () => {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('client/dist is missing: run `cd client && npm run build`.');
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
    let failures = 0;
    for (const [title, ops, run] of SCENARIOS) {
        const { page, state } = await newPage(browser, ops);
        try {
            await run({ page, state });
            console.log('  ok    ' + title);
        } catch (e) {
            failures++;
            console.log('  FAIL  ' + title + '\n        ' + String(e.message || e).split('\n').slice(0, 4).join('\n        '));
        } finally {
            await page.close();
        }
    }
    await browser.close();
    console.log(`\n${SCENARIOS.length - failures} of ${SCENARIOS.length} scenarios correct`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('Script FAILED:', e.message || e); process.exit(1); });
