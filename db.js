const { Pool } = require('pg');
require('dotenv').config();

// Timeouts turn a database problem into a visible error instead of a hung request.
// The timezone is set per connection: "today" comes from now() in the database, and a managed
// database defaults to UTC, which would start the warehouse day at 18:00.
const zone = /^[A-Za-z0-9_+\-/]+$/.test(process.env.TZ ?? '') ? process.env.TZ : 'America/Mexico_City';
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    options: `-c timezone=${zone}`,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
});

// Without a listener, a Postgres restart makes an idle client emit 'error' and kills the process.
pool.on('error', err => {
    console.error('Idle Postgres connection lost:', err.message);
});

module.exports = pool;
