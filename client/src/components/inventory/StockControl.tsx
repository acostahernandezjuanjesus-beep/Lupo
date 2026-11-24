import { useEffect, useRef } from 'react';
import { Button, Tag } from '@carbon/react';
import { ChevronDown, ChevronUp } from '@carbon/icons-react';
import type { Product } from '../../types';
import { formatQuantity, balanceKnown } from '../../level';
import { quantityProblem } from '../../newProduct';
import { adjust, difference } from '../../count';
import type { Count } from './useCount';
import './count.scss';

// Quick count in the inventory table. Save records an ADJUSTMENT (a physical count); ins and outs live in Movement and Scan.

const stopRowClick = (e: { stopPropagation: () => void }) => e.stopPropagation();   // the whole row opens the detail

/** `canCount` false (operators): the stock is read-only here, and the server rejects the count anyway. */
export function StockCell({ product, count, canCount = true }: { product: Product; count: Count; canCount?: boolean }) {
    const input = useRef<HTMLInputElement>(null);
    const editing = count.draft?.id === product.id;
    const value = editing ? count.draft!.value : balanceKnown(product) ? formatQuantity(product.quantity) : '';
    const step = (direction: 1 | -1) => count.change(product, adjust(value, direction, product.unit));

    // React's onWheel is passive and can't stop the page from scrolling, so it's a plain listener.
    // It only acts while the field is focused, otherwise scrolling the table would change quantities.
    const { change } = count;
    useEffect(() => {
        const el = input.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            if (document.activeElement !== el) return;
            e.preventDefault();
            change(product, adjust(value, e.deltaY < 0 ? 1 : -1, product.unit));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [product, value, change]);

    if (product.control_type === 'no_balance') return '—';
    if (!canCount) return balanceKnown(product) ? formatQuantity(product.quantity) : '—';

    return <div className="count" onClick={stopRowClick}>
        <button type="button" className="count__step" aria-label={`Decrease stock of ${product.code}`} onClick={() => step(-1)}><ChevronDown size={16} /></button>
        <input ref={input} className="count__value mono" inputMode="decimal" autoComplete="off" placeholder="—"
            aria-label={`Stock of ${product.code}`} value={value}
            onFocus={e => e.target.select()} onChange={e => count.change(product, e.target.value)}
            onKeyDown={e => {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); step(e.key === 'ArrowUp' ? 1 : -1); }
                else if (e.key === 'Enter') { e.preventDefault(); void count.save(product); }
                else if (e.key === 'Escape' && editing) { e.stopPropagation(); count.cancel(); }
            }} />
        <button type="button" className="count__step" aria-label={`Increase stock of ${product.code}`} onClick={() => step(1)}><ChevronUp size={16} /></button>
    </div>;
}

/** What's about to be recorded, or the confirmation of the last save. */
export function CountPanel({ product, count }: { product: Product; count: Count }) {
    const d = count.draft;
    if (d?.id !== product.id) {
        return count.saved?.id === product.id ? <span className="count-ok" role="status" onClick={stopRowClick}>{count.saved.text}</span> : null;
    }
    const problem = d.value.trim() !== '' && !Number.isFinite(Number(d.value)) ? 'Enter a number' : quantityProblem(d.value, product.unit, true);
    const balance = balanceKnown(product) ? product.quantity : null;
    const valid = d.value.trim() !== '' && problem === null;
    const diff = valid ? difference(balance, d.value) : null;
    const unchanged = valid && balance !== null && diff === null;

    return <div className="count-panel" role="group" aria-label={`Count of ${product.code}`} onClick={stopRowClick}>
        <div>
            Physical count: <span className="mono">{balance === null ? 'not counted' : formatQuantity(balance)}</span> → <strong className="mono">{d.value.trim() || '—'}</strong> {product.unit}
            {diff && <> <Tag type={diff.startsWith('+') ? 'blue' : 'gray'} size="sm">{diff}</Tag></>}
        </div>
        {(problem || count.error) && <p className="count-error" role="alert">{problem ?? count.error}</p>}
        <div className="count-actions">
            <Button size="sm" kind="primary" disabled={!valid || unchanged || count.sending} onClick={() => { void count.save(product); }}>Save</Button>
            <Button size="sm" kind="ghost" disabled={count.sending} onClick={count.cancel}>Cancel</Button>
        </div>
    </div>;
}
