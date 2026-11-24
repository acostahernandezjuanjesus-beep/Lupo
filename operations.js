// Process lifecycle: startup, timeouts, shutdown and cleanup. Kept out of index.js so `createApp` stays
// just routes (testable without opening a port).

const migrate = require('./migrate');

// Node closes idle connections after 5 s, but a proxy keeps its own open longer; reusing one Node already
// closed gives a one-off 502. So keep-alive goes above a typical proxy's ~90 s.
const KEEP_ALIVE_MS = 100_000;
const HEADERS_MS = 110_000;       // always above keep-alive
const BODY_MS = 120_000;          // receiving a 14 MB scanned sheet over bad wifi
const SHUTDOWN_MS = 8_000;        // hard cap on a clean shutdown

// Sessions expired or closed over a week ago are useless; keep a week to know who was connected.
const PURGE_EVERY_MS = 6 * 3_600_000;
async function purgeSessions(pool) {
    const { rowCount } = await pool.query(
        `DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR closed_at < now() - interval '7 days'`);
    return rowCount;
}

async function start(createApp, pool, { port = process.env.PORT || 3000, log = console } = {}) {
    // Migrate BEFORE opening the port: new code on the old schema would 500.
    if (process.env.LUPO_MIGRATE === '1') {
        try {
            await migrate.applyPending(pool, { log: m => log.log(m) });
        } catch (err) {
            log.error(`Not starting: ${err.message}`);
            process.exit(1);
        }
    }

    const server = createApp(pool, undefined, { accessLog: m => log.log(m) })
        .listen(port, () => log.log(`API at http://localhost:${port}`));
    server.keepAliveTimeout = KEEP_ALIVE_MS;
    server.headersTimeout = HEADERS_MS;
    server.requestTimeout = BODY_MS;

    const purge = () => purgeSessions(pool)
        .then(n => { if (n) log.log(`expired sessions purged: ${n}`); })
        .catch(err => log.error('session purge:', err.message));
    purge();
    const timer = setInterval(purge, PURGE_EVERY_MS);
    timer.unref();

    // Graceful shutdown: stop accepting, let in-flight requests finish, release the pool. Past the deadline, exit anyway.
    let closing = false;
    const shutdown = signal => {
        if (closing) return;
        closing = true;
        log.log(`${signal}: shutting down`);
        clearInterval(timer);
        setTimeout(() => process.exit(1), SHUTDOWN_MS).unref();
        server.close(() => pool.end().finally(() => process.exit(0)));
        server.closeIdleConnections();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    return server;
}

module.exports = { start, purgeSessions };
