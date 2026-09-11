// The approval step: what this statement will do, before it does it.
//
// "Are you sure?" is a question nobody can answer well. This dialog exists to
// replace it with one they can: which statements are about to run, what
// category each falls in, how many rows each will touch, and out of how many.
// A count is the difference between clicking through a warning and reading it.
//
// The typed confirmation is deliberately rationed. It appears only for
// statements that change data with no predicate bounding them — the class
// where a mis-click cannot be undone and where there is no row count to show
// short of the whole table. Applying it to every write would train the habit
// of typing the word without reading the sentence above it.

import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ImpactEstimate } from '@/lib/impactPreview';
import type { StatementKind } from '@/lib/sqlClassifier';
import type { GateDecision } from '@/lib/sqlPolicy';

interface ApprovalDialogProps {
    open: boolean;
    decision: GateDecision | null;
    previews: ImpactEstimate[];
    isPreviewing: boolean;
    /** True while the approved script is actually running. */
    isRunning?: boolean;
    onCancel: () => void;
    onApprove: () => void;
}

const KIND_STYLE: Record<StatementKind, string> = {
    read: 'bg-muted text-muted-foreground',
    session: 'bg-muted text-muted-foreground',
    ddl: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    write: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    destructive: 'bg-destructive/15 text-destructive',
    unknown: 'bg-destructive/15 text-destructive',
};

function formatCount(value: number): string {
    return value.toLocaleString();
}

/**
 * The impact line for one statement.
 *
 * An exact count and a planner estimate are different claims and are labelled
 * differently. Collapsing them into one number would make a guess look like a
 * measurement at exactly the moment that distinction matters.
 */
function formatTableRows(tableRows: number, capped: boolean): string {
    return capped ? `${formatCount(tableRows)}+` : formatCount(tableRows);
}

function ImpactLine({ preview }: { preview: ImpactEstimate }) {
    const { exactRows, estimatedRows, tableRows, tableRowsCapped, error, statement } = preview;
    const proportion =
        tableRows !== null && tableRows > 0
            ? ` of ${formatTableRows(tableRows, tableRowsCapped)} row${tableRows === 1 && !tableRowsCapped ? '' : 's'}`
            : '';

    if (statement.unbounded && exactRows === null && tableRows !== null && tableRowsCapped) {
        return (
            <span className="text-destructive font-medium">
                Affects every row{proportion}
            </span>
        );
    }

    if (exactRows !== null) {
        const all =
            statement.unbounded ||
            (tableRows !== null && !tableRowsCapped && tableRows > 0 && exactRows >= tableRows);
        return (
            <span className={all ? 'text-destructive font-medium' : ''}>
                Affects {formatCount(exactRows)}
                {proportion}
                {all ? ' — every row in the table' : ''}
            </span>
        );
    }

    if (estimatedRows !== null) {
        return <span>Planner estimates ~{formatCount(estimatedRows)} rows</span>;
    }

    if (error) {
        return <span className="text-muted-foreground">Impact unavailable — {error}</span>;
    }

    return <span className="text-muted-foreground">Impact could not be estimated</span>;
}

export function ApprovalDialog({
    open,
    decision,
    previews,
    isPreviewing,
    isRunning = false,
    onCancel,
    onApprove,
}: ApprovalDialogProps) {
    const [typed, setTyped] = useState('');
    const [expandedPlan, setExpandedPlan] = useState<number | null>(null);

    // Reset between openings, so a previously typed confirmation can never
    // carry over and pre-authorise the next statement.
    useEffect(() => {
        if (!open) {
            setTyped('');
            setExpandedPlan(null);
        }
    }, [open]);

    if (!decision) return null;

    const destructive = decision.kind === 'destructive';
    // The word to type: the table at risk, or the verb when no table was
    // identified. Naming the table makes the confirmation about this specific
    // object rather than a reflex.
    const confirmPhrase = decision.worst?.table ?? decision.worst?.verb ?? 'RUN';
    const confirmed = !decision.requireTypedConfirmation || typed.trim() === confirmPhrase.trim();

    const previewFor = (sql: string): ImpactEstimate | undefined =>
        previews.find((p) => p.statement.sql === sql);

    return (
        <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        {destructive ? (
                            <ShieldAlert className="h-4 w-4 text-destructive" />
                        ) : (
                            <ShieldCheck className="h-4 w-4 text-amber-500" />
                        )}
                        {destructive ? 'This will destroy data' : 'This will change the database'}
                    </DialogTitle>
                    <DialogDescription>{decision.reason}</DialogDescription>
                </DialogHeader>

                <ScrollArea className="max-h-[280px] pr-3">
                    <div className="space-y-2">
                        {decision.statements.map((statement, index) => {
                            const preview = previewFor(statement.sql);
                            const isRead = statement.kind === 'read';
                            return (
                                <div
                                    key={`${index}-${statement.sql.slice(0, 32)}`}
                                    className="rounded-md border p-2.5 space-y-1.5"
                                >
                                    <div className="flex items-center gap-2">
                                        <Badge
                                            variant="outline"
                                            className={`text-[10px] uppercase tracking-wide border-0 ${KIND_STYLE[statement.kind]}`}
                                        >
                                            {statement.kind}
                                        </Badge>
                                        <span className="text-xs text-muted-foreground">
                                            {statement.reason}
                                        </span>
                                    </div>

                                    <pre className="text-[11px] font-mono bg-muted/50 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-words">
                                        {statement.sql}
                                    </pre>

                                    {!isRead && (
                                        <div className="text-xs">
                                            {isPreviewing && !preview ? (
                                                <span className="text-muted-foreground flex items-center gap-1.5">
                                                    <Loader2 className="h-3 w-3 animate-spin" />
                                                    Measuring impact…
                                                </span>
                                            ) : preview ? (
                                                <ImpactLine preview={preview} />
                                            ) : null}
                                        </div>
                                    )}

                                    {preview?.plan && (
                                        <div>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    setExpandedPlan(
                                                        expandedPlan === index ? null : index,
                                                    )
                                                }
                                                className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
                                            >
                                                <ChevronRight
                                                    className={`h-3 w-3 transition-transform ${expandedPlan === index ? 'rotate-90' : ''}`}
                                                />
                                                Query plan
                                            </button>
                                            {expandedPlan === index && (
                                                <pre className="mt-1 text-[10px] font-mono text-muted-foreground bg-muted/30 rounded px-2 py-1.5 overflow-x-auto">
                                                    {preview.plan}
                                                </pre>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </ScrollArea>

                {decision.requireTypedConfirmation && (
                    <div className="space-y-1.5 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                        <Label
                            htmlFor="confirm-phrase"
                            className="text-xs flex items-center gap-1.5"
                        >
                            <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                            Type <code className="font-mono font-semibold">{confirmPhrase}</code> to
                            confirm
                        </Label>
                        <Input
                            id="confirm-phrase"
                            value={typed}
                            onChange={(event) => setTyped(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            className="h-8 text-sm font-mono"
                        />
                    </div>
                )}

                <DialogFooter className="gap-2 sm:gap-2">
                    <Button variant="outline" size="sm" onClick={onCancel} disabled={isRunning}>
                        Cancel
                    </Button>
                    <Button
                        size="sm"
                        variant={destructive ? 'destructive' : 'default'}
                        disabled={!confirmed || isRunning || isPreviewing}
                        onClick={onApprove}
                    >
                        {isRunning && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                        {destructive ? 'Run anyway' : 'Run'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
