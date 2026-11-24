// Security headers, request id and access log. No dependencies: it's five headers and one log line.

const crypto = require('node:crypto');

// The session token lives in localStorage, so `script-src 'self'` is the defence that matters.
//   style-src 'unsafe-inline': Carbon and React set `style=""` on elements.
//   img-src blob: data:  PDF pages are drawn to local images.
//   worker-src blob:     pdf.js and the scanner use workers.
//   'wasm-unsafe-eval':  pdf.js decodes JPEG2000 with WebAssembly. It does not allow JS eval.
//   object-src blob:     "open in new tab" embeds a PDF from a blob:.
const CSP = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    'object-src blob:',
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

function headers(req, res, next) {
    res.set({
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        // only the scanner needs the camera
        'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin',
    });
    // Prices and who took what stay out of a shared PC's browser cache. Routes that want caching set it themselves.
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    // With `trust proxy`, req.secure follows the proxy.
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
    next();
}

/** Always generated server-side: accepting the client's would let anyone write into the log. */
function requestId(req, res, next) {
    req.id = crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
}

/**
 * One JSON line per request. `output` writes it; without it nothing is logged.
 * No query string, bodies or headers, so never a password or token.
 */
function accessLog(output) {
    return (req, res, next) => {
        if (!output) return next();
        const t0 = process.hrtime.bigint();
        res.on('finish', () => {
            // healthchecks hit this frequently; only failures matter
            if (req.originalUrl === '/api/health' && res.statusCode < 400) return;
            output(JSON.stringify({
                t: new Date().toISOString(),
                id: req.id,
                ip: req.ip,
                m: req.method,
                path: req.originalUrl.split('?')[0],
                s: res.statusCode,
                ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
                u: res.locals.userId ?? req.user?.id ?? null,
            }));
        });
        next();
    };
}

module.exports = { headers, requestId, accessLog, CSP };
