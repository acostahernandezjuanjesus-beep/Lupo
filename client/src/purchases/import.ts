export type ImportedStatus = 'new' | 'existing' | 'description_differs'

export type ProductMini = { id: number; code: string; name: string }

/** A similar name that already exists, from the same engine as Bring to catalog: only PROPOSED. */
export type NameSuggestion = {
    /** 'near_certain': the same form with other punctuation, or a similarity >= 0.9. */
    level: 'near_certain' | 'similar'
    similarity: number
    product: ProductMini
    similar_to: string
    /** False if neither name has numbers: can't claim "same measurements". */
    has_numbers: boolean
}

export type ImportedLine = {
    /** The Excel row (1-based). */
    row_num: number
    /** Lines with the same number belong to the same folio. */
    block: number
    status: ImportedStatus
    type: 'purchase' | 'no_amount'
    date: string | null
    date_status: string
    folio: string | null
    description: string
    quantity: string | null
    unit_price: string | null
    amount: string | null
    supplier: string | null
    supplier_id: number | null
    requester: string | null
    note: string | null
    /** What the catalog already recognizes for this description. */
    product: ProductMini | null
    suggestion: NameSuggestion | null
    /** Only for 'description_differs': how it's written in the database. */
    existing_description: string | null
}

export type ImportedSheet = { name: string; lines: ImportedLine[] }

export type UnlinkedSupplier = {
    name: string
    lines: number
    suggested: { id: number; name: string } | null
}

export type BookPreview = {
    file: string
    period: string
    sha256: string
    book_exists: boolean
    /** Name of the already-loaded book taken to be this one (the browser renamed the download); null if named the same. */
    matched_book: string | null
    other_books_of_month: string[]
    summary: {
        lines: number
        new_count: number
        existing_count: number
        description_differs: number
        new_amount: string
        new_recognized: number
        new_unrecognized: number
        new_no_supplier: number
        new_no_date: number
    }
    warnings: string[]
    /** What to know about the book's structure: a sheet that wasn't read, a missing or misplaced column. */
    notes: string[]
    unlinked_suppliers: UnlinkedSupplier[]
    sheets: ImportedSheet[]
}

export type ImportResult = {
    book_id: number
    file: string
    period: string
    inserted: number
    existing_count: number
    description_differs: number
    links_created: number
    links_skipped: string[]
    amount: string
}

/** An import already done, as the history lists it. */
export type BookImport = {
    id: number
    file: string
    done_at: string
    new_count: number
    existing_count: number
    links_created: number
    undone_at: string | null
    user_name: string | null
    undone_by: string | null
    /** Lines still in the database that this import brought. */
    lines: number
    with_movement: number
    amount: string | null
    /** Why it can't be undone; null if it can (or it was already undone). */
    undo_blocked_reason: string | null
}

export type UndoResult = { ok: true; lines: number; links: number; amount: string; book_deleted: boolean }

/** The file in base64, in chunks: `String.fromCharCode(...bytes)` on a whole file blows the stack. */
export async function toBase64(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let text = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(text)
}
