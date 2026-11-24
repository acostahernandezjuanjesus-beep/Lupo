/** GET /api/admin/diagnostics and the warnings worth showing from it. */

export type Diagnostics = {
    version: string
    node: string
    server_time: string
    uptime_s: number
    database: { version: string; response_ms: number; size_bytes: string; connections: { total: number | null; idle: number | null; waiting: number | null } }
    migrations: { registry: boolean; applied: number | null; pending: string[] | null }
    backup: { status: 'ok' | 'late' | 'no_record' | 'unconfigured'; last_at: string | null; hours_ago: number | null; file: string | null; bytes: string | null }
    active_sessions: number
    active_users: number
    config: { ai_reader: boolean; proxy_hops: number; migrate_on_start: boolean }
}

/** Plain-words warnings. Empty = all good. A backup with no record is never "ok". */
export function systemProblems(d: Diagnostics): string[] {
    const p: string[] = []
    if (d.backup.status === 'late') p.push(`Last backup was ${Math.round(d.backup.hours_ago ?? 0)} hours ago.`)
    if (d.backup.status === 'no_record') p.push('There is no backup on record yet.')
    if (d.migrations.pending?.length) p.push(`${d.migrations.pending.length} database update(s) not applied.`)
    if (d.database.response_ms > 1000) p.push(`The database took ${d.database.response_ms} ms to respond.`)
    if ((d.database.connections.waiting ?? 0) > 0) p.push('Requests are waiting for a database connection.')
    return p
}

export function readableBytes(bytes: string | number | null): string {
    if (bytes === null) return '—'
    const n = Number(bytes)
    if (!Number.isFinite(n)) return '—'
    for (const [limit, u] of [[1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB']] as const) if (n >= limit) return `${(n / limit).toFixed(1)} ${u}`
    return `${n} B`
}

export function duration(seconds: number): string {
    if (seconds < 60) return `${seconds} s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`
    return `${Math.floor(seconds / 86400)} d`
}
