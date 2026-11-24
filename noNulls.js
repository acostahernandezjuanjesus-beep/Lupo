// Postgres rejects \u0000 in any text (22021), which would be a 500. Cut it here with a 400.

function noNulls(req, res, next) {
    // %00 is a null in the URL; %2500 is the literal text "%00" and is fine.
    if (/%00/.test(req.url)) {
        return res.status(400).json({ error: 'The text contains invalid characters', error_code: 'invalid_character' });
    }
    // JSON.stringify writes a null as \u0000 (6 chars), at any depth, keys included.
    if (req.body && typeof req.body === 'object' && JSON.stringify(req.body).includes('\\u0000')) {
        return res.status(400).json({ error: 'The text contains invalid characters', error_code: 'invalid_character' });
    }
    next();
}

module.exports = { noNulls };
