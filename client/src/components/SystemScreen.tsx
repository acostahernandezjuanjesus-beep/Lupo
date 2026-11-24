import { useMutation, useQuery } from '@tanstack/react-query'
import { Button, InlineLoading, InlineNotification, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tile } from '@carbon/react'
import type { AuditEntry } from '../types'
import { Download } from '@carbon/icons-react'
import { downloadFile } from '../api'
import { fetchJson, errorMessage } from '../queries'
import { systemProblems, type Diagnostics } from '../system'
import { DismissibleNotice } from './DismissibleNotice'

export function SystemScreen({ canDownloadBackup = false }: { canDownloadBackup?: boolean }) {
    const diag = useQuery({ queryKey: ['admin', 'diagnostics'], queryFn: fetchJson<Diagnostics>('/api/admin/diagnostics'), refetchInterval: 30_000 })
    const audit = useQuery({ queryKey: ['admin', 'audit-log'], queryFn: fetchJson<AuditEntry[]>('/api/admin/audit-log') })
    const download = useMutation({ mutationFn: () => downloadFile('/api/admin/backup') })
    const d = diag.data
    const problems = d ? systemProblems(d) : []

    return <section className="page flex flex-col gap-4">
        <div>
            <h1 className="text-[1.75rem] font-light">System</h1>
        </div>

        {diag.error && <InlineNotification kind="error" title="Could not read system status" subtitle={errorMessage(diag.error)} hideCloseButton />}
        {diag.isPending && <InlineLoading description="Loading…" />}

        {problems.map(p => <DismissibleNotice key={p} title="Attention" text={p} />)}

        {canDownloadBackup && d && d.backup.status !== 'unconfigured' && <div className="flex flex-col items-start gap-2">
            <Button kind="tertiary" size="md" renderIcon={Download} disabled={download.isPending} onClick={() => download.mutate()}>
                {download.isPending ? 'Preparing…' : 'Download latest backup'}
            </Button>
            {download.isSuccess && <p className="muted">Saved: {download.data}</p>}
            {download.error && <InlineNotification kind="error" title="Could not download" subtitle={errorMessage(download.error)} hideCloseButton />}
        </div>}

        <Tile className="panel stack">
            <h2>Audit log</h2>
            {audit.error && <InlineNotification kind="error" title="Could not read the audit log" subtitle={errorMessage(audit.error)} hideCloseButton />}
            {audit.data && <div className="table-scroll">
                <Table className="card-table" aria-label="Audit log">
                    <TableHead><TableRow>{['When', 'What', 'Whose', 'Who', 'Detail'].map(h => <TableHeader key={h}>{h}</TableHeader>)}</TableRow></TableHead>
                    <TableBody>{audit.data.map(b => <TableRow key={b.id}>
                        <TableCell>{new Date(b.date).toLocaleString('en-US')}</TableCell><TableCell data-label="What">{b.action}</TableCell><TableCell data-label="Whose">{b.user_name}</TableCell>
                        <TableCell data-label="Who">{b.actor ?? 'Terminal'}</TableCell><TableCell data-label="Detail">{b.detail ?? '—'}</TableCell>
                    </TableRow>)}</TableBody>
                </Table>
            </div>}
        </Tile>
    </section>
}
