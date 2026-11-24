import type { Category } from './types'

// The server computes each category's prefix from existing codes. Here we only decide when to apply it:
// never overwrite what the user typed; swap only if the code is empty or just the previous category's prefix.
export const prefixOf = (c: Pick<Category, 'prefix'> | undefined): string => c?.prefix ? `${c.prefix}-` : ''

export function codeOnCategoryChange(
    code: string, categories: readonly Category[], idBefore: string, idNow: string,
): string {
    const find = (id: string) => categories.find(c => String(c.id) === id)
    const before = prefixOf(find(idBefore))
    const untouched = code === '' || (before !== '' && code === before)
    return untouched ? prefixOf(find(idNow)) : code
}
