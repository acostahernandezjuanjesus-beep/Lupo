import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
import type { User } from './types';
import { InventoryScreen } from './components/inventory/InventoryScreen';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { Button, InlineLoading, Header, HeaderName, HeaderMenuButton, SideNav, SideNavItems, SideNavLink, Content, SkipToContent } from '@carbon/react';
import { AddAlt, Asleep, Barcode, Catalog, Delivery, Home, Light, ListChecked, Logout, Password, Receipt, RecentlyViewed, ShoppingCart, SettingsView, UserMultiple, Notification as Bell } from '@carbon/icons-react';
import { useTheme } from './colorMode';
import { LoginScreen } from './components/LoginScreen';
import { ChangePasswordScreen } from './components/ChangePasswordScreen';
import { requestJson, setSessionLostHandler } from './api'
import { currentToken, clearSession, onSessionChangeInOtherTab } from './session'
import { queryClient } from './queries'
import { useRequests, useRequestAlert } from './requests'
import { RequestQueue } from './components/requests/RequestQueue'
import { BottomBar } from './components/BottomBar'

// Screens are downloaded on first visit to keep phone startup light.
const UsersScreen = lazy(() => import('./components/UsersScreen').then(m => ({ default: m.UsersScreen })));
const MovementScreen = lazy(() => import('./components/MovementScreen').then(m => ({ default: m.MovementScreen })));
const MovementLogScreen = lazy(() => import('./components/MovementLogScreen').then(m => ({ default: m.MovementLogScreen })));
const HomeScreen = lazy(() => import('./components/HomeScreen').then(m => ({ default: m.HomeScreen })));
const ScanScreen = lazy(() => import('./components/ScanScreen').then(m => ({ default: m.ScanScreen })));
const InvoicesScreen = lazy(() => import('./components/InvoicesScreen').then(m => ({ default: m.InvoicesScreen })));
const RequisitionScreen = lazy(() => import('./components/RequisitionScreen').then(m => ({ default: m.RequisitionScreen })));
const SuppliersScreen = lazy(() => import('./components/SuppliersScreen').then(m => ({ default: m.SuppliersScreen })));
const PurchasesScreen = lazy(() => import('./components/PurchasesScreen').then(m => ({ default: m.PurchasesScreen })));
const SystemScreen = lazy(() => import('./components/SystemScreen').then(m => ({ default: m.SystemScreen })));


// What another device may have changed. Invalidated (not cleared): what's on screen is refetched now,
// the rest is marked to refetch on visit.
const REFRESH_MS = 20_000;
const LIVE_KEYS = [['products'], ['movements'], ['summary'], ['requisition']] as const;
function refreshLive() {
    for (const queryKey of LIVE_KEYS) void queryClient.invalidateQueries({ queryKey });
}

// Signing out: the server closes the session if it can (offline, the person must still be able to leave),
// local storage is cleared and so is the Query cache. Without that, the next person on the same phone
// could see data loaded under the previous session, like prices an operator mustn't see.
async function signOutLocal() {
    try { await requestJson('/api/session', { method: 'DELETE' }); } catch { /* expires on its own after 12 h */ }
    clearSession();
    queryClient.clear();
}

export default function App() {
    // `undefined` = not known yet (validating the stored token). Distinct from `null` so the login
    // screen doesn't flash on reload with a good session.
    const [user, setUser] = useState<User | null | undefined>(
        currentToken() ? undefined : null
    );
    const navigate = useNavigate();
    // A token in localStorage may be dead: expired, or an admin closed the person's sessions.
    useEffect(() => {
        if (!currentToken()) return;
        let alive = true;
        requestJson<{ user: User }>('/api/session')
            .then(r => { if (alive) setUser(r.user); })
            .catch(() => {
                if (!alive) return;
                clearSession();
                setUser(null);
            });
        return () => { alive = false; };
    }, []);

    // If the server rejects the session on any other request, go back to login wherever we are.
    useEffect(() => {
        setSessionLostHandler(() => {
            // Clear the cache like a sign-out, so the next person can't see data from the lost session.
            queryClient.clear();
            setUser(null);
        });
        return () => setSessionLostHandler(null);
    }, []);

    // Revalidate on returning to the tab: reading products needs no session, so a revoked one would
    // otherwise go unnoticed until the person tries to write something, after typing everything.
    useEffect(() => {
        let lastRefresh = 0;
        function onReturn() {
            if (document.hidden || !currentToken()) return;
            const now = Date.now();
            if (now - lastRefresh < 1500) return;
            lastRefresh = now;
            requestJson<{ user: User }>('/api/session')
                .then(r => setUser(r.user))
                .catch(() => { /* requestJson already cleared the session on the 401 */ });
            refreshLive();
        }
        document.addEventListener('visibilitychange', onReturn);
        window.addEventListener('focus', onReturn);
        // The counter PC and the phone are two clients of one system: what one records must show up on the
        // other without reloading. While the tab is visible, what's on screen is refetched every REFRESH_MS.
        const timer = setInterval(() => { if (!document.hidden && currentToken()) refreshLive(); }, REFRESH_MS);
        return () => {
            document.removeEventListener('visibilitychange', onReturn);
            window.removeEventListener('focus', onReturn);
            clearInterval(timer);
        };
    }, []);

    // Another tab of this browser signed in or out (the token is shared). Otherwise this tab would keep
    // showing the previous person while its requests go out under the new session.
    useEffect(() => onSessionChangeInOtherTab(() => {
        queryClient.clear();
        if (!currentToken()) { setUser(null); return; }
        requestJson<{ user: User }>('/api/session').then(r => setUser(r.user)).catch(() => { /* already cleared on the 401 */ });
    }), []);

    if (user === undefined) return <main className="auth-page"><InlineLoading description="Checking session…" /></main>;
    if (user === null) return <LoginScreen onSignIn={setUser} />;
    // An admin-assigned password is temporary: until it's changed there is no other screen
    // (the server also refuses everything else, see `requireSession` in auth.js).
    if (user.must_change_password) {
        return <ChangePasswordScreen user={user} required onDone={setUser}
            onSignOut={() => { void signOutLocal().then(() => setUser(null)); }} />;
    }

    // The technician only sees system status (the server denies the rest too, see the technician
    // allow-list in auth.js). Own routes, so no "role !== 'operator'" rule below lets them through by default.
    if (user.role === 'technician') {
        return <Shell user={user} onSignOut={() => setUser(null)}>
            <Suspense fallback={<div className="page"><InlineLoading description="Loading screen…" /></div>}>
                <Routes>
                    <Route path="/system" element={<SystemScreen />} />
                    <Route path="/password" element={<ChangePasswordScreen user={user} required={false} onDone={() => navigate('/system')} />} />
                    <Route path="*" element={<Navigate to="/system" replace />} />
                </Routes>
            </Suspense>
        </Shell>;
    }

    return <Shell user={user} onSignOut={() => setUser(null)}>
        <Suspense fallback={<div className="page"><InlineLoading description="Loading screen…" /></div>}>
        <Routes>
            <Route path="/" element={<HomeScreen user={user} />} />
            <Route path="/requests" element={user.role === 'operator' ? <Navigate to="/" replace /> : <section className="page"><RequestQueue empty /></section>} />
            <Route path="/inventory" element={<InventoryScreen user={user} />} />
            <Route path="/movements" element={<MovementLogScreen onBack={() => navigate('/inventory')} />} />
            <Route path="/movement" element={<MovementScreen user={user} onBack={() => navigate('/inventory')} />} />
            <Route path="/scan" element={<ScanScreen user={user} onBack={() => navigate('/inventory')} />} />
            {/* Routes are closed too: hiding the link doesn't stop someone typing the URL. The server
                answers 403 anyway, but sending an operator to a screen that will fail is worse. */}
            <Route path="/purchases" element={user.role === 'operator' ? <Navigate to="/inventory" replace /> : <PurchasesScreen isAdmin={user.role === 'admin'} />} />
            <Route path="/requisition" element={user.role === 'operator' ? <Navigate to="/inventory" replace /> : <RequisitionScreen user={user} />} />
            <Route path="/invoices" element={user.role === 'operator' ? <Navigate to="/inventory" replace /> : <InvoicesScreen />} />
            <Route path="/suppliers" element={user.role === 'operator' ? <Navigate to="/inventory" replace /> : <SuppliersScreen isAdmin={user.role === 'admin'} />} />
            <Route path="/password" element={<ChangePasswordScreen user={user} required={false} onDone={() => navigate('/')} />} />
            <Route path="/system" element={user.role === 'admin' ? <SystemScreen canDownloadBackup /> : <Navigate to="/inventory" replace />} />
            <Route path="/users" element={user.role === 'admin' ? <UsersScreen me={user} onBack={() => navigate('/inventory')} /> : <Navigate to="/inventory" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
    </Shell>;
}

const ROLE_LABEL: Record<string, string> = { operator: 'Operator', storekeeper: 'Storekeeper', admin: 'Admin', technician: 'Technician' };

/** "Ana Lopez" → "AL". Two letters: decoration, not an identifier. */
const initials = (name: string) =>
    name.trim().split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('') || '?';

function Shell({ user, onSignOut, children }: { user: User; onSignOut: () => void; children: ReactNode }) {
    const [open, setOpen] = useState(false);
    const { pathname } = useLocation();
    const { mode, toggle } = useTheme();
    // The storeroom hears about a new request on any screen: the count and the alert live in the shell.
    const seesRequests = user.role === 'storekeeper' || user.role === 'admin';
    const requests = useRequests(seesRequests);
    useRequestAlert(seesRequests ? requests.data?.open : undefined);
    // Hiding a link doesn't hide the endpoint: role rules live on the server. This only avoids offering what would bounce.
    const links = user.role === 'technician' ? [{ path: '/system', title: 'System', icon: SettingsView }] : [
        { path: '/', title: 'Home', icon: Home },
        { path: '/inventory', title: 'Inventory', icon: Catalog },
        { path: '/movement', title: 'Record', icon: AddAlt },
        { path: '/scan', title: 'Scan', icon: Barcode },
        { path: '/movements', title: user.role === 'operator' ? 'My movements' : 'Movements', icon: RecentlyViewed },
        ...(seesRequests ? [{ path: '/requests', title: `Requests${requests.data?.open ? ` (${requests.data.open})` : ''}`, icon: Bell }] : []),
        ...(user.role === 'operator' ? [] : [{ path: '/purchases', title: 'Purchases', icon: ShoppingCart }, { path: '/suppliers', title: 'Suppliers', icon: Delivery }, { path: '/invoices', title: 'Invoices', icon: Receipt }, { path: '/requisition', title: 'Requisition', icon: ListChecked }]),
        ...(user.role === 'admin' ? [{ path: '/users', title: 'People', icon: UserMultiple }, { path: '/system', title: 'System', icon: SettingsView }] : []),
    ];
    async function signOut() {
        await signOutLocal();
        onSignOut();
    }
    return <>
        <Header aria-label="Lupo" className="app-header">
            <SkipToContent href="#content">Skip to content</SkipToContent>
            <HeaderMenuButton aria-label={open ? 'Close menu' : 'Open menu'} isActive={open} onClick={() => setOpen(!open)} />
            <HeaderName as={Link} to="/" prefix="">Lupo</HeaderName>
            {/* One menu for both sizes. On desktop it's fixed on the left with 48 px rows and icons, easy to hit
                with gloves; on the phone the button opens it. */}
            <SideNav aria-label="Main navigation" className="app-sidenav" expanded={open}
                onOverlayClick={() => setOpen(false)} onSideNavBlur={() => setOpen(false)}>
                <SideNavItems>{links.map(l => <SideNavLink key={l.path} as={Link} to={l.path} large renderIcon={l.icon}
                    isActive={pathname === l.path} onClick={() => setOpen(false)}>{l.title}</SideNavLink>)}</SideNavItems>
                {/* Menu footer: who is signed in, light/dark mode and Sign out. */}
                <div className="app-sidenav__footer mt-auto flex flex-col gap-2 border-t border-border p-4">
                    <div className="flex items-center gap-3">
                        <span className="grid size-10 flex-none place-items-center rounded-full bg-inverse text-sm font-semibold text-text-inverse" aria-hidden="true">
                            {initials(user.name)}
                        </span>
                        <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold" title={user.name}>{user.name}</span>
                            <span className="block text-xs text-text-2">{ROLE_LABEL[user.role] ?? user.role}</span>
                        </span>
                    </div>
                    <Button kind="ghost" size="md" className="app-sidenav__action" renderIcon={mode === 'dark' ? Light : Asleep} onClick={toggle}>
                        {mode === 'dark' ? 'Light mode' : 'Dark mode'}
                    </Button>
                    <Button kind="ghost" size="md" className="app-sidenav__action" renderIcon={Password} as={Link} to="/password" onClick={() => setOpen(false)}>Change password</Button>
                    <Button kind="ghost" size="md" className="app-sidenav__action" renderIcon={Logout} onClick={signOut}>Sign out</Button>
                </div>
            </SideNav>
        </Header>
        <Content id="content" className="app-content">{children}</Content>
        {user.role !== 'technician' && <BottomBar pathname={pathname} onMore={() => setOpen(true)} shortcuts={[
            { path: '/', title: 'Home', icon: Home },
            { path: '/inventory', title: 'Inventory', icon: Catalog },
            { path: '/movement', title: 'Record', icon: AddAlt },
            seesRequests ? { path: '/requests', title: 'Requests', icon: Bell, badge: requests.data?.open }
                : { path: '/scan', title: 'Scan', icon: Barcode },
        ]} />}
    </>;
}
