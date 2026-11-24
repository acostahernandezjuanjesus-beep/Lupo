import type { ProductApi, Product } from './types'
import { currentToken, clearSession } from './session'

/** API error with the status and body already parsed, so "the server said no" differs from "no server". */
export class ApiError extends Error {
    status: number
    body: unknown

    constructor(message: string, status: number, body: unknown) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.body = body
    }
}

// A session can die without the client knowing (shift expired, admin deactivated the user), so the app
// registers a callback to go back to the login screen when a request comes back 401.
let onSessionLost: (() => void) | null = null

export function setSessionLostHandler(fn: (() => void) | null) {
    onSessionLost = fn
}

/** fetch + JSON with errors unwrapped and the token attached. A bare `r.json()` treats a 500 as success. */
export async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
    // The token is attached here, not per call: someone would eventually forget.
    const token = currentToken()
    const headers = new Headers(options.headers)
    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`)
    }

    const res = await fetch(url, { ...options, headers })
    const text = await res.text()

    let body: unknown = null
    if (text) {
        try {
            body = JSON.parse(text)
        } catch {
            body = text
        }
    }

    if (!res.ok) {
        const message =
            body && typeof body === 'object' && 'error' in body
                ? String((body as { error: unknown }).error)
                : typeof body === 'string' && body
                    ? body
                    : `Error ${res.status}`

        // A 401 on a request that carried a token means the session is gone: clear it so a dead token doesn't keep 401ing.
        if (res.status === 401 && token) {
            clearSession()
            onSessionLost?.()
        }

        // On a server failure the request id is appended; its first 8 chars find the exact log line.
        const ref = res.status >= 500 ? res.headers.get('X-Request-Id') : null
        throw new ApiError(ref ? `${message} (ref ${ref.slice(0, 8)})` : message, res.status, body)
    }

    return body as T
}

/** A cancelled request is not a failure. */
export const isAborted = (e: unknown): boolean =>
    e instanceof DOMException && e.name === 'AbortError'

const toNumber = (value: string | null): number | null => {
    if (value === null) return null
    const n = parseFloat(value)
    return isNaN(n) ? null : n
}

export const toProduct = (api: ProductApi): Product => ({
    id: api.id,
    code: api.code,
    name: api.name,
    quantity: parseFloat(api.quantity),
    // If the server left the key out, don't invent one: the screen omits the value instead of showing a dash.
    ...(api.price !== undefined ? { price: toNumber(api.price) } : {}),
    // Stays text: the book has thousandths and a Number would round them.
    ...(api.last_purchase !== undefined ? { last_purchase: api.last_purchase } : {}),
    unit: api.unit,
    location: api.location,
    minimum: toNumber(api.minimum),
    category_id: api.category_id,
    count_pending: api.count_pending,
    restock_control: api.restock_control,
    control_type: api.control_type,
    brand: api.brand,
    group_name: api.group_name,
    category: api.category,
    ...(api.supplier_codes !== undefined ? { supplier_codes: api.supplier_codes } : {}),
})

// An <img> or <iframe> can't send the Authorization header, so protected files are fetched with the token and shown from a local blob.
async function fetchResponse(url: string): Promise<Response> {
    const token = currentToken()
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (res.status === 401 && token) { clearSession(); onSessionLost?.() }
    if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: unknown } | null
        throw new ApiError(typeof body?.error === 'string' ? body.error : `Error ${res.status}`, res.status, body)
    }
    return res
}

export const fetchFile = async (url: string): Promise<Blob> => (await fetchResponse(url)).blob()

/** Saves a protected file to the device under the name the server gave it. */
export async function downloadFile(url: string): Promise<string> {
    const res = await fetchResponse(url)
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'download'
    const link = document.createElement('a')
    link.href = URL.createObjectURL(await res.blob())
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
    return name
}

/** Uploads an original to an invoice. The body IS the file; the server checks what it really is. */
export async function uploadFile(invoiceId: number, file: Blob, name: string): Promise<{ id: number; mime: string }> {
    return requestJson(`/api/invoices/${invoiceId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': file.type, 'X-Name': encodeURIComponent(name) },
        body: file,
    })
}
