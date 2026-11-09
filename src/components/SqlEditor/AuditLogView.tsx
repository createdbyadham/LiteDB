// Reader for the append-only audit log.
//
// Read-only by construction: this component has no way to delete or edit an
// entry, because a log its subject can quietly prune answers a different
// question from the one it exists to answer.
//
// The columns are chosen for the question people actually bring to a log,
// "what changed my data, and did I agree to it?", so provenance, decision and
// outcome sit next to the SQL rather than behind a detail view.

import { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw, ShieldX, Undo2, User } from 'lucide-react';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { agentName } from '@/components/Mascot/narrate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import { auditLogLocation, readAudit, type AuditDecision, type AuditEntry } from '@/lib/auditLog';
import { useActiveConnection } from '@/lib/db/connections';
import { loadUndo, planUndoFor, runUndo } from '@/lib/db/undo';
import type { StatementKind } from '@/lib/sqlClassifier';
import type { UndoPlan, UndoRecord } from '@/lib/undoWrite';

const KIND_STYLE: Record<StatementKind, string> = {
    read: 'bg-muted text-muted-foreground',
    session: 'bg-muted text-muted-foreground',
    ddl: 'bg-secondary text-foreground',
    write: 'bg-warning/15 text-warning',
    destructive: 'bg-destructive/15 text-destructive',
    unknown: 'bg-destructive/15 text-destructive',
};

const DECISION_LABEL: Record<AuditDecision, string> = {
    allowed: 'ran without a prompt',
    approved: 'approved',
    blocked: 'blocked by policy',
    declined: 'declined',
    pending: 'awaiting approval',
};

const rows = (n: number) => `${n.toLocaleString()} row${n === 1 ? '' : 's'}`;

/**
 * `sqlite:C:\Users\me\data\shop.db` as `sqlite:shop.db`. Agents log the
 * connection's full id, and a whole path pushed Undo out of the panel.
 */
const shortConnection = (connection: string) => connection.replace(/^(sqlite:).*[\\/]/, '$1');

/** What Undo will do, in the words of the write it reverses. */
function undoSummary(record: UndoRecord, plan: UndoPlan): string {
    const what =
        record.kind === 'delete'
            ? `Puts back ${rows(plan.restore)} deleted from ${record.table}.`
            : record.kind === 'update'
              ? `Sets ${rows(plan.restore)} in ${record.table} back to the values they had.`
              : `Deletes the ${rows(plan.restore)} it added to ${record.table}.`;
    const left = plan.skipped ? ` ${rows(plan.skipped)} changed after the write and stay as they are.` : '';
    return `${what}${left} Rows changed by cascades or triggers are not undone.`;
}

function formatTimestamp(iso: string): string {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export function AuditLogView() {
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const conn = useActiveConnection();
    const { toast } = useToast();
    const [undoing, setUndoing] = useState<{ entry: AuditEntry; record: UndoRecord; plan: UndoPlan } | null>(null);
    const [busy, setBusy] = useState(false);
    /** Undone here, or found already undone. */
    const [undone, setUndone] = useState<Set<string>>(() => new Set());

    const refresh = useCallback(async () => {
        setIsLoading(true);
        try {
            setEntries(await readAudit());
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const offerUndo = async (entry: AuditEntry) => {
        const link = entry.undo;
        if (!link || busy) return;
        setBusy(true);
        try {
            const record = await loadUndo(link);
            if (!record) {
                toast({ title: 'Cannot undo', description: 'The rows saved for this write are gone.', variant: 'destructive' });
                return;
            }
            if (record.undoneAt) {
                setUndone((s) => new Set(s).add(link));
                toast({ title: 'Already undone', description: `Undone ${formatTimestamp(record.undoneAt)}.` });
                return;
            }
            if (!conn || conn.id !== record.connectionId) {
                toast({ title: 'Open that database first', description: `This write was made to ${entry.connection}.` });
                return;
            }
            const plan = await planUndoFor(conn, record);
            if (plan.restore === 0) {
                toast({
                    title: 'Nothing to put back',
                    description: 'Every row changed after the write, so undoing it would overwrite newer work.',
                });
                return;
            }
            setUndoing({ entry, record, plan });
        } catch (error) {
            toast({ title: 'Cannot undo', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
        } finally {
            setBusy(false);
        }
    };

    const confirmUndo = async () => {
        const link = undoing?.entry.undo;
        if (!undoing || !conn || !link) return;
        const { entry, record, plan } = undoing;
        setUndoing(null);
        setBusy(true);
        try {
            await runUndo(conn, link, record, plan, entry.id);
            setUndone((s) => new Set(s).add(link));
            toast({ title: 'Undone', description: undoSummary(record, plan).split('. ')[0] });
            await refresh();
        } catch (error) {
            toast({
                title: 'Undo failed, nothing changed',
                description: error instanceof Error ? error.message : String(error),
                variant: 'destructive',
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col gap-3 h-full">
            <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                    <h3 className="text-sm font-medium">Statement audit</h3>
                    <p className="text-xs text-muted-foreground">
                        Every generated statement, and every change you made by hand. Stored at{' '}
                        <code className="font-mono">{auditLogLocation()}</code> and never sent
                        anywhere.
                    </p>
                </div>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs shrink-0"
                    onClick={() => void refresh()}
                    disabled={isLoading}
                >
                    <RefreshCw
                        className={`mr-1.5 h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`}
                    />
                    Refresh
                </Button>
            </div>

            {entries.length === 0 && !isLoading ? (
                <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground border rounded-md py-12">
                    Nothing recorded yet.
                </div>
            ) : (
                <ScrollArea className="flex-1 pr-3">
                    <div className="space-y-2">
                        {entries.map((entry) => (
                            <div key={entry.id} className="rounded-md border p-2.5 space-y-1.5">
                                <div className="flex items-center gap-2 flex-wrap">
                                    {entry.provenance === 'ai' ? (
                                        <Badge
                                            variant="outline"
                                            className="text-[11px] font-normal gap-1 border-0 bg-secondary text-foreground"
                                        >
                                            <Bot className="h-3 w-3" />
                                            {entry.model ?? (entry.client ? agentName(entry.client) : 'model')}
                                        </Badge>
                                    ) : (
                                        <Badge
                                            variant="outline"
                                            className="text-[11px] font-normal gap-1 border-0 bg-muted text-muted-foreground"
                                        >
                                            <User className="h-3 w-3" />
                                            you
                                        </Badge>
                                    )}
                                    <Badge
                                        variant="outline"
                                        className={`font-mono text-[11px] font-normal border-0 ${KIND_STYLE[entry.kind]}`}
                                    >
                                        {entry.kind}
                                    </Badge>
                                    <span className="text-[11px] text-muted-foreground">
                                        {entry.directLimit
                                            ? `ran without approval · up to ${rows(entry.directLimit)} allowed`
                                            : DECISION_LABEL[entry.decision]}{' '}
                                        · {entry.policy}
                                    </span>
                                    <span className="text-[11px] text-muted-foreground ml-auto">
                                        {formatTimestamp(entry.at)}
                                    </span>
                                </div>

                                {entry.prompt && (
                                    <p className="text-[11px] text-muted-foreground">
                                        &ldquo;{entry.prompt}&rdquo;
                                    </p>
                                )}

                                <pre className="text-[11px] font-mono bg-muted/50 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-words">
                                    {entry.sql}
                                </pre>

                                <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                                    <span className="min-w-0 max-w-[14rem] truncate" title={entry.connection}>
                                        {shortConnection(entry.connection)}
                                    </span>
                                    {entry.actualRows != null ? (
                                        <span
                                            className={
                                                entry.estimatedRows != null &&
                                                entry.estimatedRows !== entry.actualRows
                                                    ? 'text-amber-600 dark:text-amber-400'
                                                    : ''
                                            }
                                        >
                                            {entry.actualRows.toLocaleString()} row
                                            {entry.actualRows === 1 ? '' : 's'} changed
                                            {/* Shown only when the two disagree, the case
                                                where the approval dialog was wrong. */}
                                            {entry.estimatedRows != null &&
                                                entry.estimatedRows !== entry.actualRows &&
                                                ` (predicted ${entry.estimatedRows.toLocaleString()})`}
                                        </span>
                                    ) : entry.estimatedRows != null ? (
                                        <span>~{entry.estimatedRows.toLocaleString()} rows predicted</span>
                                    ) : null}
                                    {entry.durationMs !== null && <span>{entry.durationMs} ms</span>}
                                    {entry.outcome === 'error' && (
                                        <span className="text-destructive flex items-center gap-1">
                                            <ShieldX className="h-3 w-3" />
                                            {entry.error ?? 'failed'}
                                        </span>
                                    )}
                                    {entry.outcome === 'not-run' && <span>did not run</span>}
                                    {entry.undo && entry.outcome === 'ok' &&
                                        (undone.has(entry.undo) ? (
                                            <span className="ml-auto">undone</span>
                                        ) : (
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                className="ml-auto h-6 gap-1 px-2 text-[11px]"
                                                disabled={busy}
                                                onClick={() => void offerUndo(entry)}
                                            >
                                                <Undo2 className="h-3 w-3" /> Undo
                                            </Button>
                                        ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </ScrollArea>
            )}

            <AlertDialog open={undoing !== null} onOpenChange={(open) => !open && setUndoing(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Undo this write?</AlertDialogTitle>
                        <AlertDialogDescription>{undoing ? undoSummary(undoing.record, undoing.plan) : ''}</AlertDialogDescription>
                    </AlertDialogHeader>
                    {undoing && (
                        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1.5 font-mono text-[11px]">
                            {undoing.record.sql}
                        </pre>
                    )}
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void confirmUndo()}>Undo</AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
