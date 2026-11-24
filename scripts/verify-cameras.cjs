/* global window, document, navigator, DOMException */
// Lens switching in a real Chromium with SIMULATED cameras. Runs the real client/src pieces (cameras.ts,
// scanner.ts) in the order ScanScreen.tsx calls them; the React component itself is replayed by hand in
// SCENARIO, so keep the two in sync. It cannot say whether a real finger falls under the thresholds in
// cameras.ts: for that, open /scan?cameradiag=1 on a phone.
//
// Usage: node scripts/verify-cameras.cjs
// Needs `playwright` and a Chromium (not project dependencies, not part of `npm test`). Point at an
// existing Chromium with CHROMIUM_PATH=/path/to/chromium. The pure logic is in test/cameras.test.cjs
// and test/scanner.test.cjs.

const fs = require('node:fs');
const path = require('node:path');

function loadPlaywright() {
    try { return require('playwright'); } catch {
        throw new Error('playwright is missing (npm i -g playwright) and so is a Chromium; see the top of this file.');
    }
}

// Compiles cameras.ts and scanner.ts to CommonJS with the TypeScript already in client/.
function compile() {
    const ts = require('../client/node_modules/typescript');
    const src = path.join(__dirname, '..', 'client', 'src');
    const output = {};
    for (const file of ['cameras', 'scanner']) {
        output[file] = ts.transpileModule(fs.readFileSync(path.join(src, file + '.ts'), 'utf8'),
            { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    }
    return output;
}

// Inside the page: three rear lenses (A, B, C) and a front one (F), each with a simulated picture.
const SIMULATION = () => {
    window.__lenses = {
        A: { label: 'camera2 0, facing back', facing: 'environment', state: 'scene' },
        B: { label: 'camera2 2, facing back', facing: 'environment', state: 'scene' },
        C: { label: 'camera2 4, facing back', facing: 'environment', state: 'scene' },
        F: { label: 'camera2 1, facing front', facing: 'user', state: 'scene' },
    };
    window.__opens = [];
    const draw = (ctx, state, n) => {
        const { width: w, height: h } = ctx.canvas;
        const fill = c => { ctx.fillStyle = c; ctx.fillRect(0, 0, w, h); };
        if (state === 'black') return fill('#000');
        if (state === 'finger') return fill('rgb(60,14,8)');
        if (state === 'wall') return fill('rgb(200,200,195)');
        // Flat dim wall whose light flips right around the threshold (55 <-> 65), in 400 ms steps.
        if (state === 'threshold') { const g = Math.floor(performance.now() / 400) % 4 === 3 ? 65 : 55; return fill(`rgb(${g},${g},${g})`); }
        if (state === 'shelf') {
            fill('rgb(25,25,28)');
            for (let i = 0; i < 40; i++) { ctx.fillStyle = `rgb(${70 + (i * 37) % 60},${60 + (i * 53) % 50},55)`; ctx.fillRect((i * 97 + n) % w, (i * 61) % h, 40, 30); }
            return;
        }
        const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#556'); g.addColorStop(1, '#cb9');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 60; i++) { ctx.fillStyle = `hsl(${(i * 47 + n * 3) % 360} 60% ${30 + (i * 13) % 50}%)`; ctx.fillRect((i * 83 + n * 5) % w, (i * 41) % h, 50, 35); }
    };
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    navigator.mediaDevices.getUserMedia = async c => {
        const v = c.video || {};
        const id = (v.deviceId && v.deviceId.exact) || (v.facingMode === 'user' ? 'F' : 'A');
        window.__opens.push(id);
        if (!(id in window.__lenses)) throw new DOMException('does not exist', 'OverconstrainedError');
        if (window.__lenses[id].cantOpen) throw new DOMException('cannot open', 'NotReadableError');
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); let n = 0;
        const paint = () => draw(ctx, window.__lenses[id].state, n++);
        paint(); const timer = setInterval(paint, 66);
        const stream = canvas.captureStream(15); const track = stream.getVideoTracks()[0];
        track.getSettings = () => ({ deviceId: id, facingMode: window.__lenses[id].facing, width: 640, height: 360 });
        const stop = track.stop.bind(track); track.stop = () => { clearInterval(timer); stop(); };
        return stream;
    };
    navigator.mediaDevices.enumerateDevices = async () =>
        Object.entries(window.__lenses).map(([deviceId, l]) => ({ deviceId, label: l.label, kind: 'videoinput' }));
};

// What ScanScreen does with these pieces, minus React: open, list, watch, switch and skip the bad ones.
const SCENARIO = async ({ states, cantOpen, ms, changes }) => {
    for (const k of Object.keys(window.__lenses)) {
        window.__lenses[k].state = states[k] || 'scene';
        window.__lenses[k].cantOpen = (cantOpen || []).includes(k);
    }
    window.__opens.length = 0;
    const loadModule = (code, req) => { const mod = { exports: {} }; new Function('require', 'module', 'exports', code)(req, mod, mod.exports); return mod.exports; };
    const cameras = loadModule(window.__modules.cameras, () => ({}));
    const scanner = loadModule(window.__modules.scanner, n => (n === './cameras' ? cameras : {}));
    const video = document.getElementById('v');
    const watcher = cameras.createWatcher();
    const timeline = []; const t0 = performance.now();
    const count = { switch: 0, 'no-image': 0, image: 0, failures: 0 };
    let last = '', all = [], current = null, stream = null, stop = null;
    const bad = new Set();
    const note = txt => { if (txt !== last) { timeline.push(`${String(Math.round(performance.now() - t0)).padStart(5)} ms  ${txt}`); last = txt; } };
    async function open(lensId) {
        if (stop) stop();
        if (stream) stream.getTracks().forEach(t => t.stop());
        let s;
        try {
            s = await scanner.openCamera('environment', lensId);
        } catch (e) {
            if (!lensId) throw e;
            // Same as the catch in the screen: a lens that fails to open is marked bad and the next one is tried.
            bad.add(lensId); count.failures++;
            note(`lens ${lensId} does NOT open (${e.name}): skipped`);
            const other = cameras.nextLens(all, lensId, bad);
            await open(other ? other.deviceId : undefined);
            return;
        }
        stream = s; video.srcObject = s; await video.play();
        current = scanner.streamLensId(s); note(`lens ${current} opened`);
        if (!all.length) all = await scanner.getRearLenses();
        watcher.restart(performance.now());
        stop = scanner.watchImage(video, (m, now) => {
            const v = watcher.sample(m, now, cameras.usableLenses(all, bad).length);
            if (v !== 'wait') { count[v]++; note(`${v}  (light ${m.mean.toFixed(0)}, detail ${m.deviation.toFixed(1)})`); }
            if (v === 'switch') { watcher.restart(now); const next = cameras.nextLens(all, current, bad); if (next) open(next.deviceId); }
        }, () => watcher.restart(performance.now()));
    }
    for (const c of (changes || [])) setTimeout(() => { window.__lenses[c.lens].state = c.state; note(`>> ${c.lens} becomes "${c.state}"`); }, c.at);
    await open(undefined);
    note(`rear lenses listed: ${all.length}`);
    await new Promise(r => setTimeout(r, ms));
    stop(); stream.getTracks().forEach(t => t.stop());
    return { timeline, count, finalLens: current, lastVerdict: last };
};

// Each case: what is simulated and what MUST happen. `ok` returns null if fine, else the reason.
const CASES = [
    ['1. Lens A taped over (black); B and C free: switches to B and keeps an image',
        { states: { A: 'black' }, ms: 7000 },
        r => (r.count.switch === 1 && r.finalLens === 'B' && r.count['no-image'] === 0 && r.count.image >= 1) ? null : 'expected 1 switch to B with an image'],
    ['2. Lens A covered by a finger (dark reddish and flat): switches to B',
        { states: { A: 'finger' }, ms: 7000 },
        r => (r.count.switch === 1 && r.finalLens === 'B' && r.count['no-image'] === 0) ? null : 'expected 1 switch to B'],
    ['3. Normal scene on A: nothing changes',
        { states: {}, ms: 8000 },
        r => (r.count.switch === 0 && r.count['no-image'] === 0 && r.finalLens === 'A') ? null : 'should not have switched'],
    ['4. Pointing at a flat bright wall: nothing changes',
        { states: { A: 'wall' }, ms: 8000 },
        r => (r.count.switch === 0 && r.count['no-image'] === 0) ? null : 'should not have switched'],
    ['5. Dim shelf with detail: nothing changes',
        { states: { A: 'shelf' }, ms: 8000 },
        r => (r.count.switch === 0 && r.count['no-image'] === 0) ? null : 'should not have switched'],
    ['6. All three rear lenses covered: tries the other two and warns ONCE, no endless loop',
        { states: { A: 'black', B: 'black', C: 'black' }, ms: 14000 },
        r => (r.count.switch === 2 && r.count['no-image'] === 1) ? null : 'expected 2 switches and 1 warning'],
    ['7. A free; someone covers it at 2 s: moves to B a few seconds later',
        { states: {}, ms: 9000, changes: [{ lens: 'A', state: 'black', at: 2000 }] },
        r => (r.count.switch === 1 && r.finalLens === 'B') ? null : 'expected 1 switch to B'],
    ['8. All covered; at 9 s they are uncovered: the warning clears ("image" returns)',
        { states: { A: 'black', B: 'black', C: 'black' }, ms: 15000, changes: [{ lens: 'A', state: 'scene', at: 9000 }, { lens: 'B', state: 'scene', at: 9000 }, { lens: 'C', state: 'scene', at: 9000 }] },
        r => (r.count['no-image'] === 1 && r.lastVerdict.startsWith('image')) ? null : 'expected a warning and then an image'],
    ['9. A covered, B is listed but does NOT open, C free: skips B and ends on C',
        { states: { A: 'black' }, cantOpen: ['B'], ms: 9000 },
        r => (r.finalLens === 'C' && r.count.failures === 1 && r.count['no-image'] === 0) ? null : 'expected to end on C, skipping B'],
    ['10. A covered; B and C listed but do not open: no looping, warns ONCE',
        { states: { A: 'black' }, cantOpen: ['B', 'C'], ms: 12000 },
        r => (r.count.failures === 2 && r.count['no-image'] === 1 && r.count.switch === 1) ? null : 'expected 2 failures, 1 switch and 1 warning'],
    ['11. Flat dim wall right at the threshold: does not keep switching lenses forever',
        { states: { A: 'threshold', B: 'threshold', C: 'threshold' }, ms: 22000 },
        r => (r.count.switch <= 2 && r.count['no-image'] <= 1) ? null : 'switched too much'],
];

(async () => {
    const { chromium } = loadPlaywright();
    const modules = compile();
    const browser = await chromium.launch({
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
        args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
    });
    const page = await browser.newPage();
    await page.setContent('<video id="v" playsinline muted autoplay width="320" height="180"></video>');
    await page.evaluate(m => { window.__modules = m; }, modules);
    await page.evaluate(SIMULATION);
    console.log('Chromium', browser.version(), '- simulated pictures, see the top of this file\n');
    let failures = 0;
    for (const [title, args, ok] of CASES) {
        const r = await page.evaluate(SCENARIO, args);
        const reason = ok(r);
        if (reason) failures++;
        console.log(`${reason ? 'FAIL' : 'ok  '}  ${title}${reason ? `\n       ${reason}` : ''}`);
        if (reason || process.env.VERBOSE) console.log(r.timeline.map(l => '       ' + l).join('\n'));
    }
    await browser.close();
    console.log(`\n${CASES.length - failures} of ${CASES.length} cases correct`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error('Script FAILED', e); process.exit(1); });
