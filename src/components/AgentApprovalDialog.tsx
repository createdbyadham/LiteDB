// An agent wants to change the database: the card that decides.
//
// litedb-mcp holds the write and waits (see src/lib/agentApproval.ts). This
// shows what it would do, the statement, the exact row count, the rows it
// deletes, changes or adds, and nothing runs until someone clicks Approve.
// Closing the card declines: the safe way to be wrong is that nothing runs.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Bot, ShieldAlert } from 'lucide-react';
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
import { agentName } from '@/components/Mascot/narrate';
import { columnIndex, type ApprovalDiff, type ApprovalRequest, type ApprovalStatement } from '@/lib/agentApproval';
import { answerApproval, onApprovalsChange, pendingApprovals } from '@/lib/agentApprovals';
import { useConnections } from '@/lib/db/connections';
import { mascot } from '@/lib/mascot';
import { cn } from '@/lib/utils';

const count = (n: number) => n.toLocaleString('en-US');

/** The app's own name for the connection, or the end of its id. */
function connectionName(request: ApprovalRequest, names: Map<string, string>): string {
  const own = names.get(request.connectionId);
  if (own) return own;
  const id = request.connectionId;
  return id.split(/[\\/]/).pop() || id;
}

function ImpactLine({ statement }: { statement: ApprovalStatement }) {
  const { affectedRows, estimatedRows, tableRows, tableRowsCapped, table, unbounded } = statement;
  const of =
    tableRows !== null && tableRows > 0 ? ` of ${count(tableRows)}${tableRowsCapped ? '+' : ''} rows` : '';
  const where = table ? ` in ${table}` : '';
  if (affectedRows !== null) {
    const all = unbounded || (tableRows !== null && !tableRowsCapped && tableRows > 0 && affectedRows >= tableRows);
    return (
      <span className={all ? 'font-medium text-destructive' : ''}>
        Affects {count(affectedRows)}
        {of}
        {where}
        {all ? ', every row in the table' : ''}
      </span>
    );
  }
  if (unbounded) return <span className="font-medium text-destructive">Affects every row{of}{where}</span>;
  if (estimatedRows !== null) return <span>Planner estimates ~{count(estimatedRows)} rows{where}</span>;
  return <span className="text-muted-foreground">Rows affected could not be counted</span>;
}

function DiffTable({ diff, affected }: { diff: ApprovalDiff; affected: number | null }) {
  if (diff.error) {
    return <p className="text-xs text-muted-foreground">The rows could not be shown: {diff.error}</p>;
  }
  if (diff.rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No rows match.</p>;
  }
  const label =
    diff.mode === 'update' ? 'Rows it changes' : diff.mode === 'insert' ? 'Rows it adds' : 'Rows it deletes';
  const shown = diff.truncated
    ? `, the first ${count(diff.rows.length)}${affected !== null ? ` of ${count(affected)}` : ''}`
    : '';

  // An UPDATE shows the first column, to say which row, and every column it sets.
  const changed = new Map<number, string[]>();
  for (const change of diff.changes ?? []) {
    const index = columnIndex(diff.columns, change.column);
    if (index >= 0) changed.set(index, change.values);
  }
  const visible =
    diff.mode === 'update'
      ? [...new Set([0, ...changed.keys()])].filter((i) => i < diff.columns.length).sort((a, b) => a - b)
      : diff.columns.map((_, i) => i);

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {label}
        {shown}
      </p>
      <div className="max-h-48 overflow-auto rounded-md border">
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {visible.map((i) => (
                <th key={i} className="whitespace-nowrap px-2 py-1 text-left font-medium text-muted-foreground">
                  {diff.columns[i]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {diff.rows.map((row, r) => (
              <tr
                key={r}
                className={cn(
                  'border-t',
                  diff.mode === 'delete' || diff.mode === 'truncate' ? 'bg-destructive/10' : '',
                  diff.mode === 'insert' ? 'bg-positive/10' : '',
                )}
              >
                {visible.map((i) => {
                  const next = changed.get(i)?.[r];
                  return (
                    <td key={i} className="max-w-[220px] truncate whitespace-nowrap px-2 py-1" title={row[i]}>
                      {next !== undefined && next !== row[i] ? (
                        <>
                          <span className="text-muted-foreground line-through">{row[i]}</span>
                          <span className="px-1 text-muted-foreground">→</span>
                          <span className="font-medium">{next}</span>
                        </>
                      ) : (
                        row[i]
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function useCountdown(until: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (!until) return '';
  const left = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

export function AgentApprovalDialog() {
  const requests = useSyncExternalStore(onApprovalsChange, pendingApprovals);
  const { connections } = useConnections();
  const request = requests[0];
  const token = request?.token;
  const [typed, setTyped] = useState('');
  const [sending, setSending] = useState(false);
  const left = useCountdown(request?.expiresAt);

  // A new request starts clean: a phrase typed for one can never approve the next.
  useEffect(() => {
    setTyped('');
    setSending(false);
  }, [token]);

  // Star hops onto the card while it is up.
  useEffect(() => (token ? mascot.perchOn('approval') : undefined), [token]);

  if (!request) return null;

  const names = new Map(connections.map((c) => [c.id, c.name]));
  const agent = agentName(request.client);
  const target = connectionName(request, names);
  const confirmed = !request.requireTypedConfirmation || typed.trim() === request.confirmPhrase.trim();
  const writes = request.statements.filter((s) => s.kind !== 'read');

  const answer = async (decision: 'approved' | 'declined') => {
    if (sending) return;
    setSending(true);
    mascot.gesture(decision === 'approved' ? 'nod' : 'shake');
    try {
      await answerApproval(request.token, decision);
    } catch (error) {
      console.error('Could not answer the agent:', error);
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && void answer('declined')}>
      {/* Above Star's body (z-60), below its fingertips (z-62), like the editor's approval. */}
      <DialogContent data-mascot-perch="approval" className="z-[61] sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {request.destructive ? (
              <ShieldAlert className="h-4 w-4 text-destructive" />
            ) : (
              <Bot className="h-4 w-4 text-key" />
            )}
            {agent} wants to change {target}
          </DialogTitle>
          <DialogDescription>
            {request.reason} Nothing runs until you approve it here.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[52vh] space-y-4 overflow-y-auto pr-1">
          {writes.map((statement, i) => (
            <div key={i} className="space-y-2">
              <pre className="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 font-mono text-xs">
                {statement.sql}
              </pre>
              <p className="text-sm">
                <ImpactLine statement={statement} />
              </p>
              {statement.diff && <DiffTable diff={statement.diff} affected={statement.affectedRows} />}
            </div>
          ))}
        </div>

        {request.requireTypedConfirmation && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              This destroys data with nothing limiting it. Type <span className="font-mono font-medium text-foreground">{request.confirmPhrase}</span> to approve.
            </p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="h-8 font-mono text-sm" autoFocus />
          </div>
        )}

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {requests.length > 1 ? `${requests.length - 1} more waiting · ` : ''}
            {agent} is waiting · expires in {left}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => void answer('declined')} disabled={sending}>
              Decline
            </Button>
            <Button
              variant={request.destructive ? 'destructive' : 'default'}
              onClick={() => void answer('approved')}
              disabled={sending || !confirmed}
            >
              Approve
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
