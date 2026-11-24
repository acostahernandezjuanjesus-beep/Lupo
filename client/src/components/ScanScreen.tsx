import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Button, ComboBox, TextInput, Tile, InlineNotification, Tag,
    RadioButtonGroup, RadioButton, ContentSwitcher, Switch,
} from '@carbon/react';
import { Camera, Close, ArrowRight, Add, Renew } from '@carbon/icons-react';
import type { Product, ProductApi, User, UserListing } from '../types';
import { toProduct, requestJson, ApiError, isAborted } from '../api';
import { fetchJson } from '../queries';
import {
    openCamera, countCameras, detectorAvailable, isRearCamera, listenUsbReader, readFromVideo,
    streamLensId, getRearLenses, whyCameraFailed, preloadReader, watchImage, type Side,
} from '../scanner';
import { createWatcher, isCovered, usableLenses, nextLens, type Device, type Measure } from '../cameras';
import { levelStateOf, formatQuantity, balanceKnown } from '../level';
import { MAX_BARCODE_LENGTH, quantityProblem } from '../newProduct';
import { StockBar, StockState } from './ProductTable';
import { NewCodeModal, type NewCodeResult } from './scan/NewCodeModal';

// Scan: take material out (or in) by pointing the phone at the code, or by firing the USB reader at the
// counter computer. Three decisions shape it:
//   - It ASKS whether it goes out or in, every time, and remembers nothing: no sticky state carried over
//     from the previous movement.
//   - Who takes it is required. That's the data the screen exists for.
//   - The camera stays on after recording; the real case is a line of people at the window.
// Reading the video, opening the camera and the USB reader live in `scanner.ts`.

// A CFDI invoice QR is a SAT verification URL, not a product code. Reject it before hitting the server,
// or /api/products/by-code would 404 and the screen would offer to link a URL to a product.
function looksLikeUrl(text: string) {
    return /^https?:\/\//i.test(text.trim());
}

// Which camera was chosen is this device's convenience, not data: it lives in the browser and defaults
// to the rear one if it can't be read or written.
const SIDE_KEY = 'lupo.camera.side';
function savedSide(): Side {
    try { return localStorage.getItem(SIDE_KEY) === 'user' ? 'user' : 'environment'; } catch { return 'environment'; }
}
function saveSide(side: Side) {
    try { localStorage.setItem(SIDE_KEY, side); } catch { /* it will be chosen again */ }
}

// Live readout of what the covered-lens watcher sees (mean, deviation, red/blue), for tuning the
// thresholds in `cameras.ts` with numbers from a real phone. Turn on with /scan?cameradiag=1, off with
// ?cameradiag=0; it's kept in the browser because the link with the parameter is opened only once.
const DIAGNOSTIC_KEY = 'lupo.cameradiag';
function diagnosticOn(): boolean {
    try {
        const asked = new URLSearchParams(window.location.search).get('cameradiag');
        if (asked === '1') localStorage.setItem(DIAGNOSTIC_KEY, '1');
        if (asked === '0') localStorage.removeItem(DIAGNOSTIC_KEY);
        return localStorage.getItem(DIAGNOSTIC_KEY) === '1';
    } catch { return false; }
}

// A specific lens can open and never deliver a frame, leaving `play()` waiting on "Opening the camera…"
// until someone taps Stop. After this long we call that lens bad and move on to the next.
const FIRST_FRAME_WAIT_MS = 5000;
const noFrames = (ms: number) => new Promise<never>((_, reject) =>
    setTimeout(() => reject(new DOMException('The lens delivered no frames', 'TimeoutError')), ms));

type Props = {
    user: User;
    onBack: () => void;
};

/** What was recorded this session, so the row is auditable at a glance. */
type Entry = {
    id: number; code: string; name: string; quantity: number; unit: string; who: string;
    direction: 'out' | 'in';
    /** The balance the server returned, or null if the product isn't counted: otherwise "4 left" would be made up. */
    balance: number | null;
    /** To say why there's no balance: not counted, or not stock-tracked. */
    noBalance: boolean;
};

// Stable empty list: a `?? []` in render would be a new array each paint and the ComboBox would treat it as a different list.
const NO_PEOPLE: UserListing[] = [];

// Scroll a scan result into view: on a phone the camera fills the screen and what appears below was out
// of sight. Kept stable and outside the component so React calls it only on mount, and each panel's
// `key` carries the code so it remounts on every scan. The keys have a prefix ("unknown:", "modal:")
// because the panel and the modal are siblings with the same code. Jump, don't animate: smooth scrolling
// stalled when the page wasn't painting frames.
const scrollIntoView = (node: HTMLElement | null) => node?.scrollIntoView({ block: 'nearest' });

export function ScanScreen({ user, onBack }: Props) {
    const queries = useQueryClient();
    const [product, setProduct] = useState<Product | null>(null);
    const [rawCode, setRawCode] = useState('');
    const [unknown, setUnknown] = useState<string | null>(null);

    // No default on purpose: a preselected one becomes the direction nobody looks at.
    const [direction, setDirection] = useState<'out' | 'in' | null>(null);
    const [quantity, setQuantity] = useState('1');
    const [responsible, setResponsible] = useState<UserListing | null>(null);

    // Same key as any other screen that lists people.
    const peopleQuery = useQuery({
        queryKey: ['users'],
        queryFn: fetchJson<UserListing[]>('/api/users'),
    });
    const people = peopleQuery.data ?? NO_PEOPLE;
    const peopleError = peopleQuery.error ? 'The shop wifi or the API did not respond.' : null;

    const [cameraLive, setCameraLive] = useState(false);
    const [multipleCameras, setMultipleCameras] = useState(false);
    const [side, setSide] = useState<Side>(savedSide);
    const [mirror, setMirror] = useState(false);
    // Rear lenses the browser lists, to move to another when one is covered (see `cameras.ts`).
    // `lensesRef` holds the full list in order; `bad` are the ones listed but that wouldn't open (depth
    // sensors, a busy lens), skipped for the rest of this camera session; `lenses` is the list WITHOUT
    // the bad ones, what's painted and what the watcher counts. The refs are for the watcher, which runs
    // inside an interval and isn't recreated on each render.
    const [lenses, setLenses] = useState<Device[]>([]);
    const lensesRef = useRef<Device[]>([]);
    const bad = useRef(new Set<string>());
    const currentLens = useRef<string | null>(null);
    // The same lens, for painting ("Lens 2 of 3"): a ref isn't read while painting.
    const [shownLens, setShownLens] = useState<string | null>(null);
    const [watcher] = useState(createWatcher);
    const [noImage, setNoImage] = useState(false);
    const [lensNotice, setLensNotice] = useState<string | null>(null);
    const [diagnostic] = useState(diagnosticOn);
    const [measure, setMeasure] = useState<Measure | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<string | null>(null);
    const [sending, setSending] = useState(false);
    const [recorded, setRecorded] = useState<Entry[]>([]);

    // An unknown code is added in a modal: link it to a catalog product or create a new one. The modal
    // keeps ITS code from when it opened and doesn't read `unknown`: a read already in flight could
    // change or clear it and unmount the modal mid-typing.
    const [adding, setAdding] = useState<string | null>(null);
    const [added, setAdded] = useState<NewCodeResult | null>(null);
    // While the modal is open nothing the camera or USB reader reads is resolved, and a late response is
    // dropped: the modal works on ONE code. The USB reader does type into the modal's focused field
    // (see `listenUsbReader`). The ref is for the listeners, which aren't resubscribed on each render.
    const addingRef = useRef(false);
    function openAdd(code: string | null) {
        addingRef.current = code !== null;
        setAdding(code);
    }

    const video = useRef<HTMLVideoElement | null>(null);
    const stream = useRef<MediaStream | null>(null);
    const searching = useRef(false);
    // The code already resolved on screen (as a product or as unknown). While the item stays in front of
    // the camera the read loop detects it every 330 ms; without this lock each detection reset the
    // direction and quantity while the storekeeper was filling them in.
    const currentCode = useRef<string | null>(null);
    const canLink = user.role === 'storekeeper' || user.role === 'admin';

    // Computed once on mount; it depends on nothing that changes, and setting state in an effect costs an extra render.
    const [support] = useState(() => ({
        detector: detectorAvailable() !== null,
        // getUserMedia only exists in a secure context. Over plain HTTP on the LAN the camera won't open,
        // and the browser's error doesn't say why.
        secure: window.isSecureContext,
    }));

    // Each camera opening is numbered. `getUserMedia` takes half a second or more on a phone, and in that
    // gap it can be turned off, switched, or "Scan" tapped again. An opening that's no longer the latest
    // releases its camera on arrival instead of overwriting the current one and leaving an LED on that
    // no button can turn off.
    const openCount = useRef(0);
    const [opening, setOpening] = useState(false);

    const turnOffCamera = useCallback(() => {
        openCount.current++;
        stream.current?.getTracks().forEach(t => t.stop());
        stream.current = null;
        setCameraLive(false);
        setOpening(false);
        setNoImage(false);
        setLensNotice(null);
    }, []);

    // Release the camera on leaving the screen, or the phone's LED stays on and the battery drains.
    useEffect(() => turnOffCamera, [turnOffCamera]);

    // Resolve a code: the manufacturer's or ours, the server tries both. A direct call and not useQuery:
    // it starts a transaction rather than showing a read. The lock and the URL rejection must decide
    // BEFORE touching the server, a 404 is the "unknown" case, not an error, and every scan needs the
    // balance of that moment, not a cached one (the negative-balance warning comes from it).
    const resolve = useCallback(async (code: string) => {
        // Already what's on screen: don't query again, or a still item resets direction and quantity.
        if (code === currentCode.current) return;

        // No product package code gets here; it's a QR with something else inside. Say so now instead of
        // offering to add it: the server would reject it after the whole create form.
        if (code.length > MAX_BARCODE_LENGTH) {
            currentCode.current = code;
            setProduct(null);
            setUnknown(null);
            setError(`That is too long to be a product code (over ${MAX_BARCODE_LENGTH} characters). It's probably a QR with something else inside.`);
            return;
        }

        if (looksLikeUrl(code)) {
            currentCode.current = code;
            setProduct(null);
            setUnknown(null);
            setError('That code is a URL: it looks like an invoice QR, not a product. Read invoices from the Invoices screen.');
            return;
        }

        if (searching.current) return;
        searching.current = true;
        setError(null);
        setConfirm(null);
        setAdded(null);
        try {
            const api = await requestJson<ProductApi>(
                `/api/products/by-code?code=${encodeURIComponent(code)}`);
            // Left before the modal opened and arrived after: drop it (see `addingRef`). `codeAdded`
            // lowers the ref before resolving, so its own query goes through.
            if (addingRef.current) return;
            currentCode.current = code;
            setProduct(toProduct(api));
            setUnknown(null);
            setQuantity('1');
            setDirection(null);
        } catch (e) {
            if (isAborted(e) || addingRef.current) return;
            if (e instanceof ApiError && e.status === 404) {
                currentCode.current = code;
                setProduct(null);
                setUnknown(code);
            } else {
                setError(e instanceof ApiError ? e.message : 'Could not look up the code');
            }
        } finally {
            searching.current = false;
        }
    }, []);

    function publishLenses(all: Device[]) {
        lensesRef.current = all;
        setLenses(usableLenses(all, bad.current));
    }

    // Start over: the person tapped Scan or switched sides. Forget the attempts and the bad lenses
    // (a failure from a while ago needn't repeat).
    function startOver() {
        watcher.rearm();
        bad.current.clear();
    }

    async function turnOnCamera(chosen: Side = side, lensId?: string) {
        setError(null);
        if (!support.secure) {
            setError('The camera only works over HTTPS or on localhost. For now, type the code by hand.');
            return;
        }
        preloadReader();
        const mine = ++openCount.current;
        setOpening(true);
        try {
            const s = await openCamera(chosen, lensId);
            // While opening, someone turned it off, switched sides or tapped again: this one is no longer current (see `openCount`).
            if (mine !== openCount.current) {
                s.getTracks().forEach(t => t.stop());
                return;
            }
            stream.current = s;
            if (video.current) {
                video.current.srcObject = s;
                const start = video.current.play();
                await (lensId ? Promise.race([start, noFrames(FIRST_FRAME_WAIT_MS)]) : start);
            }
            if (mine !== openCount.current) {
                s.getTracks().forEach(t => t.stop());
                if (stream.current === s) stream.current = null;
                return;
            }
            setMirror(!isRearCamera(s));
            currentLens.current = streamLensId(s);
            setShownLens(currentLens.current);
            setCameraLive(true);
            setOpening(false);
            // Lenses are listed with the camera already open (before permission browsers hide the names)
            // and only the rear ones: the front camera and webcams have no lenses to alternate.
            if (isRearCamera(s)) {
                getRearLenses().then(l => {
                    if (mine !== openCount.current) return;
                    publishLenses(l);
                }, () => { /* no list: the lens that opened stays, and the "no image" warning still works */ });
            } else {
                publishLenses([]);
            }
            // Rear or front is only offered if the device says which side its camera is on. Computer
            // cameras don't: with two webcams, "Front" and "Rear" opened the same one.
            const hasSide = Boolean(s.getVideoTracks()[0]?.getSettings().facingMode);
            countCameras().then(n => setMultipleCameras(hasSide && n > 1), () => setMultipleCameras(false));
        } catch (e) {
            // A failure from an opening that's no longer current isn't the screen's business.
            if (mine !== openCount.current) return;
            // If the camera opened but the video didn't start, release it or the LED stays on with no reading.
            turnOffCamera();
            // A specific lens that failed (id changed, taken by another app, a non-camera sensor, or it
            // opened and gave no frames) doesn't leave the person without a camera: mark it bad and go to
            // the NEXT one. Going straight back to the origin lens picked the one that had just failed.
            // Only when none is left do we return to the one the browser picks by side.
            if (lensId) {
                bad.current.add(lensId);
                publishLenses(lensesRef.current);
                const other = nextLens(lensesRef.current, lensId, bad.current);
                turnOnCamera(chosen, other?.deviceId);
                return;
            }
            setError(whyCameraFailed(e));
        }
    }

    function changeSide(next: Side) {
        if (next === side) return;
        setSide(next);
        saveSide(next);
        turnOffCamera();
        startOver();
        turnOnCamera(next);
    }

    // Move to the next rear lens. The person asks with the button, or the screen does it when the
    // watcher sees a covered image (then it says so, because the image changes suddenly).
    function otherLens(automatic: boolean) {
        const next = nextLens(lensesRef.current, currentLens.current, bad.current);
        if (!next) return;
        turnOffCamera();
        // The button is a new decision: automatic attempts start from zero (bad lenses are still skipped:
        // what didn't open a moment ago won't because a button was tapped).
        if (!automatic) watcher.rearm();
        if (automatic) setLensNotice('A lens was covered or had no light, so I switched to another.');
        turnOnCamera('environment', next.deviceId);
    }
    // The watcher runs inside an interval that isn't recreated per render; this ref hands it the current `otherLens`.
    const onCovered = useRef<() => void>(() => {});
    useEffect(() => { onCovered.current = () => otherLens(true); });

    // The code now has an owner (linked or created). Resolve it like any scan, so the product comes with
    // the balance of the moment and the movement goes through the same path.
    async function codeAdded(code: string, result: NewCodeResult) {
        openAdd(null);
        // Without this reset, resolve() would see the same code already on screen and not query it again.
        currentCode.current = null;
        setUnknown(null);
        await resolve(code);
        setAdded(result);
    }

    // What the camera and USB reader read comes in here and shows in the entry field like typed text.
    // With the add modal open it isn't resolved (see `addingRef`).
    const onRead = useCallback((read: string) => {
        if (addingRef.current) return;
        setRawCode(read);
        resolve(read);
    }, [resolve]);

    // Read loop while the camera is on. Cadence and native-vs-fallback detector are in `scanner.ts`.
    useEffect(() => {
        if (!cameraLive || !video.current) return;
        return readFromVideo(video.current, onRead,
            () => {
                // Without a reader there's no point keeping the camera on burning battery.
                turnOffCamera();
                setError('The code reader did not respond. Type the code by hand or turn the camera on again.');
            });
    }, [cameraLive, onRead, turnOffCamera]);

    // While the camera is on, measure the image to notice a covered lens (what counts as "covered" and
    // when to switch is in `cameras.ts`). Kept apart from code reading: neither depends on the other.
    useEffect(() => {
        if (!cameraLive || !video.current) return;
        watcher.restart(performance.now());
        return watchImage(video.current, (m, now) => {
            if (diagnostic) setMeasure(m);
            const verdict = watcher.sample(m, now, usableLenses(lensesRef.current, bad.current).length);
            if (verdict === 'switch') {
                // The new lens gets its grace period; otherwise its first dark sample would count against the old one.
                watcher.restart(now);
                onCovered.current();
            } else if (verdict === 'no-image') setNoImage(true);
            else if (verdict === 'image') setNoImage(false);
        }, () => watcher.restart(performance.now()));
    }, [cameraLive, watcher, diagnostic]);

    // The USB reader types like a keyboard. It's listened to on the whole screen so nobody has to click
    // the field first; how it's told apart from typing is in `scanner.ts`. With the modal open, what it
    // fires stays in the modal's field.
    useEffect(() => listenUsbReader(onRead, () => !addingRef.current), [onRead]);

    const amount = Number(quantity);
    const quantityIssue = product ? quantityProblem(quantity, product.unit, false) : null;
    const quantityValid = quantity.trim() !== '' && quantityIssue === null;

    // `levelStateOf` decides whether the stored balance means anything. A product with a pending count is
    // at zero because nobody counted it, not because there's none; subtracting from it gives a number
    // that looks like a fact and isn't.
    const levelState = product ? levelStateOf(product) : null;
    const uncounted = levelState?.level === 'uncounted';
    // Same for items with no stock tracking (discs, electrodes, gases): their `quantity` moves but means
    // nothing, and "Will be −1" on the first gas out was exactly the negative that must not appear.
    const hasBalance = product !== null && balanceKnown(product);
    const resultingBalance = product ? product.quantity + (direction === 'in' ? amount : -amount) : 0;
    // With no known balance there's no negative to warn about or confirm: the server exempts both cases.
    const leavesNegative = hasBalance && direction === 'out' && resultingBalance < 0;
    const ready = product !== null && quantityValid && direction !== null && responsible !== null && !sending;

    async function record(force = false) {
        if (!product || !ready) return;
        setSending(true);
        setError(null);
        try {
            const r = await requestJson<{ new_balance: number }>('/api/movements', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    product_id: product.id,
                    type: direction,
                    quantity: amount,
                    responsible_id: responsible?.id,
                    ...((leavesNegative || force) ? { allow_negative: true } : {}),
                }),
            });

            setRecorded(previous => [{
                id: Date.now(), code: product.code, name: product.name,
                quantity: amount, unit: product.unit, direction: direction!,
                who: responsible?.name ?? user.name, balance: hasBalance ? r.new_balance : null,
                noBalance: product.control_type === 'no_balance',
            }, ...previous].slice(0, 12));

            // The balance changed: cached inventory, log and summary are stale. Mark them old without
            // waiting, so the line at the window doesn't.
            queries.invalidateQueries({ queryKey: ['products'] });
            queries.invalidateQueries({ queryKey: ['movements'] });
            queries.invalidateQueries({ queryKey: ['summary'] });

            // The product is cleared but the PERSON isn't: at the window it's often the same one taking
            // several things in a row. `currentCode` IS cleared, so scanning the same item again (another
            // piece, a return) resolves as a new transaction instead of being dropped by the lock.
            currentCode.current = null;
            setProduct(null);
            setRawCode('');
            setDirection(null);
            setConfirm(null);
            setQuantity('1');
        } catch (e) {
            if (e instanceof ApiError && e.status === 409
                && (e.body as { error_code?: string })?.error_code === 'negative_balance') {
                const c = e.body as { current_balance: number; resulting_balance: number };
                // The server only answers 409 for a counted product, so if we thought it uncounted,
                // someone counted it while this was being entered. Mark it counted and show the server's
                // numbers, which are the ones being confirmed.
                setConfirm(
                    `The balance changed while you were entering this: it is now ${formatQuantity(c.current_balance)}. `
                    + `This movement out would leave it at ${formatQuantity(c.resulting_balance)}.`);
                setProduct({ ...product, quantity: c.current_balance, count_pending: false });
            } else {
                setError(e instanceof ApiError ? e.message : 'Could not record the movement');
            }
        } finally {
            setSending(false);
        }
    }

    return <section className="page stack movement-page">
        <div className="page-heading">
            <div><h1>Scan</h1></div>
            <Button kind="ghost" onClick={onBack}>Inventory</Button>
        </div>

        <Tile className="panel stack">
            <div className={'scan-camera' + (mirror ? ' scan-camera--mirror' : '')}>
                {/* iPhone Safari needs playsInline and muted: without playsInline the video goes
                    fullscreen and covers the form; without muted it may refuse to play. */}
                <video ref={video} playsInline muted />
                {!cameraLive && <p className="muted">{opening ? 'Opening camera…' : 'Camera off'}</p>}
            </div>
            {/* Rear or front, and only if there is a choice; see `openCamera` in scanner.ts for why devices aren't listed. */}
            {(cameraLive || opening) && multipleCameras && <ContentSwitcher size="md" aria-label="Camera"
                selectedIndex={side === 'user' ? 1 : 0}
                onChange={({ name }) => changeSide(name === 'user' ? 'user' : 'environment')}>
                <Switch name="environment" text="Rear" />
                <Switch name="user" text="Front" />
            </ContentSwitcher>}
            {/* Several rear lenses: the screen switches by itself when one is covered, and this button is
                the manual way (a lens that focuses badly, say). Names aren't listed ("camera2 2" tells
                nobody anything): tap and see if the image improves. */}
            {(cameraLive || opening) && !mirror && lenses.length > 1 && <div className="row">
                {/* Stays on screen (disabled) while the new lens opens: if it vanished, the Stop row would
                    jump up under the finger and a second tap would turn the camera off. */}
                <Button kind="ghost" size="sm" renderIcon={Renew} disabled={opening} onClick={() => otherLens(false)}>
                    Another lens ({Math.max(lenses.findIndex(l => l.deviceId === shownLens), 0) + 1} of {lenses.length})
                </Button>
            </div>}
            {cameraLive && lensNotice && <p className="muted">{lensNotice}</p>}
            {cameraLive && noImage && <InlineNotification kind="warning" lowContrast hideCloseButton
                title="No image from the camera"
                subtitle={(lenses.length > 1 ? 'I tried every rear lens. ' : '')
                    + 'It is covered or there is no light: uncover it or turn on a light.'} />}
            {diagnostic && cameraLive && <p className="muted mono">
                {measure
                    ? <>light {measure.mean.toFixed(0)} · detail {measure.deviation.toFixed(1)} · red/blue {(measure.red / Math.max(measure.blue, 1)).toFixed(2)} · {isCovered(measure) ? 'COVERED' : 'ok'}</>
                    : 'measuring…'}
                {' · '}lens {Math.max(lenses.findIndex(l => l.deviceId === shownLens), 0) + 1}/{lenses.length}
                {lenses.find(l => l.deviceId === shownLens) ? ` (${lenses.find(l => l.deviceId === shownLens)?.label})` : ''}
            </p>}
            {/* While opening, offer Stop and not Scan: a second tap opened a second camera (see `openCount`). */}
            <div className="row">
                {!cameraLive && !opening
                    ? <Button renderIcon={Camera} onClick={() => { startOver(); turnOnCamera(); }}>Scan with camera</Button>
                    : <Button kind="tertiary" renderIcon={Close} onClick={turnOffCamera}>Stop</Button>}
            </div>

            <hr className="login__rule" />

            {/* Aligned to the BOTTOM with the button at the field's height: centered, the button (48 px)
                sat 8 px above the field's base (40 px), which has its label on top. */}
            <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={e => { e.preventDefault(); if (rawCode.trim()) resolve(rawCode.trim()); }}>
                <TextInput id="scan-manual" labelText="Type the code by hand" className="mono"
                    value={rawCode} onChange={e => setRawCode(e.target.value)}
                    placeholder="Barcode or internal code" />
                <Button type="submit" size="md" disabled={!rawCode.trim()}>Look up</Button>
            </form>
        </Tile>

        {/* Scrolled into view like the panels: on a phone the error of a scan sat below the camera and nothing seemed to happen. */}
        {error && <div key={`error:${error}`} ref={scrollIntoView}>
            <InlineNotification kind="error" title="Something failed" subtitle={error}
                onCloseButtonClick={() => setError(null)} />
        </div>}

        {/* A code that isn't in the system. It ASKS what to do instead of opening the modal itself: a shot
            at the wrong box (the serial number instead of the product code) shouldn't drop anyone into a create flow. */}
        {unknown && <Tile key={`unknown:${unknown}`} ref={scrollIntoView} className="panel stack">
            <h2>Unregistered code</h2>
            <p className="mono secret">{unknown}</p>
            {canLink && <div><Button renderIcon={Add} onClick={() => openAdd(unknown)}>Add this code</Button></div>}
        </Tile>}

        {added && <InlineNotification kind="success" lowContrast
            title={added.title} subtitle={added.detail}
            onCloseButtonClick={() => setAdded(null)} />}

        {product && levelState && <Tile key={`product:${product.id}`} ref={scrollIntoView} className="panel stack">
            <div>
                <p className="mono">{product.code}</p>
                <h2>{product.name}</h2>
                <StockState state={levelState} />
            </div>
            <StockBar state={levelState} />

            {/* Nothing preselected: the storekeeper has to say what is happening. A marked option would be the one recorded when someone is rushing. */}
            <RadioButtonGroup name="scan-direction" legendText="What are you doing?"
                valueSelected={direction ?? ''}
                onChange={v => setDirection(v as 'out' | 'in')}>
                <RadioButton labelText="Taking it out of the warehouse" value="out" id="scan-out" />
                <RadioButton labelText="Putting it into the warehouse" value="in" id="scan-in" />
            </RadioButtonGroup>

            <div className="form-grid">
                <TextInput id="scan-quantity" labelText={direction === 'in' ? 'Quantity coming in' : 'Quantity taken'} type="number"
                    min={0} step="any" inputMode="decimal" value={quantity}
                    onChange={e => { setQuantity(e.target.value); setConfirm(null); }}
                    invalid={quantityIssue !== null} invalidText={quantityIssue ?? undefined} />
                {peopleError && <div className="stack">
                    <InlineNotification kind="error" hideCloseButton
                        title="Could not load the list of people"
                        subtitle={peopleError + ' Without it you can\'t say who is taking the material.'} />
                    <Button kind="tertiary" onClick={() => peopleQuery.refetch()}>Retry</Button>
                </div>}
                <ComboBox id="scan-responsible" titleText={direction === 'in' ? 'Who is delivering it?' : 'Who is taking it?'}
                    placeholder="Choose the person"
                    items={people} itemToString={(u: UserListing | null) => u?.name ?? ''}
                    selectedItem={responsible}
                    onChange={({ selectedItem }) => setResponsible(selectedItem ?? null)} />
            </div>

            {quantityValid && !uncounted && hasBalance && <p className="muted">
                New balance: <strong>{formatQuantity(resultingBalance)} {product.unit}</strong>
            </p>}

            {leavesNegative && <InlineNotification kind="warning" lowContrast hideCloseButton
                title="Exceeds available stock" subtitle="Will record a negative balance." />}
            {confirm && <InlineNotification kind="warning" lowContrast hideCloseButton
                title="The balance changed" subtitle={confirm} />}

            <Button renderIcon={ArrowRight} disabled={!ready} onClick={() => record(confirm !== null)}>
                {sending ? 'Recording…'
                    : confirm ? 'Record anyway'
                        : direction === 'in' ? 'Record movement in' : 'Record movement out'}
            </Button>
        </Tile>}

        {recorded.length > 0 && <Tile className="panel stack">
            <h2>Recorded this session</h2>
            {recorded.map(r => <div key={r.id} className="recent-item">
                <div>
                    <p className="mono">{r.code}</p>
                    <p className="product-name">{r.name}</p>
                </div>
                <div>
                    <Tag type="gray">{r.who}</Tag>
                    <strong> {r.direction === 'in' ? '+' : '−'}{formatQuantity(r.quantity)} {r.unit}</strong>
                    <p className="muted">{r.balance !== null ? `${formatQuantity(r.balance)} left`
                        : r.noBalance ? 'no stock tracking' : 'uncounted'}</p>
                </div>
            </div>)}
        </Tile>}

        {adding !== null && <NewCodeModal key={`modal:${adding}`} code={adding}
            onClose={() => openAdd(null)}
            onDone={result => { void codeAdded(adding, result); }} />}
    </section>;
}
