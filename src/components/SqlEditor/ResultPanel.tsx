import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Copy, Download, Lightbulb, Loader2, Sparkles, Square, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { DataGrid, type CellPosition } from '@/components/DataGrid';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import { toast } from '@/hooks/use-toast';
import type { RunError, StatementResult } from '@/lib/db/native';
import type { SqlDialect } from '@/lib/schemaTypes';
import { COPY_FORMATS, cellText, formatRows, type CopyFormat } from '@/lib/db/sqlLiteral';

export interface RunOutcome {
  statements: string[];
  results: StatementResult[];
  errors: RunError[];
  elapsedMs: number;
  rolledBack: boolean;
  /** The row limit the run used, or null for none. */
  limit: number | null;
  /** Statement index -> whether it changes rows (so its count is worth showing). */
  writes: boolean[];
}

interface ResultPanelProps {
  outcome: RunOutcome | null;
  running: { startedAt: number } | null;
  onCancel: () => void;
  onFix: (error: RunError) => void;
  /** Ask the model why it failed; the answer shows under the error. */
  onExplainError: (error: RunError) => void;
  explanation: string | null;
  explaining: boolean;
  onExport: (result: StatementResult, format: 'csv' | 'json' | 'xlsx') => void;
  dialect: SqlDialect;
  aiConfigured: boolean;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  return <span className="tabular-nums">{((now - since) / 1000).toFixed(1)}s</span>;
}

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

export function ResultPanel({ outcome, running, onCancel, onFix, onExplainError, explanation, explaining, onExport, dialect, aiConfigured }: ResultPanelProps) {
  const resultSets = useMemo(() => outcome?.results.filter((r) => r.returnsRows) ?? [], [outcome]);
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(Math.max(0, resultSets.length - 1)), [resultSets]);

  if (running) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>
          Running… <Elapsed since={running.startedAt} />
        </span>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onCancel}>
          <Square className="mr-1.5 h-3 w-3" /> Cancel
        </Button>
      </div>
    );
  }

  if (!outcome) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Results appear here. Run the statement under the cursor, or the whole script.
      </div>
    );
  }

  const current = resultSets[selected];
  const changed = outcome.results.reduce((n, r) => (outcome.writes[r.statement] ? n + r.rowsAffected : n), 0);
  const anyWrites = outcome.writes.some(Boolean);
  const error = outcome.errors[0];

  const copyResult = async (result: StatementResult, rows: unknown[][], format: CopyFormat) => {
    try {
      await copyText(formatRows(result.columns, rows, format, { dialect, table: 'query_result' }));
      toast({ title: 'Copied', description: plural(rows.length, 'row') });
    } catch (e) {
      toast({ title: 'Not copied', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    }
  };

  const contextMenu = (cell: CellPosition) => {
    if (!current) return null;
    const row = current.rows[cell.row];
    return (
      <>
        <ContextMenuItem onClick={() => void copyText(cellText(row?.[cell.col]))}>
          <Copy className="mr-2 h-3.5 w-3.5" /> Copy cell
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <span className="ml-[22px]">Copy row as</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-60">
            {COPY_FORMATS.map((f) => (
              <ContextMenuItem key={f.value} onClick={() => void copyResult(current, [row], f.value)}>
                {f.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <span className="ml-[22px]">Copy all rows as</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-60">
            {COPY_FORMATS.map((f) => (
              <ContextMenuItem key={f.value} onClick={() => void copyResult(current, current.rows, f.value)}>
                {f.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      </>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-3 h-9 shrink-0 text-xs">
        {error ? (
          <span className="flex items-center gap-1.5 text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
            {error.cancelled ? 'Cancelled' : outcome.statements.length > 1 ? `Statement ${error.statement + 1} failed` : 'Failed'}
            {outcome.rolledBack && <span className="text-muted-foreground">· rolled back, nothing changed</span>}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-positive">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {outcome.statements.length > 1 ? `${outcome.statements.length} statements` : 'Done'}
          </span>
        )}
        {anyWrites && !error && (
          <span className={cn(changed === 0 ? 'text-warning' : 'text-muted-foreground')}>
            {changed === 0 ? 'nothing matched, 0 rows changed' : `${plural(changed, 'row')} changed`}
          </span>
        )}
        <span className="text-muted-foreground tabular-nums">{outcome.elapsedMs.toLocaleString()} ms</span>
        {resultSets.length > 1 && (
          <div className="flex items-center gap-1">
            {resultSets.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setSelected(i)}
                className={cn('rounded px-1.5 py-0.5', i === selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                Result {i + 1}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {current && (
            <span className="text-muted-foreground tabular-nums">
              {plural(current.rows.length, 'row')}
              {current.truncated && outcome.limit !== null && (
                <span className="ml-1 text-warning" title="Raise the row limit in the toolbar to see more">
                  (limit {outcome.limit.toLocaleString()} reached)
                </span>
              )}
            </span>
          )}
          {current && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 text-xs">
                  <Download className="mr-1.5 h-3.5 w-3.5" /> Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Save to a file</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => onExport(current, 'csv')}>CSV</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport(current, 'json')}>JSON</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onExport(current, 'xlsx')}>Excel</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Copy to the clipboard</DropdownMenuLabel>
                {COPY_FORMATS.map((f) => (
                  <DropdownMenuItem key={f.value} onClick={() => void copyResult(current, current.rows, f.value)}>
                    {f.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {error && !error.cancelled && (
        <div className="border-b bg-destructive/5 px-3 py-2 text-xs">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-destructive">{error.message}</pre>
            {aiConfigured && (
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onExplainError(error)} disabled={explaining}>
                  {explaining ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Lightbulb className="mr-1.5 h-3.5 w-3.5" />} Explain
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onFix(error)}>
                  <Sparkles className="mr-1.5 h-3.5 w-3.5 text-key" /> Fix with AI
                </Button>
              </div>
            )}
          </div>
          {explanation && (
            <p className="mt-2 ml-[26px] rounded-md border bg-background/70 p-2 text-[12px] leading-relaxed text-foreground" aria-live="polite">
              {explanation}
            </p>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1">
        {current ? (
          <DataGrid
            columns={current.columns.map((c, i) => ({ key: `${i}:${c}`, title: c, type: current.columnTypes[i] }))}
            rows={current.rows}
            contextMenu={contextMenu}
            emptyMessage="No rows"
          />
        ) : (
          !error && (
            <div className="p-3 text-xs text-muted-foreground space-y-1">
              {outcome.results.map((r, i) => (
                <div key={i}>
                  {outcome.statements.length > 1 ? `Statement ${r.statement + 1}: ` : ''}
                  {outcome.writes[r.statement] ? `${plural(r.rowsAffected, 'row')} changed` : 'OK'}
                  <span className="ml-2 tabular-nums">{r.elapsedMs} ms</span>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
