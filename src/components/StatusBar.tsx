import { Server, HardDrive, Database, CheckCircle2, XCircle, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatusBarProps {
  isConnected: boolean;
  connectionType: 'sqlite' | 'postgres' | null;
  databaseName?: string;
  tableCount?: number;
  lastSaved?: Date | null;
}

const StatusBar = ({ 
  isConnected, 
  connectionType, 
  databaseName,
  tableCount = 0,
  lastSaved 
}: StatusBarProps) => {
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

      {/* Right side - Last saved & time */}
      <div className="flex items-center gap-4">
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
