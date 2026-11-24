// The token lives in localStorage so a reload or a closed tab doesn't force a new sign-in.
// It isn't secret: the session lasts a shift and the server can revoke it.

const TOKEN_KEY = 'lupo.token'
// Last user who signed in on this device (never the password), so the login screen only asks for the password.
const LAST_USER_KEY = 'lupo.lastUser'

// localStorage can throw (private window, blocked cookies, full storage). The app must survive that.
function read(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function write(key: string, value: string | null) {
    try {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
    } catch {
        /* without storage the session lasts as long as the tab */
    }
}

export function currentToken(): string | null {
    return read(TOKEN_KEY)
}

export function saveSession(token: string) {
    write(TOKEN_KEY, token)
}

export const lastUser = (): string | null => read(LAST_USER_KEY)
export const rememberLastUser = (username: string | null) => write(LAST_USER_KEY, username)

export function clearSession() {
    write(TOKEN_KEY, null)
}

/** Fires when ANOTHER tab signs in or out (`storage` never reaches the tab that wrote). Returns the unsubscribe. */
export function onSessionChangeInOtherTab(fn: () => void): () => void {
    const listener = (e: StorageEvent) => { if (e.key === null || e.key === TOKEN_KEY) fn() }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
}
