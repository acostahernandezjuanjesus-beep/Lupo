import type { ComponentProps } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TextInput } from '@carbon/react'
import { fetchJson } from '../queries'
import { prefixOf } from '../codePrefix'
import type { Category, Product } from '../types'

// The "Code" field of the create forms, with its category's help: the browser suggests existing codes
// with that prefix (already taken, so only as a model), and the examples are shown inline because
// phones have no hover. Codes describe the part (ABR-DISCO-CORTE-7-F42), they aren't a sequence.
export function CodeField({ category, helperText, ...field }: Omit<ComponentProps<typeof TextInput>, 'list'> & { category?: Category }) {
    const prefix = prefixOf(category)
    const existing = useQuery({
        queryKey: ['products', 'codes', prefix],
        queryFn: fetchJson<{ products: Product[] }>(`/api/products?q=${encodeURIComponent(prefix)}&sort=code`),
        enabled: prefix !== '',
        staleTime: 60_000,
    })
    const list = `${field.id}-existing`
    const examples = category?.examples ?? []
    return <>
        <TextInput {...field} list={list}
            helperText={helperText || examples.length > 0
                ? <>{helperText}{examples.length > 0 && <span className="mono block">{category?.name}: {examples.join(' · ')}</span>}</>
                : undefined} />
        <datalist id={list}>
            {(existing.data?.products ?? []).filter(p => p.code.startsWith(prefix)).map(p => <option key={p.id} value={p.code} label={p.name} />)}
        </datalist>
    </>
}
