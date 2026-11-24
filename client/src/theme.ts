// Neutral Carbon palette. These are Carbon tokens, so they follow the theme (light g10 / dark g100).
const C = {
    ink: 'var(--cds-text-primary)',        // main text
    mut: 'var(--cds-text-secondary)',      // secondary text
    faint: 'var(--cds-text-helper)',       // helper text, table headers
    line: 'var(--cds-border-subtle-01)',
    softLine: 'var(--cds-layer-accent-01)',
    background: 'var(--cds-background)',
    black: '#1a1a1a',
} as const

// Brand red is identity (header, logo, details), not for buttons: a red "Register" next to a
// negative-balance warning reads as an alert. Buttons stay black.
export const brand = {
    red: '#e71f28',
    black: '#1a1a1a',
    gray: '#979696',
} as const

export const colors = C

// Stock scale. Amber is too light as text on white (~2.5:1), so restockText is a darker tone.
// "Below minimum" is black, not red, to leave red free for the brand.
export const stockLevel = {
    ample: 'var(--level-ample)',
    restock: 'var(--level-restock)',
    restockText: 'var(--level-restock-text)',   // amber as readable text
    belowMin: 'var(--level-below-min)',
    uncounted: 'var(--level-uncounted)',        // grey: unknown, not "none"
    noMin: 'var(--level-no-min)',               // hatched: no data to measure against
} as const
// Values live in index.scss (:root per theme); in dark, belowMin turns light since black on black is invisible.
