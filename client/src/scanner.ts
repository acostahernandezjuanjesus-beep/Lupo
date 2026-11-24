import type { IScannerControls } from '@zxing/browser';
import { rearLenses, measureFrame, type Device, type Measure } from './cameras';

// Reading codes from the camera video. The USB reader for the counter computer is at the bottom: `listenUsbReader`.
//
// `BarcodeDetector` is native in Android Chrome but missing from the typed DOM and from Safari (and from
// every Windows browser), so when it's absent ZXing (`@zxing/browser`) is loaded as a fallback with a
// dynamic import(), only then: ~480 KB (~127 KB gzipped) that phones with the native detector never download.
// Typing the code by hand is the way out if neither works.
type ReadCode = { rawValue: string; format: string };
type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<ReadCode[]> };
type DetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

export function detectorAvailable(): DetectorConstructor | null {
    const w = window as unknown as { BarcodeDetector?: DetectorConstructor };
    return typeof w.BarcodeDetector === 'function' ? w.BarcodeDetector : null;
}

// One place for the import(): Vite makes one chunk per module, so preloading and using ask for the same file.
// `@zxing/library` is the dependency `@zxing/browser` asks for separately; formats and hints come from it.
const loadZxing = () => Promise.all([import('@zxing/browser'), import('@zxing/library')]);

// Starts downloading the fallback while the browser asks for camera permission, so it reads from the first frame.
export function preloadReader() {
    if (!detectorAvailable()) loadZxing().catch(() => { /* readFromVideo reports it */ });
}

/** Which camera: the phone's back one or the one facing the user. */
export type Side = 'environment' | 'user';

// 1280x720 is asked as ideal, not required: many laptop cameras give 640x480 otherwise, and a barcode (unlike
// a QR) needs width so thin bars don't blur together.
//
// The user picks a SIDE, not a device: a phone's camera list reads "camera2 2, facing back" and nobody knows
// which is which. But a side opens ONE lens, and if it's covered the video goes black. So `lensId` opens a
// specific lens, chosen by the screen (see cameras.ts) when the watcher sees a covered image. The deviceId is
// asked EXACT, not ideal: otherwise the browser could open another lens and the switch would look done without
// being so. It can fail (stale id, busy lens); the screen marks it bad and moves on.
//
// After a lens switch Android may not have released the previous camera yet and the new one fails with
// `NotReadableError`; we retry once after 400 ms. A precaution, never seen on a real phone.
export async function openCamera(side: Side, lensId?: string): Promise<MediaStream> {
    const choice = lensId ? { deviceId: { exact: lensId } } : { facingMode: side };
    const ask = () => navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, ...choice },
    });
    try {
        return await ask();
    } catch (e) {
        if (!lensId || !(e instanceof DOMException) || e.name !== 'NotReadableError') throw e;
        await new Promise(done => setTimeout(done, 400));
        return ask();
    }
}

/** Rear lenses the browser lets us open. Call with the camera already open. */
export async function getRearLenses(): Promise<Device[]> {
    return rearLenses(await navigator.mediaDevices.enumerateDevices());
}

/** The id of the lens behind this stream, to know which one is next. */
export function streamLensId(stream: MediaStream): string | null {
    return stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;
}

// The image sample is tiny on purpose: light and detail need no more, and reading 768 points every 400 ms
// should be cheap (not measured on a phone). The reader still reads full frames.
const SAMPLE_WIDTH = 32;
const SAMPLE_HEIGHT = 24;
const SAMPLE_EVERY_MS = 400;

// Measures the video every 400 ms and hands it to `onMeasure` with the time (`performance.now()`); what to do
// with it is up to the watcher in cameras.ts. Returns the stop function.
//
// With the tab hidden or the track muted (locked screen, another app in front) nothing is measured: the
// browser stops delivering frames and black would read as a covered lens on return. `onPause` lets the
// watcher restart its grace period.
export function watchImage(
    video: HTMLVideoElement,
    onMeasure: (m: Measure, now: number) => void,
    onPause: () => void = () => {},
): () => void {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_WIDTH;
    canvas.height = SAMPLE_HEIGHT;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return () => {};
    // Assumption about Chrome, unmeasured: high quality averages when shrinking 1280x720 to 32x24, so sensor
    // noise of a covered lens doesn't look like "detail". Other browsers may ignore it, which is why the
    // "black" test in cameras.ts doesn't depend on deviation.
    ctx.imageSmoothingQuality = 'high';
    let active = true;
    const id = setInterval(() => {
        if (!active) return;
        const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
        if (document.hidden || (track && (track.muted || track.readyState !== 'live'))) { onPause(); return; }
        // No frames yet means nothing to measure; that isn't "covered".
        if (video.readyState < 2 || video.videoWidth === 0) return;
        try {
            ctx.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
            onMeasure(measureFrame(ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data), performance.now());
        } catch { /* an unreadable frame isn't worth reporting */ }
    }, SAMPLE_EVERY_MS);
    return () => { active = false; clearInterval(id); };
}

// Asked with the camera already open: before permission some browsers hide the devices.
export async function countCameras(): Promise<number> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'videoinput').length;
}

// The preview is mirrored except on a phone's rear camera. A laptop camera faces the user, and an unmirrored
// view moves the code left when the hand goes right. Only the display changes; the reader gets frames as-is.
export function isRearCamera(stream: MediaStream): boolean {
    return stream.getVideoTracks()[0]?.getSettings().facingMode === 'environment';
}

/** Why the camera didn't open, said so someone can fix it. */
export function whyCameraFailed(e: unknown): string {
    switch (e instanceof DOMException ? e.name : '') {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'Camera permission is denied. Allow it from the lock icon next to the address; on a computer, also check Windows Settings > Privacy > Camera.';
        case 'NotFoundError':
        case 'OverconstrainedError':
            return 'This device has no camera, or the browser can\'t see it. Use the USB reader or type the code.';
        case 'NotReadableError':
        case 'AbortError':
            return 'The camera is in use. Close it in the other app using it (Teams, Zoom, Windows Camera) and try again.';
        default:
            return 'Could not open the camera. Check the browser permission.';
    }
}

// Read cadence. An interval, not requestAnimationFrame, on purpose: 60 reads a second heats the phone
// without reading better. Three a second is plenty for a code someone is holding up. The fallback uses the
// same cadence: ZXing decodes in JavaScript and each frame costs more.
const READ_EVERY_MS = 330;

// Reads from the `<video>` already showing the camera and hands each code to `onRead`: same path for the
// native detector and the fallback, so the "already on screen" lock and URL rejection apply to both.
// `onFail` fires if the fallback couldn't load or stopped reading.
//
// Returns the stop function. Safe to call any time, even before the fallback finishes downloading:
// turning the camera off while it loads must not leave a reader running.
export function readFromVideo(
    video: HTMLVideoElement,
    onRead: (code: string) => void,
    onFail: () => void,
): () => void {
    const Detector = detectorAvailable();
    return Detector ? withDetector(new Detector(), video, onRead) : withZxing(video, onRead, onFail);
}

function withDetector(detector: BarcodeDetectorLike, video: HTMLVideoElement, onRead: (code: string) => void) {
    let active = true;
    const id = setInterval(async () => {
        if (!active || video.readyState < 2) return;
        try {
            const codes = await detector.detect(video);
            if (active && codes.length > 0) onRead(codes[0].rawValue);
        } catch { /* an unreadable frame isn't worth reporting */ }
    }, READ_EVERY_MS);
    return () => { active = false; clearInterval(id); };
}

function withZxing(video: HTMLVideoElement, onRead: (code: string) => void, onFail: () => void) {
    let active = true;
    let controls: IScannerControls | null = null;
    // Kept so the `resize` listener can be removed on stop.
    let onResize: (() => void) | null = null;

    loadZxing().then(([{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }]) => {
        if (!active) return;
        // Uses the SAME video and MediaStream the screen already opened, not one ZXing opens: turning the
        // camera off stays "stop our own tracks" and the reader only reads frames.
        const hints = new Map<number, unknown>([
            // ZXing tries every format on every frame; limiting them to what the warehouse has (EAN/UPC
            // packaging, Code 128/39 internal labels, the invoice QR that gets rejected later) makes each try cheaper.
            [DecodeHintType.POSSIBLE_FORMATS, [
                BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
                BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.QR_CODE,
            ]],
            // The saving is spent here: TRY_HARDER scans more rows and a rotated pass. On a 90-frame 1280x720
            // test it read 41 instead of 36, at 22 ms a frame instead of 4. Three tries a second hides that.
            // (zxing-cpp in WebAssembly read one more for ~950 KB: not worth it. Focus decides, not the
            // engine: past half a bar of blur neither reads.)
            [DecodeHintType.TRY_HARDER, true],
        ]);
        const reader = new BrowserMultiFormatReader(hints, {
            delayBetweenScanAttempts: READ_EVERY_MS,
            delayBetweenScanSuccess: READ_EVERY_MS,
        });

        // ZXing draws each frame on a canvas sized like the video at start. If the phone rotates the video
        // changes size and the canvas would crop it, so restart with the new size. With the video still 0x0
        // don't start; the same event fires once it has a size.
        const start = () => {
            controls?.stop();
            controls = null;
            if (!active || video.videoWidth === 0) return;
            try {
                controls = reader.scan(video,
                    result => { if (active && result) onRead(result.getText()); },
                    // `stop()` also calls this, without an error; only a real error stops reading unasked.
                    error => { if (active && error) onFail(); });
            } catch {
                onFail();
            }
        };
        onResize = start;
        video.addEventListener('resize', start);
        start();
    }).catch(() => { if (active) onFail(); });

    return () => {
        active = false;
        controls?.stop();
        if (onResize) video.removeEventListener('resize', onResize);
    };
}

// The USB reader on the counter computer.
//
// A USB reader is a keyboard: it types the code and sends Enter (or Tab). On its own that only works if
// someone clicked the capture field first, and if the cursor sat in "Quantity" the thirteen digits would
// stick to the quantity. So we listen to the whole page's keyboard and tell the reader apart by speed: it
// types a character in a few milliseconds, a person takes a hundred or more. Same criterion as
// public/reader.html; change the threshold in both.
//
// A recognised scan is NOT left in the field it landed in: the field gets its previous value back and the
// code goes to `onRead`, same path as camera and manual entry. The scan's Enter/Tab is stopped so it doesn't
// press the focused button or pick an option in an open dropdown.
//
// `takesReads` says whether the screen wants the code right now. If not (a modal working on another code)
// the text stays where it landed and only the terminator is stopped: scanning a bin label into the modal's
// search is the natural way to find the product.
//
// Without a terminator nothing is recognised: closing on silence would erase what a fast typist was writing.
// If a reader sends no Enter/Tab, configure it from its manual's code sheet; reader.html shows what it sends.
const MS_PER_KEY = 30;
// A pause longer than this starts another burst. Leaves room for the system to stall one reader character
// without splitting the code, and is still less than a person takes between two keys.
const BREAK_PAUSE = 100;
// Shortest accepted code. No warehouse label is that short, and three keys in a row at that speed can come
// from a fast typist.
const MIN_LENGTH = 4;
const MODIFIERS = new Set(['Shift', 'CapsLock', 'AltGraph']);

type TextField = HTMLInputElement | HTMLTextAreaElement;

export function listenUsbReader(
    onRead: (code: string) => void,
    takesReads: () => boolean = () => true,
): () => void {
    let text = '';
    let startedAt = 0;
    let last = 0;
    let field: TextField | null = null;
    let previousValue = '';

    const reset = () => { text = ''; field = null; };

    const onKey = (e: KeyboardEvent) => {
        const t = performance.now();
        if (e.isComposing || MODIFIERS.has(e.key)) return;
        if (text && t - last > BREAK_PAUSE) reset();

        if (e.key === 'Enter' || e.key === 'Tab') {
            // Same math as reader.html: first character to terminator, over the gaps between characters.
            const isReader = text.length >= MIN_LENGTH
                && (t - startedAt) / (text.length - 1) < MS_PER_KEY;
            if (isReader) {
                e.preventDefault();
                e.stopPropagation();
                // Give the field back first, then deliver the code: if the scan landed in the capture
                // field, whatever `onRead` writes there must come last.
                if (takesReads()) {
                    if (field) restoreValue(field, previousValue);
                    onRead(text);
                }
            }
            reset();
            return;
        }

        // Backspace, arrows, Ctrl shortcuts: a person does those. AltGr arrives as Ctrl+Alt on Windows and does type characters.
        const shortcut = (e.ctrlKey && !e.altKey) || e.metaKey;
        if (e.key.length !== 1 || shortcut || e.repeat) { reset(); return; }

        if (!text) {
            startedAt = t;
            field = textField(e.target);
            previousValue = field?.value ?? '';
        }
        text += e.key;
        last = t;
    };

    // Capture phase on `window`: runs before React and Carbon's dropdown, which pick with Enter in their own listener.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
}

function textField(target: EventTarget | null): TextField | null {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
}

// React keeps its own copy of a controlled field's value and drops an `input` event if the value matches it;
// assigning through the prototype's `set` makes it see a change and notify the screen's state.
function restoreValue(field: TextField, value: string) {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
}
