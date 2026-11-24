// Shared by the screens that create an item: direct create (ProductForm), "bring to catalog" from
// Purchases (BringModal) and create from a scanned code (NewCodeModal). The server rules are the
// real guarantee; this only warns next to the field before sending.

export const UNITS = ['piece', 'pair', 'box', 'pack', 'meter', 'kg', 'liter'];

/** Units that don't allow fractions (half a pair of gloves doesn't exist). Copy of the server's whole-unit list. */
export const WHOLE_UNITS = ['piece', 'pair', 'box', 'pack'];

/** Server limits for product code, name and location: better to stop typing than reject at the end. */
export const MAX_LENGTH = { code: 50, name: 200, location: 100 };

/** Copy of the server's barcode length limit, so Scan doesn't offer "Add this code" for something it will reject. */
export const MAX_BARCODE_LENGTH = 200;

// Same limits as the server (numeric(10,2) and numeric(12,3)).
export const VALID_PRICE = /^\d{1,8}(\.\d{1,2})?$/;
export const VALID_QUANTITY = /^\d{1,9}(\.\d{1,3})?$/;

/** An optional, non-negative number. Empty is valid: it means "unknown". */
export const invalidNumber = (text: string) => {
    if (text.trim() === '') return false;
    const n = Number(text);
    return !Number.isFinite(n) || n < 0;
};

export const badFormat = (text: string, pattern: RegExp) => text.trim() !== '' && !pattern.test(text.trim());

/**
 * Why a movement quantity can't be sent, or null if it can. Empty is null too: the button is
 * already disabled and a red warning before typing is noise.
 */
export function quantityProblem(text: string, unit: string, allowZero: boolean): string | null {
    const clean = text.trim();
    if (clean === '') return null;
    const n = Number(clean);
    if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
        return allowZero ? 'Cannot be negative' : 'Must be greater than zero';
    }
    if (!VALID_QUANTITY.test(clean)) return 'Up to 9 digits and 3 decimals';
    if (WHOLE_UNITS.includes(unit) && !Number.isInteger(n)) return `No fractions of "${unit}"`;
    return null;
}

/** What gets sent when creating a product with NO COUNT (Purchases and Scan): no quantity, the server sets 0 with count pending. */
export type UncountedNewProduct = {
    code: string;
    name: string;
    unit: string;
    category_id: number | null;
    control_type: 'stock' | 'no_balance';
    minimum: string | null;
    price: string | null;
    location: string | null;
};

/** The row the server returns after creating an uncounted product. */
export type UncountedProduct = {
    id: number;
    code: string;
    name: string;
    unit: string;
    category_id: number | null;
    control_type: 'stock' | 'no_balance';
    minimum: string | null;
    count_pending: boolean;
};
