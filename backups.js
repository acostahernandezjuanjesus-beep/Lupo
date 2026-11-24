// Backups are made by whatever you schedule (pg_dump -Fc into this folder); the API only reads it.

const fs = require('node:fs');
const path = require('node:path');

// Names embed date and time, so sorting by name sorts by date. Only these names are ever served.
const NAME = /^inventory-\d{4}-\d{2}-\d{2}_\d{4}\.dump$/;

const folder = () => process.env.LUPO_BACKUPS || path.join(process.cwd(), 'backups');

/** Name of the newest backup, or null if there is no folder or no backup. */
function lastBackup(dir = folder()) {
    try {
        return fs.readdirSync(dir).filter(n => NAME.test(n)).sort().at(-1) ?? null;
    } catch {
        return null;
    }
}

/** Metadata for the newest backup file in `dir`, or null. */
function lastBackupInfo(dir = folder()) {
    const file = lastBackup(dir);
    if (!file) return null;
    try {
        const stat = fs.statSync(path.join(dir, file));
        return { file, bytes: String(stat.size), done_at: stat.mtime.toISOString(), hours: Math.round(((Date.now() - stat.mtimeMs) / 3_600_000) * 10) / 10 };
    } catch {
        return null;
    }
}

module.exports = { lastBackup, lastBackupInfo, folder };
