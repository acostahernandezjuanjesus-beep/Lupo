import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, InlineLoading, InlineNotification } from '@carbon/react'
import { fetchFile } from '../../api'
import { errorMessage } from '../../queries'
import { canvasToUrl, pdfPages } from '../../invoices/reader'
import type { InvoiceFile } from '../../invoices/types'

// The file is fetched with the token and shown from a local blob: an <iframe> or <img> pointing at the URL
// wouldn't send Authorization and the server would answer 401. PDFs are drawn with pdf.js instead of embedded
// because embedded PDF viewers hardly ever work on phones.

type View =
    | { kind: 'images'; urls: string[] }
    | { kind: 'text'; text: string }

/** Indented XML so it can be read. If it can't be parsed, it's shown as is. */
function formatXml(xml: string): string {
    try {
        const doc = new DOMParser().parseFromString(xml, 'application/xml')
        if (doc.querySelector('parsererror')) return xml
        const out: string[] = []
        const walk = (n: Element, level: number) => {
            const attrs = [...n.attributes].map(a => ` ${a.name}="${a.value}"`).join('')
            const children = [...n.children]
            const pad = '  '.repeat(level)
            if (children.length === 0) out.push(`${pad}<${n.nodeName}${attrs}${n.textContent ? `>${n.textContent}</${n.nodeName}>` : '/>'}`)
            else {
                out.push(`${pad}<${n.nodeName}${attrs}>`)
                children.forEach(c => walk(c, level + 1))
                out.push(`${pad}</${n.nodeName}>`)
            }
        }
        walk(doc.documentElement, 0)
        return out.join('\n')
    } catch {
        return xml
    }
}

const ZOOMS = [50, 75, 100, 125, 150, 200, 300]

export function FileViewer({ file }: { file: InvoiceFile }) {
    const [blob, setBlob] = useState<Blob | null>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let current = true
        fetchFile(`/api/invoices/files/${file.id}`)
            .then(b => { if (current) { setBlob(b); setError(null) } })
            .catch(e => { if (current) { setBlob(null); setError(errorMessage(e)) } })
        return () => { current = false }
    }, [file.id])

    if (error) return <InlineNotification kind="error" title="Could not open the file" subtitle={error} hideCloseButton />
    if (!blob) return <InlineLoading description="Opening the file…" />
    return <BlobViewer blob={blob} name={file.name} mime={file.mime} />
}

/** Same viewer for a file that isn't saved yet (the preview while capturing an invoice). */
export function BlobViewer({ blob, name, mime, height = '70vh' }: { blob: Blob; name: string; mime: string; height?: string }) {
    const [view, setView] = useState<View | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [full, setFull] = useState(false)
    const [zoom, setZoom] = useState(100)

    useEffect(() => {
        let current = true
        const urls: string[] = []
        ;(async (): Promise<View> => {
            if (mime === 'application/xml') return { kind: 'text', text: formatXml(await blob.text()) }
            if (mime === 'application/pdf') {
                // Drawn at 2200 px wide so zooming in fullscreen stays legible without re-rendering.
                const pages = await pdfPages(await blob.arrayBuffer(), 2200)
                for (const p of pages) urls.push(await canvasToUrl(p))
                return { kind: 'images', urls: [...urls] }
            }
            urls.push(URL.createObjectURL(blob))
            return { kind: 'images', urls: [...urls] }
        })()
            .then(v => { if (current) { setView(v); setError(null) } })
            .catch(e => { if (current) { setView(null); setError(errorMessage(e)) } })
        return () => { current = false; urls.forEach(u => URL.revokeObjectURL(u)) }
    }, [blob, mime])

    // Esc closes only the fullscreen view, not the modal underneath.
    useEffect(() => {
        if (!full) return
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setFull(false) } }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [full])

    const download = () => {
        if (!blob) return
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob); a.download = name; a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
    }
    // The browser opens the original PDF in its own viewer (search text, print).
    const openSeparately = () => {
        if (!blob) return
        const u = URL.createObjectURL(blob)
        window.open(u, '_blank', 'noopener')
        setTimeout(() => URL.revokeObjectURL(u), 60_000)
    }
    const changeZoom = (d: number) => setZoom(z => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(z) + d))] ?? 100)

    if (error) return <InlineNotification kind="error" title="Could not open the file" subtitle={error} hideCloseButton />
    if (!view) return <InlineLoading description="Opening the file…" />

    const body = view.kind === 'text'
        ? <pre className={full ? 'm-0 min-h-full p-4 text-sm' : 'overflow-auto rounded-lg bg-layer p-3 text-xs'} style={full ? undefined : { maxHeight: height }}>{view.text}</pre>
        : <div className={full ? 'flex min-h-full w-max min-w-full flex-col items-center gap-4 p-4' : 'flex flex-col gap-3 overflow-auto rounded-lg bg-layer p-2'} style={full ? undefined : { maxHeight: height }}>
            {view.urls.map((u, i) => <img key={u} src={u} alt={`${name}, page ${i + 1}`} className="bg-white shadow-lg"
                style={full ? { width: `calc((100vw - 2rem - 15px) * ${zoom / 100})`, maxWidth: 'none' } : { width: '100%' }} />)}
        </div>

    const toolbar = <div className="flex flex-wrap items-center gap-2">
        {view.kind === 'images' && full && <>
            <Button kind="secondary" size="sm" onClick={() => changeZoom(-1)} disabled={zoom <= ZOOMS[0]}>−</Button>
            <span className="w-14 text-center text-sm">{zoom}%</span>
            <Button kind="secondary" size="sm" onClick={() => changeZoom(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]}>+</Button>
            <Button kind="ghost" size="sm" onClick={() => setZoom(100)}>Fit to width</Button>
        </>}
        <Button kind={full ? 'secondary' : 'ghost'} size="sm" onClick={download}>Download</Button>
        {mime === 'application/pdf' && <Button kind={full ? 'secondary' : 'ghost'} size="sm" onClick={openSeparately}>Open in new tab</Button>}
        <Button kind={full ? 'primary' : 'tertiary'} size="sm" onClick={() => setFull(c => !c)}>{full ? 'Close (Esc)' : 'Fullscreen'}</Button>
    </div>

    if (!full) return <div className="flex flex-col gap-2">{toolbar}{body}</div>
    // Own layer over the modal (a Carbon modal tops out at 'lg'), rendered in a portal to <body>: the modal
    // container has a transform, and `fixed` inside a transformed ancestor anchors to it, not the window.
    // React events bubble through the portal up to the Carbon modal, which reads them as a click outside and
    // closes, so they're stopped here.
    const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()
    return createPortal(<div role="dialog" aria-label={name} onMouseDown={stop} onClick={stop} onKeyDown={stop} className="fixed inset-0 z-[10000] flex flex-col bg-background">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-layer px-4 py-2">
            <strong className="min-w-0 truncate">{name}</strong>
            {toolbar}
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-background">{body}</div>
    </div>, document.body)
}
