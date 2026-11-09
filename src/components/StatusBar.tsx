import { useState } from 'react';
import { Server, HardDrive, Check, Eye, Flame, Plug, ShieldAlert, ShieldCheck, ShieldOff, KeyRound, GitBranch } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useDirectWrites } from '@/hooks/useDirectWrites';
import { useSafetyPolicy } from '@/hooks/useSafetyPolicy';
import { acknowledgeYolo, hasAcknowledgedYolo } from '@/lib/queryGate';
import type { SafetyPolicy } from '@/lib/sqlPolicy';
import type { OpenConnection } from '@/lib/db/connections';
import { cn } from '@/lib/utils';

/**
 * The safety mode sits in the status bar rather than in settings because it
 * changes what the next click will do. A mode you have to go looking for is
 * one you forget you are in.
 */
const POLICY_UI: Record<SafetyPolicy, { label: string; icon: typeof Eye; className: string; hint: string }> = {
  'read-only': {
    label: 'Read-only',
    icon: Eye,
    className: 'text-muted-foreground',
    hint: 'Nothing can change the database.',
  },
  guarded: {
    label: 'Guarded',
    icon: ShieldCheck,
    className: 'text-muted-foreground',
    hint: 'Reads run freely; every change asks first.',
  },
  unrestricted: {
    label: 'Unrestricted',
    icon: ShieldOff,
    className: 'text-warning',
    hint: 'Your statements run without prompts. Generated SQL still asks.',
  },
  yolo: {
    label: 'YOLO',
    icon: Flame,
    className: 'text-destructive',
    hint: 'No prompts, no refusals. The AI runs its own SQL the moment it writes it.',
  },
};

interface StatusBarProps {
  conn: OpenConnection;
  tableCount?: number;
}

function engineLabel(conn: OpenConnection): string {
  const version = conn.info.serverVersion.split(' ')[0];
  const name = conn.dialect === 'postgres' ? 'PostgreSQL' : 'SQLite';
  return version ? `${name} ${version}` : name;
}

const StatusBar = ({ conn, tableCount = 0 }: StatusBarProps) => {
  const { connection, policy, setPolicy } = useSafetyPolicy();
  const { directWrites } = useDirectWrites(connection);
  const policyUi = POLICY_UI[policy];
  const PolicyIcon = policyUi.icon;
  const [confirmingYolo, setConfirmingYolo] = useState(false);
  const [confirmingProduction, setConfirmingProduction] = useState<SafetyPolicy | null>(null);
  const tunneled = conn.detail.includes(' via ');

  /**
   * YOLO is confirmed once per connection before it takes effect, and taking
   * a production connection out of read-only is confirmed every time: both
   * remove safeguards that sit one mis-click away in a dropdown.
   */
  const choosePolicy = (next: SafetyPolicy) => {
    if (next === policy) return;
    if (conn.production && policy === 'read-only' && next !== 'read-only') {
      setConfirmingProduction(next);
      return;
    }
    if (next === 'yolo' && connection && !hasAcknowledgedYolo(connection.id)) {
      setConfirmingYolo(true);
      return;
    }
    setPolicy(next);
  };

  const confirmYolo = () => {
    if (connection) acknowledgeYolo(connection.id);
    setConfirmingYolo(false);
    setPolicy('yolo');
  };

  return (
    <div data-mascot-home className="relative z-40 h-6 bg-card border-t border-border flex items-center justify-between px-3 text-xs select-none shrink-0">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-center gap-1.5">
          <div className="w-2 h-2 rounded-full bg-emerald-500" />
          <span className="text-muted-foreground">Connected</span>
        </div>
        <div className="h-3 w-px bg-border" />
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground" title={conn.detail}>
          {conn.dialect === 'postgres' ? <Server className="w-3 h-3 shrink-0" /> : <HardDrive className="w-3 h-3 shrink-0" />}
          <span className="max-w-[220px] truncate">{conn.name}</span>
          <span className="hidden md:inline text-muted-foreground/70">{engineLabel(conn)}</span>
        </div>
        {tunneled && (
          <span className="flex items-center gap-1 text-muted-foreground" title="Connected through an SSH tunnel">
            <KeyRound className="h-3 w-3" /> SSH
          </span>
        )}
        {tableCount > 0 && (
          <>
            <div className="h-3 w-px bg-border" />
            <span className="text-muted-foreground">{tableCount} tables</span>
          </>
        )}
        {conn.production && (
          <span className="flex items-center gap-1 font-medium text-destructive">
            <ShieldAlert className="h-3 w-3" /> Production
          </span>
        )}
        {conn.inTransaction && (
          <span className="flex items-center gap-1 text-warning" title="The SQL editor has a transaction open on this connection">
            <GitBranch className="h-3 w-3" /> Transaction open
          </span>
        )}
      </div>

      <div className="flex items-center gap-4">
        {connection && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={policyUi.hint}
                className="flex items-center gap-1.5 hover:text-foreground text-muted-foreground transition-colors"
              >
                <PolicyIcon className={`w-3 h-3 ${policyUi.className}`} />
                <span>{policyUi.label}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              {(Object.keys(POLICY_UI) as SafetyPolicy[]).map((option) => {
                const ui = POLICY_UI[option];
                const OptionIcon = ui.icon;
                return (
                  <DropdownMenuItem
                    key={option}
                    onClick={() => choosePolicy(option)}
                    className={cn('flex items-start gap-2.5 px-2.5 py-2', option === policy && 'bg-accent')}
                  >
                    <OptionIcon strokeWidth={1.5} className={`w-4 h-4 mt-px shrink-0 ${ui.className}`} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-sm">{ui.label}</span>
                      <span className="text-xs text-muted-foreground leading-snug">{ui.hint}</span>
                    </div>
                    {option === policy && <Check className="w-4 h-4 mt-px shrink-0 text-foreground" aria-label="Current" />}
                  </DropdownMenuItem>
                );
              })}
              <div className="px-2.5 py-2 text-xs text-muted-foreground border-t mt-1">
                Remembered for <span className="font-mono text-foreground/80">{connection.label}</span>
                {conn.production && <span className="block mt-1">Tagged production: starts read-only.</span>}
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <AlertDialog open={confirmingProduction !== null} onOpenChange={(open) => !open && setConfirmingProduction(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-destructive" />
                Allow changes to production?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {conn.name} is tagged production, so it opens read-only for you and for any agent following the app. Switching to{' '}
                {confirmingProduction ? POLICY_UI[confirmingProduction].label : ''} lets statements change it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Stay read-only</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const next = confirmingProduction;
                  setConfirmingProduction(null);
                  if (!next) return;
                  if (next === 'yolo' && connection && !hasAcknowledgedYolo(connection.id)) setConfirmingYolo(true);
                  else setPolicy(next);
                }}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Allow changes
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={confirmingYolo} onOpenChange={setConfirmingYolo}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <Flame className="h-4 w-4 text-destructive" />
                Turn off every safeguard?
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>
                    On <code className="font-mono">{connection?.label}</code>, YOLO mode means:
                  </p>
                  <ul className="list-disc pl-5 space-y-1">
                    <li>
                      The AI <strong>runs its own SQL immediately</strong> — you never see it before it executes.
                    </li>
                    <li>
                      No approval, no row counts. <code className="font-mono">DROP TABLE</code> and{' '}
                      <code className="font-mono">DELETE</code> without a <code className="font-mono">WHERE</code> just run.
                    </li>
                    <li>Nothing here can be undone.</li>
                  </ul>
                  <p className="text-muted-foreground">
                    The audit log still records everything, and is the only record you will have. Use it on a database you can afford to lose.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmYolo} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                Enable YOLO
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('openSettings', { detail: { tab: 'agents' } }))}
          data-mascot-mcp
          className={cn(
            'flex items-center gap-1.5 hover:text-foreground',
            directWrites ? 'text-warning' : 'text-muted-foreground',
          )}
          aria-label="Connect an agent"
          title={
            directWrites
              ? `Agents can change up to ${directWrites.maxRows.toLocaleString()} rows in one call without asking. Settings → Agents.`
              : 'Connect an agent'
          }
        >
          <Plug className="w-3 h-3" aria-hidden />
          <span>MCP</span>
          {/* A mode you have to go looking for is one you forget you are in. */}
          {directWrites && (
            <span className="font-medium">· writes up to {directWrites.maxRows.toLocaleString()} rows without asking</span>
          )}
        </button>
      </div>
    </div>
  );
};

export default StatusBar;
