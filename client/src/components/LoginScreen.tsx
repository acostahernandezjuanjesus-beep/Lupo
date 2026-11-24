import { useEffect, useRef, useState } from 'react';
import { Theme, Button, PasswordInput, TextInput, InlineNotification } from '@carbon/react';
import { ArrowRight } from '@carbon/icons-react';
import type { User } from '../types';
import { requestJson, ApiError } from '../api';
import { saveSession, rememberLastUser, lastUser } from '../session';
import { LoginBackdrop } from './LoginBackdrop';

// You type your username and password. This device remembers the LAST username only (never the password) and
// then asks just for the password; "Not me" forgets it. There's no public list of people to pick from, so
// nobody can see who exists or lock an admin out by guessing passwords for a listed name.
//
// This screen uses the g100 theme while the rest of the app stays g10: the dark one gets in the way when
// reading quantities under bright light, and there are none to read here. The contrast also says "you're not inside yet".

type Props = {
    onSignIn: (user: User) => void;
};

export function LoginScreen({ onSignIn }: Props) {
    const [remembered, setRemembered] = useState<string | null>(() => lastUser());
    const [typedUsername, setTypedUsername] = useState('');
    const [password, setPassword] = useState('');
    const [notice, setNotice] = useState<string | null>(null);
    const [verifying, setVerifying] = useState(false);

    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

    const username = (remembered ?? typedUsername).trim().toLowerCase();

    async function signIn(e: React.FormEvent) {
        e.preventDefault();
        if (!username || !password || verifying) return;

        setVerifying(true);
        setNotice(null);
        try {
            const r = await requestJson<{ token: string; user: User }>('/api/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            });
            saveSession(r.token);
            rememberLastUser(username);
            onSignIn(r.user);   // from here on this component no longer exists
        } catch (err) {
            if (!mounted.current) return;
            // The password is always cleared on failure: fixing one letter blind burns attempts; retyping it whole doesn't.
            setPassword('');
            setVerifying(false);
            setNotice(err instanceof ApiError ? err.message : 'Could not connect to the system');
        }
    }

    function otherPerson() {
        rememberLastUser(null);
        setRemembered(null);
        setTypedUsername('');
        setPassword('');
        setNotice(null);
    }

    return (
        <Theme theme="g100">
            <main className="login">
                <section className="login__col">
                    <h1 className="login__title">Sign in</h1>

                    {remembered && <>
                        <p className="login__step">{remembered}</p>
                        <hr className="login__rule" />
                    </>}

                    {/* One <form>, so Enter in the field submits regardless of where focus is. PasswordInput's eye is type="button". */}
                    <form onSubmit={signIn} className="stack">
                        {!remembered && <TextInput id="login-username" labelText="Username"
                            autoFocus autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                            value={typedUsername} maxLength={50}
                            onChange={e => { setTypedUsername(e.target.value); setNotice(null); }}
                            disabled={verifying} />}
                        <PasswordInput id="login-password" labelText="Password"
                            autoFocus={!!remembered} autoComplete="current-password"
                            showPasswordLabel="Show password"
                            hidePasswordLabel="Hide password"
                            value={password}
                            onChange={e => { setPassword(e.target.value); setNotice(null); }}
                            disabled={verifying} />

                        <Button type="submit" className="login__action"
                            renderIcon={ArrowRight}
                            disabled={!username || !password || verifying}>
                            {verifying ? 'Verifying…' : 'Sign in'}
                        </Button>
                    </form>

                    {remembered && <Button kind="ghost" size="sm"
                        onClick={otherPerson} disabled={verifying}>Not me</Button>}

                    {notice && <InlineNotification kind="error" hideCloseButton
                        title="Could not sign in" subtitle={notice} />}
                </section>

                <aside className="login__brand" aria-hidden="true">
                    <LoginBackdrop />
                </aside>
            </main>
        </Theme>
    );
}
