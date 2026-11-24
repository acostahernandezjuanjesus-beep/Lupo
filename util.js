// Turns malformed input into a 400 with a useful message, so it never reaches Postgres as a raw parameter.

// isNaN('') and isNaN(true) are false, and Number.isInteger('2') is false, so neither works here.
function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

// For anything going into an integer column. Capped at the Postgres max: a bigger id would be a 500 (22003).
const PG_INT_MAX = 2147483647;
function toPositiveInt(value) {
    const n = toNumber(value);
    return n !== null && Number.isInteger(n) && n > 0 && n <= PG_INT_MAX ? n : null;
}

// % and _ are text here, not wildcards
function escapeLike(text) {
    return String(text).replace(/[\\%_]/g, c => '\\' + c);
}

// A ROLLBACK can fail on its own; inside a catch that would swallow the 500 and hang the request.
async function safeRollback(client) {
    try {
        await client.query('ROLLBACK');
    } catch (err) {
        console.error('ROLLBACK failed:', err.message);
    }
}

// Server error: full detail to the log under the request id, only the message and id to the client.
function fail(req, res, err, message) {
    console.error(`[${req.id}]`, err);
    res.status(500).json({ error: message, id: req.id });
}

/** Throw inside a transaction to roll it back and answer with this status (not a 500). */
class Rejection extends Error {
    constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// Same rule as `normalize_supplier` in SQL: lowercase, collapsed spaces, accents and punctuation kept.
const normalizeSupplier = text => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

module.exports = { PG_INT_MAX, toNumber, toPositiveInt, escapeLike, safeRollback, fail, Rejection, normalizeSupplier };
