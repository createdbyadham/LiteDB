import { useState } from 'react';
import { Server, HardDrive, Database, CheckCircle2, Clock, Eye, Flame, Plug, ShieldCheck, ShieldOff, AlertTriangle, RefreshCw } from 'lucide-react';
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
import { useSafetyPolicy } from '@/hooks/useSafetyPolicy';
import type { DiskAlert } from '@/lib/diskGuard';
import { acknowledgeYolo, hasAcknowledgedYolo } from '@/lib/queryGate';
import type { SafetyPolicy } from '@/lib/sqlPolicy';

/**
 * The safety mode sits in the status bar rather than in settings because it
 * changes what the next click will do. A mode you have to go looking for is
 * one you forget you are in.
 */
const POLICY_UI: Record<
  SafetyPolicy,
  { label: string; icon: typeof Eye; className: string; hint: string }
> = {
  'read-only': {
    label: 'Read-only',
    icon: Eye,
    className: 'text-sky-500',
    hint: 'Nothing can change the database.',
  },
  guarded: {
    label: 'Guarded',
    icon: ShieldCheck,
    className: 'text-emerald-500',
    hint: 'Reads run freely; every change asks first.',
  },
  unrestricted: {
    label: 'Unrestricted',
    icon: ShieldOff,
    className: 'text-amber-500',
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
  isConnected: boolean;
  connectionType: 'sqlite' | 'postgres' | null;
  databaseName?: string;
  tableCount?: number;
  lastSaved?: Date | null;
  diskAlert?: DiskAlert | null;
  onReloadFromDisk?: () => void;
}

const StatusBar = ({
  isConnected,
  connectionType,
  databaseName,
  tableCount = 0,
  lastSaved,
  diskAlert = null,
  onReloadFromDisk,
}: StatusBarProps) => {
  const { connection, policy, setPolicy } = useSafetyPolicy();
  const policyUi = POLICY_UI[policy];
  const PolicyIcon = policyUi.icon;
  const [confirmingYolo, setConfirmingYolo] = useState(false);

  /**
   * YOLO is confirmed once per connection before it takes effect.
   *
   * Not to nag — the acknowledgement is remembered, so switching away and back
   * never asks twice — but because this is the one entry in the list that
   * removes every safeguard, and it sits one mis-click away from the others in
   * a dropdown.
   */
  const choosePolicy = (next: SafetyPolicy) => {
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

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="h-6 bg-muted/30 border-t border-border flex items-center justify-between px-3 text-xs select-none shrink-0">
      {/* Left side - Connection status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          {isConnected ? (
            <>
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-muted-foreground">Connected</span>
            </>
          ) : (
            <>
              <div className="w-2 h-2 rounded-full bg-muted-foreground/50" />
              <span className="text-muted-foreground">Disconnected</span>
            </>
          )}
        </div>

        {isConnected && connectionType && (
          <>
            <div className="h-3 w-px bg-border" />
            <div className="flex items-center gap-1.5 text-muted-foreground">
              {connectionType === 'postgres' ? (
                <Server className="w-3 h-3" />
              ) : (
                <HardDrive className="w-3 h-3" />
              )}
              <span>{connectionType === 'postgres' ? 'PostgreSQL' : 'SQLite'}</span>
            </div>
          </>
        )}

        {databaseName && (
          <>
            <div className="h-3 w-px bg-border" />
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Database className="w-3 h-3" />
              <span className="max-w-[200px] truncate">{databaseName}</span>
            </div>
          </>
        )}

        {tableCount > 0 && (
          <>
            <div className="h-3 w-px bg-border" />
            <span className="text-muted-foreground">{tableCount} tables</span>
          </>
        )}
      </div>

      {/* Right side - Safety mode, last saved & time */}
      <div className="flex items-center gap-4">
        {diskAlert === 'changed' && (
          <button
            type="button"
            onClick={onReloadFromDisk}
            className="flex items-center gap-1.5 text-destructive hover:text-destructive/80"
            title="The file on disk changed. Reload discards every unsaved edit."
          >
            <AlertTriangle className="w-3 h-3" />
            <span>File changed</span>
            <RefreshCw className="w-3 h-3" />
            <span>Reload</span>
          </button>
        )}
        {diskAlert === 'in-use' && (
          <button
            type="button"
            onClick={onReloadFromDisk}
            className="flex items-center gap-1.5 text-amber-600 dark:text-amber-500 hover:text-amber-500"
            title="Another program has this database open, so saving waits until it closes. Reload shows the file as it is now and discards unsaved edits."
          >
            <AlertTriangle className="w-3 h-3" />
            <span>Database in use</span>
            <RefreshCw className="w-3 h-3" />
            <span>Reload</span>
          </button>
        )}
        {(diskAlert === 'missing' || diskAlert === 'save-failed') && (
          <span
            className="flex items-center gap-1.5 text-destructive"
            title={
              diskAlert === 'missing'
                ? 'The database file was moved or deleted. Edits are kept in memory.'
                : 'Writing the database file failed. LiteDB keeps retrying; edits are kept in memory.'
            }
          >
            <AlertTriangle className="w-3 h-3" />
            <span>{diskAlert === 'missing' ? 'File not found' : 'Not saved'}</span>
          </span>
        )}
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
                    className="flex items-start gap-2 py-2"
                  >
                    <OptionIcon className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${ui.className}`} />
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium">
                        {ui.label}
                        {option === policy && ' — current'}
                      </span>
                      <span className="text-[11px] text-muted-foreground leading-snug">
                        {ui.hint}
                      </span>
                    </div>
                  </DropdownMenuItem>
                );
              })}
              <div className="px-2 py-1.5 text-[10px] text-muted-foreground border-t mt-1">
                Applies to {connection.label} and is remembered for it.
              </div>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

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
                    On <code className="font-mono">{connection?.label}</code>, YOLO mode
                    means:
                  </p>
                  <ul className="list-disc pl-5 space-y-1">
                    <li>
                      The AI <strong>runs its own SQL immediately</strong> — you never see it
                      before it executes.
                    </li>
                    <li>
                      No approval, no row counts. <code className="font-mono">DROP TABLE</code>{' '}
                      and <code className="font-mono">DELETE</code> without a{' '}
                      <code className="font-mono">WHERE</code> just run.
                    </li>
                    <li>Nothing here can be undone.</li>
                  </ul>
                  <p className="text-muted-foreground">
                    The audit log still records everything, and is the only record you will
                    have. Use it on a database you can afford to lose.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={confirmYolo}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                Enable YOLO
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {isConnected && (
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent('openSettings', { detail: { tab: 'agents' } }))
            }
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
            aria-label="Connect an agent"
            title="Connect an agent"
          >
            <Plug className="w-3 h-3" aria-hidden />
            <span>MCP</span>
          </button>
        )}

        {lastSaved && (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <CheckCircle2 className="w-3 h-3 text-emerald-500" />
            <span>Saved at {formatTime(lastSaved)}</span>
          </div>
        )}
        
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Clock className="w-3 h-3" />
          <span>{new Date().toLocaleDateString()}</span>
        </div>
      </div>
    </div>
  );
};

export default StatusBar;
