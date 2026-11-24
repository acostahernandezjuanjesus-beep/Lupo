# Lupo

Warehouse and tool-crib inventory control — Node.js/PostgreSQL API with a React/Carbon web client designed for both counter PCs and shop-floor phones.

> **Regional note:** Core inventory, barcode/QR scanning, floor requests, requisitions, suppliers, and user management work anywhere. The optional **Invoices** (Mexican CFDI 4.0) and **Purchase books** (Spanish `.xlsx` headers) modules target Mexican workflows.

## Features

- **Inventory & movements:** Stock balances, min/target levels, physical counts, stock-in/out/loan/return/adjustment tracking, audit history, and multi-code/alias lookup.
- **Barcode & QR scanning:** Phone camera scanner (with automatic rear-lens switching) and USB HID reader support (including a standalone reader test page at `/reader.html`).
- **Shop-floor material requests:** Operators request parts from the floor; storekeepers get live queue updates and optional Web Push alerts on phones/desktops.
- **Requisitions:** Min-max reorder suggestions calculated from current balances, minimums, and target levels.
- **Purchase books & suppliers:** Import monthly `.xlsx` purchase books (Spanish headers: `FECHA`, `FOLIO`, `MATERIAL`, `CANTIDAD`, `PRECIO`, `PROVEEDOR`), suggest catalog links, detect price spikes, and maintain a supplier directory with aliases, contacts, and tags.
- **Invoices (Mexican CFDI 4.0):** Capture supplier invoices from CFDI XML, SAT QR codes, manual entry, or an optional vision-model paper reader (DeepSeek), with line-by-line stock reconciliation and automatic spend/project classification.
- **Role-based access & diagnostics:** Scrypt password hashing, revocable server-side sessions, IP/account login throttling, credential audit log, system health diagnostics, and optional backup downloads.

## Tech Stack

- **Backend:** Node.js (≥ 22), Express 5, PostgreSQL (`pg`), `fast-xml-parser`, `web-push`
- **Frontend:** React 19, TypeScript, Vite, IBM Carbon (`@carbon/react`), Tailwind CSS, TanStack Query, `@zxing/browser`, `pdfjs-dist`

## Prerequisites

- [Node.js](https://nodejs.org/) 22 or newer
- [PostgreSQL](https://www.postgresql.org/) 18 (earlier recent versions may work, CI tests against PostgreSQL 18)

## Quick Start

1. **Install dependencies** (API and client):

   ```bash
   npm install
   cd client && npm install && cd ..
   ```

2. **Create a database** in PostgreSQL (for example `inventory`) and configure `.env`:

   ```bash
   cp .env.example .env
   ```

   Set `DATABASE_URL` in `.env` and keep `LUPO_MIGRATE=1` so the server installs `db/schema.sql`, `db/seed.sql`, and any `db/NNN_*.sql` migrations on startup.

3. **Start the API** (applies the schema on first boot):

   ```bash
   npm run dev
   ```

4. **Create the first admin user** from another terminal:

   ```bash
   node scripts/users.js create "Your Name" admin
   node scripts/users.js password 1 --generate
   ```

   Sign in with the generated temporary password — Lupo will prompt you to set your own password on first login.

5. **Start the web client:**

   ```bash
   cd client
   npm run dev
   ```

   Open `http://localhost:5173`. To test phone camera scanning on your local network over HTTPS, run `LUPO_LAN=1 npm run dev` in `client/`.

### Single-process production build

Build the client once and let Express serve `client/dist`:

```bash
cd client && npm run build && cd ..
SERVE_CLIENT=1 npm start
```

## Roles

| Role | Access |
|---|---|
| `operator` | Browse inventory (without prices), scan codes, record outs/loans/returns, request materials, view own movements |
| `storekeeper` | Full inventory edits & counts, floor request queue & push alerts, purchases, suppliers, invoices, requisitions |
| `admin` | Everything in `storekeeper`, plus product code edits, supplier merge/archive/delete, user management, system status, backup downloads |
| `technician` | Read-only system diagnostics, user list, and credential audit log (no inventory or pricing data) |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `PORT` | `3000` | HTTP port for the API |
| `LUPO_MIGRATE` | `0` | Set to `1` to apply `db/schema.sql`, `db/seed.sql`, and pending `db/NNN_*.sql` on startup |
| `SERVE_CLIENT` | `0` | Set to `1` to serve the built SPA from `client/dist` |
| `TZ` | `America/Mexico_City` | PostgreSQL session time zone used for "today" calculations |
| `LUPO_PROXY` | `0` | Number of reverse proxies in front of the API (needed for accurate rate-limit IPs) |
| `LUPO_BACKUPS` | `./backups` | Directory containing `inventory-YYYY-MM-DD_HHMM.dump` files for admin backup downloads |
| `LUPO_DOMAIN` | `mailto:admin@example.com` | Public hostname used as the Web Push VAPID contact (`https://<domain>`) |
| `LUPO_VERSION` | `package.json` version | Version string reported on the System screen |
| `DEEPSEEK_API_KEY` | *(unset)* | Optional API key for the AI paper-invoice reader (returns `503` when unset; everything else works) |
| `DEEPSEEK_URL` | `https://api.deepseek.com/chat/completions` | Override endpoint for the vision model |
| `DEEPSEEK_MODEL` | `deepseek-flash` | Override model name for the vision model |
| `LUPO_LAN` | `0` | Client dev only: set to `1` to expose Vite over the LAN with a self-signed HTTPS certificate |
| `LUPO_API_TARGET` | `http://localhost:3000` | Client dev only: target API URL for Vite's `/api` proxy |
| `LUPO_TEST_ADMIN_URL` | *(unset)* | Disposable PostgreSQL admin URL for running database-backed tests (`lupo_test_*` databases) |

## Testing & Linting

```bash
# Server lint & tests
npm run lint
npm test

# Include PostgreSQL integration tests (creates and drops temporary lupo_test_* databases)
LUPO_TEST_ADMIN_URL=postgres://postgres:test@localhost:5432/postgres npm test

# Client typecheck, lint, and build
cd client
npx tsc -p tsconfig.app.json --noEmit
npx eslint src
npm run build
```

Synthetic sample CFDI invoices (XML, PDF, and a simulated phone photo) live in `test/samples/` — see [`test/samples/README.md`](test/samples/README.md).

## License

[MIT](LICENSE)
