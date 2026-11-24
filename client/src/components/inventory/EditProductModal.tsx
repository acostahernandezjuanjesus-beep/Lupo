import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InlineNotification, Modal, TextInput } from '@carbon/react';
import type { Category, Product, ProductApi, User } from '../../types';
import { toProduct, requestJson } from '../../api';
import { fetchJson, errorMessage } from '../../queries';
import { MAX_LENGTH } from '../../newProduct';
import { CategoryField } from '../CategoryField';

// Fix a product's record. Stock and unit are not editable here: stock changes only through a movement
// (author and date get recorded), and changing the unit would falsify quantities that already have history.

const MAX_BRAND = 60;
const MAX_GROUP = 40;
const RE_PRICE = /^\d{1,8}(\.\d{1,2})?$/;

type Response = { product: ProductApi; unchanged?: boolean };

export function EditProductModal({ product, user, onClose, onSaved }: {
    product: Product;
    user: User;
    onClose: () => void;
    onSaved: (product: Product) => void;
}) {
    const client = useQueryClient();
    const categoriesQuery = useQuery({ queryKey: ['categories'], queryFn: fetchJson<Category[]>('/api/categories') });
    const seesCosts = product.price !== undefined;
    const isAdmin = user.role === 'admin';

    const [code, setCode] = useState(product.code);
    const [name, setName] = useState(product.name);
    const [categoryId, setCategoryId] = useState(product.category_id === null ? '' : String(product.category_id));
    const [location, setLocation] = useState(product.location ?? '');
    const [brand, setBrand] = useState(product.brand ?? '');
    const [group, setGroup] = useState(product.group_name ?? '');
    const [price, setPrice] = useState(product.price === null || product.price === undefined ? '' : product.price.toFixed(2));
    const [categoryPending, setCategoryPending] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Only what changed is sent: keeps the audit log clean and avoids overwriting someone else's edit made while this was open.
    const changes: Record<string, unknown> = {};
    if (isAdmin && code.trim().toUpperCase() !== product.code) changes.code = code.trim();
    if (name.trim() !== product.name) changes.name = name.trim();
    if (categoryId !== '' && categoryId !== String(product.category_id ?? '')) changes.category_id = Number(categoryId);
    if (location.trim() !== (product.location ?? '')) changes.location = location.trim() || null;
    if (brand.trim() !== (product.brand ?? '')) changes.brand = brand.trim() || null;
    if (group.trim() !== (product.group_name ?? '')) changes.group_name = group.trim() || null;
    const newPrice = price.trim();
    const badPrice = seesCosts && newPrice !== '' && !RE_PRICE.test(newPrice);
    if (seesCosts && !badPrice && (newPrice === '' ? product.price !== null && product.price !== undefined : Number(newPrice) !== product.price)) {
        changes.price = newPrice === '' ? null : newPrice;
    }

    const nameEmpty = name.trim() === '';
    const codeEmpty = isAdmin && code.trim() === '';
    const hasChanges = Object.keys(changes).length > 0;
    const canSave = hasChanges && !nameEmpty && !codeEmpty && !badPrice && !categoryPending && !saving;

    async function save() {
        if (!canSave) return;
        setSaving(true);
        setError(null);
        try {
            const r = await requestJson<Response>(`/api/products/${product.id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
            });
            // The list, search and dashboard show this data: fetch it again.
            void client.invalidateQueries({ queryKey: ['products'] });
            void client.invalidateQueries({ queryKey: ['summary'] });
            onSaved(toProduct(r.product));
        } catch (e) {
            setError(errorMessage(e));
        } finally {
            setSaving(false);
        }
    }

    return <Modal open size="md" hasScrollingContent preventCloseOnClickOutside
        modalLabel={product.code} modalHeading="Edit product" closeButtonLabel="Close"
        primaryButtonText="Save" secondaryButtonText="Cancel"
        primaryButtonDisabled={!canSave} loadingStatus={saving ? 'active' : 'inactive'} loadingDescription="Saving…"
        onRequestClose={() => { if (!saving) onClose(); }} onRequestSubmit={() => { void save(); }}>
        <div className="stack">
            <TextInput id="edit-name" labelText="Name" maxLength={MAX_LENGTH.name} autoComplete="off" value={name} disabled={saving}
                onChange={e => setName(e.target.value)} invalid={nameEmpty} invalidText="The name can't be empty" />

            <CategoryField id="edit-category" categories={categoriesQuery.data ?? null} value={categoryId} onChange={setCategoryId}
                disabled={saving} onPending={setCategoryPending}
                error={categoriesQuery.error && !categoriesQuery.isFetching ? errorMessage(categoriesQuery.error) : null}
                onRetry={() => { void categoriesQuery.refetch(); }} />

            <div className="form-grid">
                <TextInput id="edit-location" labelText="Location" maxLength={MAX_LENGTH.location} autoComplete="off" value={location} disabled={saving}
                    onChange={e => setLocation(e.target.value)} />
                {seesCosts && <TextInput id="edit-price" labelText="Catalog price" inputMode="decimal" autoComplete="off" placeholder="No price" value={price} disabled={saving}
                    onChange={e => setPrice(e.target.value)} invalid={badPrice} invalidText="Up to 8 digits and 2 decimals (cents)" />}
                <TextInput id="edit-brand" labelText="Brand" maxLength={MAX_BRAND} autoComplete="off" value={brand} disabled={saving}
                    onChange={e => setBrand(e.target.value)} />
                <TextInput id="edit-group" labelText="Group" maxLength={MAX_GROUP} autoComplete="off" value={group} disabled={saving}
                    onChange={e => setGroup(e.target.value)} />
            </div>

            {isAdmin && <TextInput id="edit-code" labelText="Code" className="mono" maxLength={MAX_LENGTH.code} autoComplete="off" value={code} disabled={saving}
                onChange={e => setCode(e.target.value)} invalid={codeEmpty} invalidText="The code can't be empty" />}

            {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save" subtitle={error} />}
        </div>
    </Modal>;
}
