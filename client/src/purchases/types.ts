import type { UncountedNewProduct, UncountedProduct } from '../newProduct';

// Contract of /api/purchases. Amounts, quantities and prices arrive as TEXT (PostgreSQL numeric):
// converting to Number can lose cents, so they're formatted with `money()`. `null` means "unknown"
// and shows as —, never 0.

/** Book month, 'YYYY-MM'. The period is counted by the book, not by the line's date. */
export type Month = string;

export type ControlType = 'unit' | 'stock' | 'no_balance';

export type PurchaseBook = {
    id: number;
    file: string;
    period: Month;
    /** Purchase lines only; the no-amount ones and the notes are separate. */
    lines: number;
    no_amount: number;
    notes: number;
    amount: string | null;
    first_date: string | null;
    last_date: string | null;
};

export type GroupBy = 'supplier' | 'category' | 'month' | 'book';

export type CountAmount = { purchases: number; amount: string | null };

export type RecentPurchase = { date: string; folio: string | null; supplier: string | null; lines: number; amount: string };

type PriceSide = { price: string; date: string; supplier: string | null };

/** The price of a description's latest purchase against the one before it. `change` is a signed %. */
export type PriceChange = { name: string; code: string | null; previous: PriceSide; latest: PriceSide; change: number };

export type RecentPurchases = { latest: RecentPurchase[]; prices: PriceChange[] };

/** A catalog supplier (`id`) or one only written in the book lines (`id` null). */
export type SupplierSummary = {
    id: number | null; name: string; in_catalog: boolean; lines: number; amount: string | null; last_date: string | null;
    rfc?: string | null; archived?: boolean;
    /** What the supplier is about. Empty for the ones only written in the books. */
    tags?: string[];
    /** Only for the written-only ones: the closest catalog supplier. A suggestion; a person decides to link. */
    suggested?: { id: number; name: string } | null;
};

/** A preset tag: offered for picking even if no supplier carries it. */
export type PresetTag = { id: number; name: string };

export type SupplierList = {
    suppliers: SupplierSummary[]; no_supplier: { lines: number; amount: string | null } | null;
    preset_tags: PresetTag[];
};

export type SupplierCard = { id: number; name: string; rfc: string | null; note: string | null; tags: string[]; archived: boolean };

/** Another way to call the same supplier. `origin` says who added it and why. */
export type SupplierAlias = {
    id: number; alias: string; origin: 'manual' | 'equivalence' | 'rename' | 'merge'; created_at: string; created_by: string | null;
};

export type SupplierContact = {
    id: number; name: string | null; email: string | null; address: string | null;
    /** Mobile, office...: each gets its own dial link. Empty = no phone. */
    phones: string[];
};

export type SupplierDetail = {
    /** Only for catalog suppliers (null for one only written in the books). */
    card: SupplierCard | null;
    aliases: SupplierAlias[];
    contacts: SupplierContact[];
    /** What it has linked: with any of the three it can't be deleted, only merged or archived. */
    links: { purchases: number; invoices: number; movements: number } | null;
    lines: number; amount: string | null; first_date: string | null; last_date: string | null;
    latest: Omit<RecentPurchase, 'supplier'>[];
    top_purchased: { description: string; lines: number; amount: string }[];
};

/** Which supplier the book reader is limited to: by id if in the catalog, by exact text if not. */
export type SupplierFilter = { id: number | null; name: string };

export type PurchasesSummary = {
    from: Month | null;
    to: Month | null;
    group_by: GroupBy;
    period: { first_book: Month | null; last_book: Month | null; books: number };
    summary: {
        purchases: number;
        no_amount: number;
        notes: number;
        amount: string | null;
        suppliers: number;
        first_date: string | null;
        last_date: string | null;
        /** Lines with an identical twin. Still in the totals: only flagged. */
        possible_duplicates: number;
        dates_to_review: number;
    };
    coverage: {
        with_stock: CountAmount;
        no_stock: CountAmount;
        unlinked: CountAmount & { descriptions: number };
        /** Lines that are also a historical inventory entry. */
        in_inventory: CountAmount;
    };
    /** A month with no book doesn't appear: it's not a zero spend. Dates are the book's first and last purchase ('YYYY-MM-DD'). */
    monthly_series: { period: Month; purchases: number; amount: string | null; first_date: string | null; last_date: string | null }[];
    breakdown: {
        key: string | null;
        name: string;
        purchases: number;
        amount: string | null;
        /** true = supplier with no normalized equivalent; the name is the book's. */
        as_typed: boolean;
    }[];
};

/** Which item a description got linked to and through which alias. */
export type LinkedProduct = {
    id: number;
    code: string;
    name: string;
    control_type: ControlType;
    alias_id: number;
    /** 'manual' = linked from the screen; see the alias origins. */
    alias_origin: string;
};

export type LineType = 'purchase' | 'no_amount' | 'note';

export type PurchaseLine = {
    id: number;
    book: { id: number; file: string; period: Month };
    sheet: string;
    /** Excel cell reference, to find the line in the original. */
    cell: string;
    type: LineType;
    date: string | null;
    date_status: string;
    date_to_review: boolean;
    description: string;
    quantity: string | null;
    unit_price: string | null;
    amount: string | null;
    /** As written in the book. */
    supplier: string | null;
    normalized_supplier: string | null;
    folio: string | null;
    requester: string | null;
    note: string | null;
    possible_duplicate: boolean;
    in_inventory: boolean;
    product: LinkedProduct | null;
};

export type LineStatus = 'all' | 'unlinked' | 'linked' | 'review' | 'duplicate';

export type LinesResponse = {
    total: number;
    page: number;
    pages: number;
    lines: PurchaseLine[];
};

export type RecurringStatus = 'unlinked' | 'linked' | 'all' | 'with_suggestion';

/** Which product an unlinked description probably is. Only a proposal: nothing is linked without confirming. */
export type LinkSuggestion = {
    product: { id: number; code: string; name: string };
    /** same_form: the same description with other punctuation; similar: same measurements (if any) and similar text. */
    reason: 'same_form' | 'similar';
    /** What it was compared against: a form already linked to that product, or its catalog name. */
    via: 'link' | 'name';
    text: string;
    /** Similarity 0 to 1 (trigrams). */
    similarity: number;
    /** false = neither text has numbers: can't claim "same measurements". */
    has_numbers: boolean;
};

export type RecurringGroup = {
    description_norm: string;
    /** The most frequent written form. */
    description: string;
    variants: number;
    purchases: number;
    months: number;
    first_date: string | null;
    last_date: string | null;
    quantity: string | null;
    amount: string | null;
    last_price: string | null;
    suppliers: string[];
    recurring: boolean;
    /** Proposal derived from the history; null without enough evidence. */
    suggested: { daily_consumption: string; interval_days: string; minimum: string } | null;
    product: LinkedProduct | null;
    /** Only in unlinked groups; null if none passes the guards. */
    suggestion: LinkSuggestion | null;
};

export type RecurringResponse = {
    total: number;
    page: number;
    pages: number;
    criteria: { min_purchases: number; min_months: number };
    groups: RecurringGroup[];
};

export type LinkResponse = {
    alias_id: number;
    product: { id: number; code: string; name: string };
    purchases: number;
    amount: string | null;
    already_linked?: boolean;
};

/** Same shape as creating from a scanned code: see `newProduct.ts`. */
export type NewFromPurchase = UncountedNewProduct;

export type BringResponse = {
    product: UncountedProduct;
    alias_id: number;
    purchases: number;
    amount: string | null;
};

/** 409 when linking: the description already belongs to another item. */
export type DescriptionLinkedError = {
    error: string;
    error_code: 'description_linked';
    /** May be missing: if the winning link disappears between the clash and the lookup, the server answers 409 without it. */
    product?: { id: number; code: string; name: string };
};
