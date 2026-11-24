// Suggests which catalog product an unlinked purchase description belongs to. It only suggests, never links:
// a wrong link moves one item's purchases onto another's cost, which is worse than no link.
//
// Text similarity alone isn't enough: the closest pairs are usually another size of the same item (19 mm tape vs
// 24 mm). Hence three locks:
//   1. same numbers in both descriptions (fractions converted: 4 1/2" is 4.5)
//   2. no mutually exclusive word (colors, brands, disc type, gases... see EXCLUSIVE_GROUPS)
//   3. trigram similarity of at least 0.6, like pg_trgm
// And if two different products pass on similarity alone, nothing is suggested: it's ambiguous.
//
// It lives in JS, not SQL, because the numeric signature would be unreadable as a Postgres regex and this way
// it tests without a database.

const SIMILARITY_THRESHOLD = 0.6;

// If one side has a word from a group that the other lacks, and the other has a different word from the same
// group, they're different items. Whole words, feminine folded ("roja" counts as "rojo"). The words are Spanish
// because they match Spanish purchase descriptions.
const EXCLUSIVE_GROUPS = [
    // colors
    ['rojo', 'azul', 'verde', 'negro', 'blanco', 'amarillo', 'morado', 'dorado', 'gris', 'naranja', 'cafe', 'rosa', 'claro', 'oscuro'],
    // welding consumable brands: one's tip doesn't fit another's torch
    ['tweco', 'miller', 'tregaskiss', 'lincoln', 'bernard', 'binzel'],
    // disc type
    ['corte', 'desbaste', 'laminado', 'pulido'],
    // gases
    ['argon', 'oxigeno', 'acetileno', 'nitrogeno', 'helio', 'mezcla'],
    // leather garments
    ['mandil', 'manga', 'pechera', 'polaina', 'chamarra'],
    // cutter geometry and thread direction
    ['bola', 'plano', 'toro'],
    ['izquierdo', 'derecho'],
    ['drosera', 'azolla'],
];
const IN_SOME_GROUP = new Set(EXCLUSIVE_GROUPS.flat());

/** "roja" -> "rojo" if "rojo" is in some group; anything else unchanged. */
const fold = w => (w.endsWith('a') && IN_SOME_GROUP.has(w.slice(0, -1) + 'o') ? w.slice(0, -1) + 'o' : w);

const stripAccents = text => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const words = text => stripAccents(text).split(/[^a-z0-9]+/).filter(Boolean);

/** pg_trgm style: each word with two spaces before and one after. */
function trigrams(text) {
    const t = new Set();
    for (const w of words(text)) {
        const x = `  ${w} `;
        for (let i = 0; i < x.length - 2; i++) t.add(x.slice(i, i + 3));
    }
    return t;
}

function similarity(a, b) {
    let common = 0;
    for (const x of a) if (b.has(x)) common++;
    const union = a.size + b.size - common;
    return union === 0 ? 0 : common / union;
}

/** The numbers in a description as a sorted signature: "4 1/2" and "4.5" match, "3/8" and "1/2" don't. */
function numericSignature(text) {
    const t = stripAccents(text)
        // ".045" is 0.045, not 45
        .replace(/(^|[^0-9])\.(\d)/g, '$10.$2')
        // mixed number only with a small loose integer: "7018 1/8" is a 7018 electrode of 1/8, not 7018.125
        .replace(/(^|[^a-z0-9.-])(\d{1,2})\s+(\d+)\/(\d+)/g,
            (_, before, e, n, d) => before + String(Number(e) + Number(n) / Number(d)))
        .replace(/(\d+)\/(\d+)/g, (_, n, d) => String(Number(n) / Number(d)));
    return (t.match(/\d+(?:\.\d+)?/g) ?? [])
        .map(n => Number(Number(n).toFixed(4)))
        .sort((a, b) => a - b)
        .join('|');
}

/** Letters only: two forms differing just in punctuation and spacing come out equal. */
const lettersOnly = text => stripAccents(text).replace(/[^a-z]+/g, '');

function conflict(a, b) {
    const A = new Set(words(a).map(fold));
    const B = new Set(words(b).map(fold));
    return EXCLUSIVE_GROUPS.some(group =>
        group.some(x => A.has(x) && !B.has(x)) && group.some(y => B.has(y) && !A.has(y)));
}

/**
 * Prepares the list to compare against, once per query. Input rows: { text, via, id, code, name }.
 * Output: { text, via, product: { id, code, name }, tri, num, letters }.
 */
function prepareCandidates(rows) {
    return rows.map(r => ({
        text: r.text,
        via: r.via,
        product: { id: r.id, code: r.code, name: r.name },
        tri: trigrams(r.text),
        num: numericSignature(r.text),
        letters: lettersOnly(r.text),
    }));
}

/**
 * Best suggestion for a description, or null if nothing passes the locks. 'same_form' beats 'similar': it's the
 * same description with other punctuation, not one that merely resembles it.
 */
function suggest(description, candidates) {
    const tri = trigrams(description);
    const num = numericSignature(description);
    const letters = lettersOnly(description);
    let best = null;
    // distinct products that pass on similarity alone
    const similar = new Set();
    for (const c of candidates) {
        if (c.num !== num || conflict(description, c.text)) continue;
        const sim = similarity(tri, c.tri);
        const same = letters !== '' && c.letters === letters;
        if (!same && sim < SIMILARITY_THRESHOLD) continue;
        if (!same) similar.add(c.product.id);
        const score = (same ? 2 : 0) + sim;
        if (!best || score > best.score) {
            best = { score, product: c.product, reason: same ? 'same_form' : 'similar', via: c.via, text: c.text, similarity: sim };
        }
    }
    if (!best) return null;
    // two different products on similarity: suggesting one would hide the other, and the screen shows only one
    if (best.reason === 'similar' && similar.size > 1) return null;
    return {
        product: best.product, reason: best.reason, via: best.via, text: best.text,
        similarity: Math.round(best.similarity * 100) / 100,
        // so we don't claim "same measures" for two texts with no numbers
        has_numbers: num !== '',
    };
}

/**
 * What an unlinked description is compared against: already-linked forms (each pointing to its product) plus
 * catalog names. One query per request so a fresh link counts in the next list. Shared by Purchases and the book
 * import so both suggest from the same list. `queryable` is the pool or a transaction client.
 */
async function linkCandidates(queryable) {
    const { rows } = await queryable.query(`
        SELECT pa.alias_norm AS text, 'link' AS via, p.id, p.code, p.name
          FROM product_aliases pa
          JOIN products p ON p.id = pa.product_id
        UNION ALL
        SELECT p.name, 'name', p.id, p.code, p.name
          FROM products p`);
    return prepareCandidates(rows);
}

module.exports = { SIMILARITY_THRESHOLD, EXCLUSIVE_GROUPS, trigrams, similarity, numericSignature, lettersOnly, conflict, prepareCandidates, suggest, linkCandidates };
