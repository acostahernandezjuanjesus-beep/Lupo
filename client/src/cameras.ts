// Rear lenses of a phone and how to tell one is covered. Pure module (no DOM, no React) so it can be
// tested in Node; what touches the browser lives in scanner.ts.
//
// A phone has three or four rear lenses and the native camera app hops between them when one is covered.
// The browser can't: `facingMode: 'environment'` opens ONE, and if a finger covers it the video goes black.
// So we imitate it: notice the image is covered and open another lens from the list.

export type Device = { deviceId: string; label: string; kind: string };

// How browsers say a camera faces back: Android Chrome "camera2 0, facing back", iPhone Safari "Back Camera"
// (localized too, e.g. "Cámara trasera"). Laptop cameras don't say, so they stay out: no lenses to alternate.
const IS_REAR = /\b(back|rear|environment)\b|trasera|posterior/i;

// Rear lenses in browser order. Without a deviceId they can't be opened (before the camera permission
// browsers return empty labels and ids).
export function rearLenses(devices: Device[]): Device[] {
    return devices.filter(d => d.kind === 'videoinput' && d.deviceId !== '' && IS_REAR.test(d.label));
}

// The lens after the current one, wrapping around and SKIPPING `bad` ones (listed by the browser but never
// opened: depth sensors, a busy lens). Null if there's nothing else to try. If the current id isn't in the
// list (it changed), start from the first.
export function nextLens(
    lenses: Device[], currentId: string | null, bad: ReadonlySet<string> = new Set(),
): Device | null {
    const n = lenses.length;
    if (n < 2) return null;
    const i = lenses.findIndex(l => l.deviceId === currentId);
    for (let step = 1; step <= n; step++) {
        const candidate = lenses[(i + step) % n];
        if (candidate.deviceId !== currentId && !bad.has(candidate.deviceId)) return candidate;
    }
    return null;
}

export function usableLenses(lenses: Device[], bad: ReadonlySet<string>): Device[] {
    return lenses.filter(l => !bad.has(l.deviceId));
}

/** Mean luminance and its spread (0-255), plus average red and blue of a frame. */
export type Measure = { mean: number; deviation: number; red: number; blue: number };

// Takes RGBA like `getImageData`. An empty frame measures as a bright, detailed image on purpose:
// "couldn't measure" must not read as "covered".
export function measureFrame(rgba: ArrayLike<number>): Measure {
    const n = Math.floor(rgba.length / 4);
    if (n === 0) return { mean: 255, deviation: 255, red: 255, blue: 255 };
    let sum = 0, sum2 = 0, red = 0, blue = 0;
    for (let i = 0; i < n * 4; i += 4) {
        const light = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
        sum += light;
        sum2 += light * light;
        red += rgba[i];
        blue += rgba[i + 2];
    }
    const mean = sum / n;
    return { mean, deviation: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), red: red / n, blue: blue / n };
}

// Thresholds come from what a covered lens is EXPECTED to do, not from real measurements on a phone.
// The scan screen shows the live measure with `?cameradiag=1` so these can be tuned instead of guessed.
//
// Black: taped, case, or palm pressed on it; the sensor gets almost no light.
const BLACK_MEAN = 10;
// Flat and dark: a finger lets little, even reddish light through. In strong light a finger can look bright
// orange and NOT be detected (that's what the "Other lens" button is for). A bright blank wall doesn't
// qualify either, which keeps it from switching lenses when you just point at nothing.
const DARK_MEAN = 60;
const FLAT_DEVIATION = 6;

export function isCovered(m: Measure): boolean {
    return m.mean < BLACK_MEAN || (m.mean < DARK_MEAN && m.deviation < FLAT_DEVIATION);
}

// Auto-exposure takes a while, so the first frames are dark even with a free lens; without this grace
// period every start would look covered.
const GRACE_MS = 1500;
// Dark samples in a row needed. At one per 400 ms (scanner.ts) that's ~1.2 s: a passing shadow or glove
// must not switch lenses.
const DARK_IN_A_ROW = 3;
// And bright ones in a row to call the image recovered. With one, a scene right at the threshold reset the
// attempts on every bright sample and the screen kept switching lenses forever.
const BRIGHT_IN_A_ROW = 3;

/**
 * What to do with the latest sample:
 *  - `image`     the image is back (3 bright in a row): reset everything and clear the warning.
 *  - `wait`      nothing to do yet (in grace, counting, or already warned).
 *  - `switch`    move to another lens.
 *  - `no-image`  no lens gives an image: say so once and stop trying.
 */
export type Verdict = 'image' | 'wait' | 'switch' | 'no-image';

export type Watcher = {
    /** Camera started or lens switched: the grace period starts again. Attempts are kept. */
    restart(now: number): void;
    /** The user started over (tapped Scan): forget everything, attempts too. */
    rearm(): void;
    /** `lenses` is how many rear lenses there are to alternate (0 if unknown or another camera). */
    sample(m: Measure, now: number, lenses: number): Verdict;
};

// Lives apart from the <video> because attempts must survive a lens switch: if each new lens started from
// zero, covering all of them would loop forever in silence.
export function createWatcher(): Watcher {
    let since = 0;
    let inARow = 0;
    let bright = 0;
    let attempts = 0;
    let warned = false;
    return {
        restart(now) { since = now; inARow = 0; bright = 0; },
        rearm() { inARow = 0; bright = 0; attempts = 0; warned = false; },
        sample(m, now, lenses) {
            if (now - since < GRACE_MS) return 'wait';
            if (!isCovered(m)) {
                inARow = 0;
                if (++bright < BRIGHT_IN_A_ROW) return 'wait';
                attempts = 0;
                warned = false;
                return 'image';
            }
            bright = 0;
            if (++inARow < DARK_IN_A_ROW) return 'wait';
            inARow = 0;
            if (attempts < lenses - 1) { attempts++; return 'switch'; }
            if (warned) return 'wait';
            warned = true;
            return 'no-image';
        },
    };
}
