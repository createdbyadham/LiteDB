import { Minus, X, Copy, Plus, HardDrive, Server, Search, ShieldAlert } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Button } from './ui/button';
import { SettingsDialog } from "./ui/settings-dialog";
import { ThemeToggle } from './ThemeToggle';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { activateConnection, closeConnection, useConnections } from '@/lib/db/connections';
import { colorSwatch } from '@/lib/db/savedConnections';
import { inTauri } from '@/lib/db/native';
import { openCommandPalette } from '@/lib/commands';
import { cn } from '@/lib/utils';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const TitleBar = () => {
  const { connections, activeId } = useConnections();
  const location = useLocation();
  const navigate = useNavigate();
  const onDatabase = location.pathname === '/database';
  const active = connections.find((c) => c.id === activeId);
  // The whole bar turns red while a production database is on screen: a
  // reminder that cannot scroll out of view.
  const production = onDatabase && active?.production;

  const windowAction = (action: 'minimize' | 'toggleMaximize' | 'close') => {
    if (!inTauri()) return;
    const win = getCurrentWindow();
    void (action === 'minimize' ? win.minimize() : action === 'toggleMaximize' ? win.toggleMaximize() : win.close());
  };

  const openTab = (id: string) => {
    activateConnection(id);
    if (!onDatabase) navigate('/database');
  };

  const closeTab = async (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    const last = connections.length === 1;
    await closeConnection(id);
    if (last) navigate('/', { replace: true });
  };

  return (
    <div
      className={cn(
        'h-9 flex items-center justify-between border-b select-none shrink-0 z-50',
        production
          ? 'bg-destructive text-destructive-foreground border-destructive'
          : 'bg-sidebar text-foreground border-border',
      )}
    >
      <div className="flex items-center h-full min-w-0">
        <div className="flex items-end h-full min-w-0 overflow-x-auto no-scrollbar pl-1.5 gap-px">
          {connections.map((conn) => {
            const selected = onDatabase && conn.id === activeId;
            const swatch = colorSwatch(conn.color);
            const Icon = conn.dialect === 'postgres' ? Server : HardDrive;
            return (
              <button
                key={conn.id}
                type="button"
                onClick={() => openTab(conn.id)}
                onAuxClick={(e) => e.button === 1 && void closeTab(e, conn.id)}
                title={`${conn.name}\n${conn.detail}${conn.production ? '\nProduction' : ''}`}
                className={cn(
                  'group relative flex items-center gap-1.5 h-7 max-w-[220px] pl-2.5 pr-1 rounded-t-md text-xs transition-colors',
                  selected
                    ? production
                      ? 'bg-background/15'
                      : 'bg-background text-foreground'
                    : production
                      ? 'opacity-80 hover:bg-background/10'
                      : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                )}
              >
                {swatch ? (
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: swatch }} aria-hidden />
                ) : (
                  <Icon className="h-3 w-3 shrink-0" aria-hidden />
                )}
                <span className="truncate">{conn.name}</span>
                {conn.production && !production && (
                  <ShieldAlert className="h-3 w-3 shrink-0 text-destructive" aria-label="Production" />
                )}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Close ${conn.name}`}
                  onClick={(e) => void closeTab(e, conn.id)}
                  className="ml-0.5 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-foreground/10"
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            );
          })}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/')}
          className="h-7 w-7 ml-0.5 p-0 shrink-0 text-current opacity-70 hover:opacity-100 hover:bg-foreground/10"
          title="Open another database"
          aria-label="Open another database"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        {production && (
          <span className="ml-2 shrink-0 text-[11px] font-semibold tracking-wide">
            Production
            <span className="ml-1.5 font-normal opacity-80">read-only unless you change it</span>
          </span>
        )}
      </div>

      {/* Draggable area */}
      <div className="flex-1 app-drag-handle h-full" data-tauri-drag-region />

      <div className="flex items-center h-full">
        <button
          type="button"
          onClick={openCommandPalette}
          className="mr-1 hidden sm:flex items-center gap-2 h-6 rounded-md border border-current/15 px-2 text-[11px] opacity-70 hover:opacity-100"
          title="Command palette"
        >
          <Search className="h-3 w-3" />
          <span>Search</span>
          <kbd className="font-sans opacity-70">{isMac ? '⌘P' : 'Ctrl P'}</kbd>
        </button>
        <ThemeToggle />
        <SettingsDialog />
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-11 rounded-none text-current opacity-70 hover:opacity-100 hover:bg-foreground/10"
          onClick={() => windowAction('minimize')}
          aria-label="Minimize"
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-11 rounded-none text-current opacity-70 hover:opacity-100 hover:bg-foreground/10"
          onClick={() => windowAction('toggleMaximize')}
          aria-label="Maximize"
        >
          <Copy className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-9 w-11 rounded-none text-current opacity-70 hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => windowAction('close')}
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
};

export default TitleBar;
