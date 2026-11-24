import { createContext, useContext } from 'react';

// Light or dark. Carbon has both themes and index.scss declares them by `data-carbon-theme` on <html>;
// this only picks one. Default is the system's; the header button overrides it and it's remembered per browser.
export type Mode = 'light' | 'dark';

const KEY = 'lupo.theme';

export function savedMode(): Mode | null {
    try {
        const v = localStorage.getItem(KEY);
        return v === 'light' || v === 'dark' ? v : null;
    } catch {
        return null;
    }
}

export function saveMode(mode: Mode) {
    try { localStorage.setItem(KEY, mode); } catch { /* no storage: lasts as long as the tab */ }
}

export function systemMode(): Mode {
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const carbonTheme = (mode: Mode) => mode === 'dark' ? 'g100' : 'g10';

export const initialMode = (): Mode => savedMode() ?? systemMode();

// Called in main.tsx before the first render (no white flash in dark) and on button click, never during a render.
export function applyMode(mode: Mode) {
    document.documentElement.dataset.carbonTheme = carbonTheme(mode);
}

export const ThemeContext = createContext<{ mode: Mode; toggle: () => void }>({
    mode: 'light',
    toggle: () => {},
});

export const useTheme = () => useContext(ThemeContext);
