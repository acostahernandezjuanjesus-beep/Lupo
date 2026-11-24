import { useSyncExternalStore } from 'react';

// Same cut as the phone rules in index.scss (672px, Carbon's `md`).
const QUERY = '(max-width: 672px)';

const subscribe = (onChange: () => void) => {
    const m = matchMedia(QUERY);
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
};

// For what CSS can't decide (what gets mounted, not how it looks).
export const useIsMobile = () => useSyncExternalStore(subscribe, () => matchMedia(QUERY).matches, () => false);
