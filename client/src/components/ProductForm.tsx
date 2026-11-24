import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, TextInput, Select, SelectItem, InlineNotification } from '@carbon/react';
import type { Category } from '../types';
import { requestJson, ApiError } from '../api';
import { UNITS, WHOLE_UNITS } from '../newProduct';
import { codeOnCategoryChange } from '../codePrefix';
import { CodeField } from './CodeField';
import { CategoryField } from './CategoryField';

// The server's rules are repeated here only to warn before submitting; the backend is the guarantee.

type Props = {
    /** `null` while loading or if it failed: the field says so and doesn't offer to create. */
    categories: Category[] | null;
    categoriesError?: string | null;
    onRetryCategories?: () => void;
};

/** What POST /api/products returns. */
type CreatedProduct = {
    id: number;
    code: string;
    name: string;
};

export function ProductForm({ categories, categoriesError, onRetryCategories }: Props) {
    const queryClient = useQueryClient();
    const [code, setCode] = useState('');
    const [name, setName] = useState('');
    const [quantity, setQuantity] = useState('');
    const [price, setPrice] = useState('');
    const [unit, setUnit] = useState('piece');
    const [location, setLocation] = useState('');
    const [categoryId, setCategoryId] = useState('');
    // A category name is typed but not created: saving now would leave the product in the previous one.
    const [categoryPending, setCategoryPending] = useState(false);
    const [saving, setSaving] = useState(false);

    // Success and error are separate notices so "Product saved" and "That code already exists" don't look alike.
    const [success, setSuccess] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const num = quantity.trim() === '' ? 0 : Number(quantity);
    const invalidFraction =
        WHOLE_UNITS.includes(unit) && Number.isFinite(num) && !Number.isInteger(num);

    const ready = code.trim() !== '' && name.trim() !== '' && categoryId !== '' && !invalidFraction && !categoryPending;

    async function save(e: FormEvent) {
        e.preventDefault();
        if (!ready || saving) return;

        setSaving(true);
        setError(null);
        setSuccess(null);
        try {
            const data = await requestJson<CreatedProduct>('/api/products', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code,
                    name,
                    quantity: quantity === '' ? null : Number(quantity),
                    price: price === '' ? null : Number(price),
                    unit,
                    location,
                    category_id: Number(categoryId),
                }),
            });

            setCode(''); setName(''); setQuantity('');
            setPrice(''); setLocation(''); setUnit('piece');
            setCategoryId('');
            setSuccess(`${data.code} created.`);
            // Invalidate instead of calling a prop, so any open screen with products or the summary hears about it.
            queryClient.invalidateQueries({ queryKey: ['products'] });
            queryClient.invalidateQueries({ queryKey: ['summary'] });
        } catch (err) {
            // The server's message ("That code already exists") beats a generic connection error,
            // which would also be a lie when there was a response.
            setError(err instanceof ApiError ? err.message : 'Could not connect to the API');
        } finally {
            setSaving(false);
        }
    }

    return (
        <form onSubmit={save} className="stack">
            {/* Show the uppercase before saving so it doesn't surprise whoever is typing. */}
            <CodeField id="create-code" labelText="Code" required value={code} onChange={e => setCode(e.target.value.toUpperCase())}
                category={categories?.find(c => String(c.id) === categoryId)} />
            <TextInput id="create-name" labelText="Name" required value={name} onChange={e => setName(e.target.value)} />
            <div className="form-grid">
                <TextInput id="create-quantity" labelText="Counted quantity" type="number" min={0} step="any" inputMode="decimal"
                    value={quantity} onChange={e => setQuantity(e.target.value)} invalid={invalidFraction}
                    invalidText={'No fractions of "' + unit + '"'} />
                <Select id="create-unit" labelText="Unit" value={unit} onChange={e => setUnit(e.target.value)}>
                    {UNITS.map(u => <SelectItem key={u} value={u} text={u} />)}
                </Select>
                <TextInput id="create-price" labelText="Price" type="number" min={0} step="0.01" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} />
                <TextInput id="create-location" labelText="Location" value={location} onChange={e => setLocation(e.target.value)} />
            </div>
            {/* The code is recomputed from the value AT THIS MOMENT (function form), so what was typed while the category was being created isn't wiped. */}
            <CategoryField id="create-category" categories={categories} value={categoryId}
                onPending={setCategoryPending} error={categoriesError} onRetry={onRetryCategories}
                onChange={next => { setCode(c => codeOnCategoryChange(c, categories ?? [], categoryId, next)); setCategoryId(next); }} />
            <Button type="submit" disabled={!ready || saving}>{saving ? 'Saving…' : 'Create'}</Button>
            {success && <InlineNotification kind="success" title="Product saved" subtitle={success} onCloseButtonClick={() => setSuccess(null)} />}
            {error && <InlineNotification kind="error" title="Could not save" subtitle={error} onCloseButtonClick={() => setError(null)} />}
        </form>
    );
}
