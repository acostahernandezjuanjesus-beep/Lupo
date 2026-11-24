import { Checkmark, Add, Subtract } from '@carbon/icons-react';
import { TextInput } from '@carbon/react';
import { adjust } from '../../count';
import { TYPES, type MovementType } from '../../movement';
import './movement.scss';

/** `noAdjustment`: operators can't record counts (the server refuses), so it isn't offered. */
export function TypeSelector({ value, onChange, disabled, noAdjustment = false }: { value: MovementType | null; onChange: (t: MovementType) => void; disabled: boolean; noAdjustment?: boolean }) {
    return <fieldset className="mov-types" disabled={disabled}>
        <legend className="sr-only">What happened to the product</legend>
        {TYPES.filter(t => !(noAdjustment && t.type === 'adjustment')).map(t => <label key={t.type} className="mov-type">
            <input type="radio" name="movement-type" value={t.type} checked={value === t.type} onChange={() => onChange(t.type)} />
            <span className="mov-type__title">{t.title}</span>
            {value === t.type && <Checkmark className="mov-type__mark" size={20} aria-hidden="true" />}
        </label>)}
    </fieldset>;
}

export function QuantityField({ label, unit, value, onChange, problem, help, disabled }: {
    label: string;
    unit: string;
    value: string;
    onChange: (v: string) => void;
    problem: string | null;
    help?: string;
    disabled: boolean;
}) {
    return <div className={`mov-quantity${problem ? ' mov-quantity--with-error' : ''}`}>
        <button type="button" className="mov-quantity__step" aria-label="One less" disabled={disabled} onClick={() => onChange(adjust(value, -1, unit))}><Subtract size={20} /></button>
        <div className="mov-quantity__field">
            <TextInput id="movement-quantity" labelText={`${label} (${unit})`} inputMode="decimal" autoComplete="off" placeholder="0"
                value={value} disabled={disabled} onChange={e => onChange(e.target.value)}
                invalid={problem !== null} invalidText={problem ?? undefined} helperText={help} />
        </div>
        <button type="button" className="mov-quantity__step" aria-label="One more" disabled={disabled} onClick={() => onChange(adjust(value, 1, unit))}><Add size={20} /></button>
    </div>;
}
