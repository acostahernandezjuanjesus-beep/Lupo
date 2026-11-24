import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Tile, TextInput, Select, SelectItem, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, InlineNotification } from '@carbon/react';
import type { AdminUser, AuditEntry, Role, User } from '../types';
import { requestJson, ApiError } from '../api';
import { fetchJson, errorMessage } from '../queries';

// Admin only. Exists so adding the intern who started on Monday doesn't need a terminal against the production database.

type Props = {
    me: User;
    onBack: () => void;
};

const ROLES: Role[] = ['operator', 'storekeeper', 'admin', 'technician'];

const ROLE_LABEL: Record<Role, string> = { operator: 'Operator', storekeeper: 'Storekeeper', admin: 'Admin', technician: 'Technician' };

/** "Test Storekeeper" → "test-storekeeper": the same the server does when no username is given. */
const suggestedUsername = (name: string) =>
    name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-US');

/** What an admin knows about someone's password: never what it is, only where it stands. */
function passwordStatus(u: AdminUser): string {
    if (!u.has_password) return 'Not set';
    if (u.must_change_password) {
        if (u.temp_expired) return 'Temporary EXPIRED: assign another';
        return u.temp_password_until
            ? 'Temporary: not changed yet (expires ' + new Date(u.temp_password_until).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) + ')'
            : 'Temporary: not changed yet';
    }
    if (u.password_changed_at) return 'Changed on ' + shortDate(u.password_changed_at);
    return 'No change on record';
}

export function UsersScreen({ me, onBack }: Props) {
    const queryClient = useQueryClient();
    const [showAudit, setShowAudit] = useState(false);
    // Errors from ACTIONS (create, change role, reassign password…), not from loading. If the list fails to
    // load, that error comes from `usersQuery.error` and is combined below.
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // The freshly generated password. Shown once and has to be closed by hand: if it vanished on its own it
    // would be lost before anyone could write it down, and the only way out would be generating another.
    const [newPassword, setNewPassword] = useState<{ name: string; username: string; password: string } | null>(null);

    const [name, setName] = useState('');
    // The username they sign in with. Suggested from the name while nobody touches it; once the admin types
    // one, it stops following the name.
    const [newUsername, setNewUsername] = useState('');
    const [usernameTouched, setUsernameTouched] = useState(false);
    const [newRole, setNewRole] = useState<Role>('operator');

    const usersQuery = useQuery({ queryKey: ['admin', 'users'], queryFn: fetchJson<AdminUser[]>('/api/admin/users') });
    // If the audit log fails there's no second notice: the error strip above already covers it. Only fetched while the panel is open.
    const auditQuery = useQuery({
        queryKey: ['admin', 'audit-log'],
        queryFn: fetchJson<AuditEntry[]>('/api/admin/audit-log'),
        enabled: showAudit,
    });

    const users = usersQuery.data ?? [];
    const audit = auditQuery.data ?? [];
    // The latest action wins; if there was none, fall back to the error from loading the list.
    const errorText = error ?? (usersQuery.error ? errorMessage(usersQuery.error) : null);

    /** Common wrapper: locks, runs, refreshes what's related, and leaves the error in view. */
    async function action<T>(fn: () => Promise<T>): Promise<T | undefined> {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const r = await fn();
            // People and their audit log live under `admin`; the sign-in listing (`users`) also changes on add, deactivate or role change.
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['admin'] }),
                queryClient.invalidateQueries({ queryKey: ['users'] }),
            ]);
            return r;
        } catch (e) {
            setError(e instanceof ApiError ? e.message : 'Could not complete the operation');
        } finally {
            setBusy(false);
        }
    }

    async function create(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim()) return;
        const r = await action(() => requestJson<{ user: AdminUser; password: string }>(
            '/api/admin/users',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), role: newRole, ...(newUsername.trim() ? { username: newUsername.trim() } : {}) }),
            }));
        if (r) {
            setNewPassword({ name: r.user.name, username: r.user.username, password: r.password });
            setName('');
            setNewUsername(''); setUsernameTouched(false);
            setNewRole('operator');
        }
    }

    async function reassignPassword(u: AdminUser) {
        const r = await action(() => requestJson<{ password: string }>(
            `/api/admin/users/${u.id}/password`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }));
        if (r) setNewPassword({ name: u.name, username: u.username, password: r.password });
    }

    function change(u: AdminUser, changes: { role?: Role; active?: boolean }) {
        return action(() => requestJson(`/api/admin/users/${u.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(changes),
        }));
    }

    return <section className="page stack">
        <div className="page-heading"><div><h1>People</h1></div><Button kind="ghost" onClick={onBack}>Inventory</Button></div>
        {/* The new password only exists here once: explicit close, never a notice that disappears before it can be handed over. */}
        {newPassword && <Tile className="panel stack" role="status">
            <h2>Access for {newPassword.name}</h2>
            <p>Username: <strong className="mono">{newPassword.username}</strong></p>
            <p>Temporary password:</p><p className="mono secret">{newPassword.password}</p>
            <p className="muted">Shown once · valid for 72 h.</p>
            <Button onClick={() => setNewPassword(null)}>Done</Button>
        </Tile>}
        {errorText && <InlineNotification kind="error" title="Could not complete the operation" subtitle={errorText} hideCloseButton />}
        <Tile className="panel"><h2>Add person</h2><form className="stack" onSubmit={create}>
            <div className="form-grid"><TextInput id="person-name" labelText="Name" value={name} required disabled={busy}
                    onChange={e => { setName(e.target.value); if (!usernameTouched) setNewUsername(suggestedUsername(e.target.value)); }} />
                <TextInput id="person-username" labelText="Username" value={newUsername} disabled={busy} autoComplete="off" autoCapitalize="none" spellCheck={false}
                    onChange={e => { setNewUsername(e.target.value.toLowerCase()); setUsernameTouched(true); }} />
                <Select id="person-role" labelText="Role" value={newRole} onChange={e => setNewRole(e.target.value as Role)} disabled={busy}>
                    {ROLES.map(r => <SelectItem key={r} value={r} text={ROLE_LABEL[r]} />)}
                </Select></div><Button type="submit" disabled={busy || !name.trim()}>Add person</Button>
        </form></Tile>
        <Tile className="panel stack"><h2>Registered people</h2><div className="table-scroll"><Table className="card-table" aria-label="Registered people">
            <TableHead><TableRow>{['Name', 'Username', 'Role', 'Status', 'Password', 'Movements', 'Actions'].map(h => <TableHeader key={h}>{h}</TableHeader>)}</TableRow></TableHead>
            <TableBody>{users.map(u => <TableRow key={u.id}>
                <TableCell>{u.name}{u.id === me.id && ' (you)'}</TableCell>
                <TableCell className="mono" data-label="Username">{u.username}</TableCell>
                <TableCell data-label="Role"><Select id={'role-' + u.id} labelText={'Role of ' + u.name} hideLabel value={u.role} disabled={busy} onChange={e => change(u, { role: e.target.value as Role })}>
                    {ROLES.map(r => <SelectItem key={r} value={r} text={ROLE_LABEL[r]} />)}
                </Select></TableCell>
                <TableCell data-label="Status">{!u.active ? 'Deactivated' : !u.has_password ? 'No password' : u.locked ? 'Locked' : u.sessions > 0 ? u.sessions + ' session(s)' : 'No session'}</TableCell>
                <TableCell data-label="Password">{passwordStatus(u)}</TableCell>
                <TableCell data-label="Movements">{u.movements}</TableCell>
                <TableCell><div className="row">
                    <Button kind="tertiary" size="sm" disabled={busy} onClick={() => reassignPassword(u)}>New password</Button>
                    {u.locked && <Button kind="tertiary" size="sm" disabled={busy} onClick={() => action(() => requestJson('/api/admin/users/' + u.id + '/unlock', { method: 'POST' }))}>Unlock</Button>}
                    <Button kind="ghost" size="sm" disabled={busy} onClick={() => change(u, { active: !u.active })}>{u.active ? 'Deactivate' : 'Reactivate'}</Button>
                </div></TableCell>
            </TableRow>)}</TableBody>
        </Table></div></Tile>
        <Tile className="panel stack"><div className="row spread"><h2>Audit log</h2><Button kind="ghost" onClick={() => setShowAudit(v => !v)}>{showAudit ? 'Hide log' : 'Show log'}</Button></div>
            {showAudit && <div className="table-scroll"><Table className="card-table" aria-label="Audit log"><TableHead><TableRow>{['When', 'What', 'Whose', 'Who', 'Detail'].map(h => <TableHeader key={h}>{h}</TableHeader>)}</TableRow></TableHead>
                    <TableBody>{audit.map(b => <TableRow key={b.id}><TableCell>{new Date(b.date).toLocaleString('en-US')}</TableCell><TableCell data-label="What">{b.action}</TableCell><TableCell data-label="Whose">{b.user_name}</TableCell><TableCell data-label="Who">{b.actor ?? 'Terminal'}</TableCell><TableCell data-label="Detail">{b.detail ?? '—'}</TableCell></TableRow>)}</TableBody>
                </Table></div>}
        </Tile>
    </section>;
}
