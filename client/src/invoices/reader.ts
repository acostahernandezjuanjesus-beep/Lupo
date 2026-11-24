// Reading an invoice that arrives as a file: XML (the server reads it), PDF or photo (the CFDI QR is
// decoded from it). All of it runs in the browser and none of it uses AI: the QR decodes or it
// doesn't. If it fails the person continues by hand; a doubtful reading is never filled in.

/** Max side of a photo before saving or reading it: 2400 px is plenty for a QR and shrinks a 4–8 MB phone file to hundreds of KB. */
const MAX_SIDE = 2400

export type Page = { url: string; width: number; height: number }

function newCanvas(width: number, height: number) {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(width))
    c.height = Math.max(1, Math.round(height))
    return c
}

/** An image to a canvas, respecting EXIF orientation (createImageBitmap applies it). */
export async function imageToCanvas(blob: Blob, maxSide = MAX_SIDE): Promise<HTMLCanvasElement> {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    const f = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
    const canvas = newCanvas(bmp.width * f, bmp.height * f)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    return canvas
}

export const canvasToJpeg = (canvas: HTMLCanvasElement, quality = 0.85) =>
    new Promise<Blob>((ok, fail) => canvas.toBlob(b => b ? ok(b) : fail(new Error('Could not convert the image')), 'image/jpeg', quality))

type NativeDetector = new (o: { formats: string[] }) => { detect(i: CanvasImageSource): Promise<{ rawValue: string }[]> }

/** Tries to decode a QR from the canvas: the native detector first (Android Chrome), then ZXing. */
async function qrFromCanvasOnce(canvas: HTMLCanvasElement): Promise<string | null> {
    const native = (window as unknown as { BarcodeDetector?: NativeDetector }).BarcodeDetector
    if (native) {
        try {
            const r = await new native({ formats: ['qr_code'] }).detect(canvas)
            if (r[0]?.rawValue) return r[0].rawValue
        } catch { /* the detector couldn't handle this image: ZXing is next */ }
    }
    // ZXing loads only when needed: browsers with a native detector never download it.
    const [{ BrowserQRCodeReader }, { DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')])
    const reader = new BrowserQRCodeReader(new Map([[DecodeHintType.TRY_HARDER, true]]))
    try {
        return reader.decodeFromCanvas(canvas).getText()
    } catch {
        return null
    }
}

/** Looks for the QR at several sizes: an invoice QR is ~3 cm, and in a full photo it sometimes reads better shrunk (less grain), sometimes at full size. */
export async function findQr(canvas: HTMLCanvasElement): Promise<string | null> {
    for (const f of [1, 0.66, 0.4]) {
        const c = f === 1 ? canvas : newCanvas(canvas.width * f, canvas.height * f)
        if (f !== 1) c.getContext('2d')!.drawImage(canvas, 0, 0, c.width, c.height)
        const t = await qrFromCanvasOnce(c)
        if (t) return t
    }
    return null
}

/** The pages of a PDF as canvases, to view them and look for the QR. */
export async function pdfPages(data: ArrayBuffer, width = 1600): Promise<HTMLCanvasElement[]> {
    // pdf.js weighs ~1 MB with its worker, so it's only downloaded when a PDF is opened.
    // The `legacy` build: the regular one needs `Map.prototype.getOrInsertComputed` (Chrome 145+) and fails on older browsers.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default
    }
    const task = pdfjs.getDocument({ data: new Uint8Array(data) })
    const pdf = await task.promise
    const pages: HTMLCanvasElement[] = []
    try {
        for (let n = 1; n <= Math.min(pdf.numPages, 12); n++) {
            const page = await pdf.getPage(n)
            const base = page.getViewport({ scale: 1 })
            const view = page.getViewport({ scale: width / base.width })
            const canvas = newCanvas(view.width, view.height)
            await page.render({ canvas, viewport: view }).promise
            pages.push(canvas)
        }
    } finally {
        await task.destroy()
    }
    return pages
}

/** The QR of a PDF, searched from the last page to the first (the CFDI prints it at the end). */
export async function qrFromPages(pages: HTMLCanvasElement[]): Promise<string | null> {
    for (const p of [...pages].reverse()) {
        const t = await findQr(p)
        if (t) return t
    }
    return null
}

export const canvasToUrl = (canvas: HTMLCanvasElement) => canvasToJpeg(canvas, 0.9).then(b => URL.createObjectURL(b))

/**
 * Cuts a page into overlapping horizontal strips, returned as base64 JPEGs for the AI reader.
 * With the whole page the model gets ~1,100 image tokens whatever the size and invents what it
 * can't see; a strip spends that budget on a few lines. The overlap (35%) makes every line fall
 * whole in at least one strip, and lets two strips read it so they can be compared.
 */
export function cutStrips(canvas: HTMLCanvasElement, n = 8, overlap = 0.35, width = 2000): string[] {
    const height = canvas.height / (1 + (n - 1) * (1 - overlap))
    const step = height * (1 - overlap)
    const strips: string[] = []
    for (let i = 0; i < n; i++) {
        const y0 = Math.round(i * step)
        const h = Math.min(Math.round(height), canvas.height - y0)
        if (h < 20) break
        const out = newCanvas(width, (h * width) / canvas.width)
        out.getContext('2d')!.drawImage(canvas, 0, y0, canvas.width, h, 0, 0, out.width, out.height)
        strips.push(out.toDataURL('image/jpeg', 0.85).split(',')[1])
    }
    return strips
}
