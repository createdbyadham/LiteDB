// Reader for the append-only audit log.
//
// Read-only by construction: this component has no way to delete or edit an
// entry, because a log its subject can quietly prune answers a different
// question from the one it exists to answer.
//
// The columns are chosen for the question people actually bring to a log —
// "what changed my data, and did I agree to it?" — so provenance, decision and
// outcome sit next to the SQL rather than behind a detail view.

import { useCallback, useEffect, useState } from 'react';
import { Bot, RefreshCw, ShieldX, User } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { auditLogLocation, readAudit, type AuditDecision, type AuditEntry } from '@/lib/auditLog';
import type { StatementKind } from '@/lib/sqlClassifier';

const KIND_STYLE: Record<StatementKind, string> = {
    read: 'bg-muted text-muted-foreground',
    session: 'bg-muted text-muted-foreground',
    ddl: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    write: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    destructive: 'bg-destructive/15 text-destructive',
    unknown: 'bg-destructive/15 text-destructive',
};

const DECISION_LABEL: Record<AuditDecision, string> = {
    allowed: 'ran without a prompt',
    approved: 'approved',
    blocked: 'blocked by policy',
    declined: 'declined',
};

function formatTimestamp(iso: string): string {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export function AuditLogView() {
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [isLoading, setIsLoading] = useState(true);

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
                                            className="text-[10px] gap-1 border-0 bg-violet-500/15 text-violet-600 dark:text-violet-400"
                                        >
                                            <Bot className="h-3 w-3" />
                                            {entry.model ?? 'model'}
                                        </Badge>
                                    ) : (
                                        <Badge
                                            variant="outline"
                                            className="text-[10px] gap-1 border-0 bg-muted text-muted-foreground"
                                        >
                                            <User className="h-3 w-3" />
                                            you
                                        </Badge>
                                    )}
                                    <Badge
                                        variant="outline"
                                        className={`text-[10px] uppercase tracking-wide border-0 ${KIND_STYLE[entry.kind]}`}
                                    >
                                        {entry.kind}
                                    </Badge>
                                    <span className="text-[11px] text-muted-foreground">
                                        {DECISION_LABEL[entry.decision]} · {entry.policy}
                                    </span>
                                    <span className="text-[11px] text-muted-foreground ml-auto">
                                        {formatTimestamp(entry.at)}
                                    </span>
                                </div>

                                {entry.prompt && (
                                    <p className="text-[11px] text-muted-foreground italic">
                                        &ldquo;{entry.prompt}&rdquo;
                                    </p>
                                )}

                                <pre className="text-[11px] font-mono bg-muted/50 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-words">
                                    {entry.sql}
                                </pre>

                                <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                                    <span>{entry.connection}</span>
                                    {entry.estimatedRows !== null && (
                                        <span>{entry.estimatedRows.toLocaleString()} rows</span>
                                    )}
                                    {entry.durationMs !== null && <span>{entry.durationMs} ms</span>}
                                    {entry.outcome === 'error' && (
                                        <span className="text-destructive flex items-center gap-1">
                                            <ShieldX className="h-3 w-3" />
                                            {entry.error ?? 'failed'}
                                        </span>
                                    )}
                                    {entry.outcome === 'not-run' && <span>did not run</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </ScrollArea>
            )}
        </div>
    );
}
