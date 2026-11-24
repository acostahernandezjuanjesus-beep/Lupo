import { useEffect, useState } from 'react';

// Uses the device's local time zone.
const DATE = new Intl.DateTimeFormat('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

const now = () => { const d = new Date(); return `${DATE.format(d)} · ${TIME.format(d)}`; };

export function Clock() {
    const [text, setText] = useState(now);
    // Recomputed every second, but React only repaints when the minute changes.
    useEffect(() => {
        const id = setInterval(() => setText(now()), 1000);
        return () => clearInterval(id);
    }, []);
    return <p className="muted first-letter:uppercase tabular-nums" role="timer" aria-live="off">{text}</p>;
}
