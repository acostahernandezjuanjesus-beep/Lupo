import { useState, type ReactNode } from 'react';
import { InlineNotification } from '@carbon/react';

const keyOf = (title: string, text: string) => `notice:${title}:${text}`;
const dismissed = (k: string) => { try { return sessionStorage.getItem(k) === '1'; } catch { return false; } };

/** A notice that can be dismissed for the browser session; if the text changes, it comes back. */
export function DismissibleNotice({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
    const k = keyOf(title, text);
    const [hidden, setHidden] = useState(() => dismissed(k));
    if (hidden) return null;
    const dismiss = () => {
        try { sessionStorage.setItem(k, '1'); } catch { /* no storage: it only closes this time */ }
        setHidden(true);
    };
    return <div className="flex flex-col items-start gap-2">
        <InlineNotification kind="warning" title={title} subtitle={text} onCloseButtonClick={dismiss} />
        {children}
    </div>;
}
