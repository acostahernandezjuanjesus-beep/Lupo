import { useState } from 'react';
import { Theme, Button, PasswordInput, InlineNotification } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import type { User } from '../types';
import { requestJson, ApiError } from '../api';
import { LoginBackdrop } from './LoginBackdrop';

// Two uses. REQUIRED: the person signed in with the temporary password an admin gave them and the server won't
// let them do anything else, so this screen takes the place of the whole app. OPTIONAL: from the menu.
// The current password is asked for even with a session: a stolen session or a borrowed phone shouldn't be
// enough to take over the account. Changing it closes the person's other sessions.

type Props = {
    user: User;
    required: boolean;
    onDone: (user: User) => void;
    onSignOut?: () => void;
};

const MIN_LENGTH = 12;

export function ChangePasswordScreen({ user, required, onDone, onSignOut }: Props) {
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [repeated, setRepeated] = useState('');
    const [notice, setNotice] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    const tooShort = next !== '' && next.length < MIN_LENGTH;
    const mismatch = repeated !== '' && repeated !== next;
    const ready = current !== '' && next.length >= MIN_LENGTH && repeated === next && !sending;

    async function change(e: React.FormEvent) {
        e.preventDefault();
        if (!ready) return;
        setSending(true);
        setNotice(null);
        try {
            await requestJson('/api/session/password', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ current, new_password: next }),
            });
            const updated: User = { ...user, must_change_password: false };
            onDone(updated);
        } catch (err) {
            setSending(false);
            setCurrent('');
            setNotice(err instanceof ApiError ? err.message : 'Could not connect to the system');
        }
    }

    const form = <form onSubmit={change} className="stack">
        <PasswordInput id="change-current" labelText={required ? 'Temporary password' : 'Current password'}
            autoFocus autoComplete="current-password"
            showPasswordLabel="Show password" hidePasswordLabel="Hide password"
            value={current} onChange={e => { setCurrent(e.target.value); setNotice(null); }} disabled={sending} />
        <PasswordInput id="change-new" labelText="New password" autoComplete="new-password"
            showPasswordLabel="Show password" hidePasswordLabel="Hide password"
            invalid={tooShort} invalidText={`${MIN_LENGTH - next.length} more characters needed`}
            value={next} onChange={e => { setNext(e.target.value); setNotice(null); }} disabled={sending} />
        <PasswordInput id="change-repeated" labelText="Repeat new password" autoComplete="new-password"
            showPasswordLabel="Show password" hidePasswordLabel="Hide password"
            invalid={mismatch} invalidText="Passwords don't match"
            value={repeated} onChange={e => { setRepeated(e.target.value); setNotice(null); }} disabled={sending} />
        <Button type="submit" className={required ? 'login__action' : undefined} renderIcon={ArrowRight} disabled={!ready}>
            {sending ? 'Saving…' : 'Save password'}
        </Button>
        {notice && <InlineNotification kind="error" hideCloseButton title="Could not change it" subtitle={notice} />}
    </form>;

    if (!required) {
        return <section className="page stack" style={{ maxWidth: '32rem' }}>
            <div className="page-heading"><div><p className="eyebrow">{user.name}</p><h1>Change password</h1></div></div>
            {form}
        </section>;
    }

    return (
        <Theme theme="g100">
            <main className="login">
                <section className="login__col">
                    <h1 className="login__title">Choose your password</h1>
                    <p className="login__step">{user.name}</p>
                    <hr className="login__rule" />
                    {form}
                    {onSignOut && <Button kind="ghost" size="sm" onClick={onSignOut} disabled={sending}>Sign out</Button>}
                </section>
                <aside className="login__brand" aria-hidden="true"><LoginBackdrop /></aside>
            </main>
        </Theme>
    );
}
