import { useState, type ReactNode } from 'react';
import { GlobalTheme } from '@carbon/react';
import { ThemeContext, applyMode, saveMode, initialMode, carbonTheme, type Mode } from '../colorMode';

/** Sets the theme on <html> and in Carbon, and lets the header toggle it. */
export function ThemeProvider({ children }: { children: ReactNode }) {
    // main.tsx already set the one on <html> before the first render.
    const [mode, setMode] = useState<Mode>(initialMode);

    function toggle() {
        const next: Mode = mode === 'dark' ? 'light' : 'dark';
        saveMode(next);
        applyMode(next);
        setMode(next);
    }

    return <ThemeContext.Provider value={{ mode, toggle }}>
        <GlobalTheme theme={carbonTheme(mode)}>{children}</GlobalTheme>
    </ThemeContext.Provider>;
}
