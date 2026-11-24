/** Latest purchase of a product in the purchase books. Only storekeeper and admin get it, like the price. */
export type LastPurchase = {
    /** numeric as text, with the book's decimals (up to thousandths). */
    price: string;
    /** YYYY-MM-DD, or null if the book line has no day. */
    date: string | null;
    /** Book month, YYYY-MM. */
    period: string;
    supplier: string | null;
};

export type ProductApi = {
    id: number;
    code: string;
    name: string;
    quantity: string;
    price?: string | null;
    /** Key missing = you can't see it; null = no purchase linked. */
    last_purchase?: LastPurchase | null;
    unit: string;
    location: string | null;
    minimum: string | null;
    category_id: number | null;
    count_pending: boolean;
    restock_control: 'calculated' | 'manual';
    control_type: 'unit' | 'stock' | 'no_balance';
    /** NULL = generic. */
    brand: string | null;
    /** Key shared by the variants of the same item. */
    group_name: string | null;
    category: string | null;
    /** The supplier's own code (Z-20120...) and what they call it, linked to the product. */
    supplier_codes?: SupplierCode[];
};

export type SupplierCode = { code: string; description: string | null };


export type Product = {
    id: number;
    code: string;
    name: string;
    quantity: number;
    price?: number | null;
    last_purchase?: LastPurchase | null;
    unit: string;
    location: string | null;
    minimum: number | null;
    /** How far up a restock order goes; null = nobody set it. Arrives as numeric text. */
    target_level?: number | string | null;
    category_id: number | null;
    count_pending: boolean;
    restock_control: 'calculated' | 'manual';
    control_type: 'unit' | 'stock' | 'no_balance';
    brand: string | null;
    group_name: string | null;
    category: string | null;
    supplier_codes?: SupplierCode[];
};

export type Category = {
    id: number;
    name: string;
    /** How the category's codes start (ABR, BRC...), taken from the catalog. null = no products yet. */
    prefix?: string | null;
    examples?: string[];
};

/** GET /api/users: just enough to pick a person. */
export type UserListing = {
    id: number;
    name: string;
};

export type Role = 'operator' | 'storekeeper' | 'admin' | 'technician';

/** Who I am, once signed in. */
export type User = {
    id: number;
    name: string;
    role: Role;
    /** true = signed in with a temporary password from an admin: can only change it. */
    must_change_password?: boolean;
};

/** What the admin sees: includes the state they have to manage. */
export type AdminUser = {
    id: number;
    name: string;
    /** What they sign in with (lowercase, no spaces). */
    username: string;
    /** true = still the temporary password an admin assigned. */
    must_change_password: boolean;
    /** When they changed their own; null = not yet. */
    password_changed_at: string | null;
    /** Until when the temporary one works; null = not temporary. */
    temp_password_until: string | null;
    /** true = the temporary one expired: assign another. */
    temp_expired: boolean | null;
    role: Role;
    active: boolean;
    has_password: boolean;
    locked: boolean | null;
    locked_until: string | null;
    created_at: string;
    movements: number;
    sessions: number;
};

export type AuditEntry = {
    id: number;
    action: 'create' | 'pin' | 'password' | 'own_password' | 'role' | 'deactivate' | 'reactivate' | 'unlock' | 'attempts' | 'backup';
    detail: string | null;
    date: string;
    user_id: number;
    user_name: string;
    /** null = the change was made from the terminal, without a session. */
    actor_id: number | null;
    actor: string | null;
};

export type ProductsResponse = {
    products: ProductApi[];
    total: number;
    page: number;
    pages: number;
};
