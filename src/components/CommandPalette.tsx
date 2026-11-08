// Ctrl/Cmd+P: jump to any table, switch connection, or do anything the
// toolbar can, without the mouse.

import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTheme } from 'next-themes';
import {
  Box,
  Download,
  Eye,
  FilePlus2,
  FolderOpen,
  GitBranch,
  HardDrive,
  ListPlus,
  MessageSquareCode,
  Monitor,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  ShieldOff,
  Sun,
  Table2,
  TableOfContents,
  Terminal,
  Upload,
  X,
} from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command';
import { toast } from '@/hooks/use-toast';
import { emitAppCommand, setPendingCommand, shortcutLabel, type AppCommand } from '@/lib/commands';
import { activateConnection, closeConnection, openSqliteFile, useConnections, visibleTables } from '@/lib/db/connections';
import { colorSwatch, describeSaved, listSavedConnections } from '@/lib/db/savedConnections';
import { tauriService } from '@/lib/tauri';
import { useSafetyPolicy } from '@/hooks/useSafetyPolicy';
import type { SafetyPolicy } from '@/lib/sqlPolicy';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { setTheme } = useTheme();
  const { connections, activeId } = useConnections();
  const { policy, setPolicy } = useSafetyPolicy();
  const active = connections.find((c) => c.id === activeId) ?? null;
  const onDatabase = location.pathname === '/database' && !!active;
  const saved = useMemo(() => (open ? listSavedConnections() : []), [open]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('openCommandPalette', onOpen);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('openCommandPalette', onOpen);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  const run = (action: () => void) => {
    setOpen(false);
    // Let the dialog close first, so focus lands where the action puts it.
    setTimeout(action, 0);
  };

  /** A command for the database view, opening it first if needed. */
  const inDatabase = (command: AppCommand) =>
    run(() => {
      if (location.pathname !== '/database') {
        navigate('/database');
        setTimeout(() => emitAppCommand(command), 80);
      } else {
        emitAppCommand(command);
      }
    });

  const connectSaved = (id: string) =>
    run(() => {
      const existing = connections.find((c) => c.profileId === id);
      if (existing) {
        activateConnection(existing.id);
        navigate('/database');
        return;
      }
      if (location.pathname === '/') emitAppCommand({ type: 'connectSaved', id });
      else {
        setPendingCommand({ type: 'connectSaved', id });
        navigate('/');
      }
    });

  const choosePolicy = (next: SafetyPolicy) =>
    run(() => {
      if (active?.production && policy === 'read-only' && next !== 'read-only') {
        toast({ title: 'Production connection', description: 'Allow changes from the safety menu in the status bar, where it asks you to confirm.' });
        return;
      }
      setPolicy(next);
    });

  const openFile = (create: boolean) =>
    run(async () => {
      const path = create ? await tauriService.newSqliteDialog() : await tauriService.openSqliteDialog();
      if (!path) return;
      try {
        await openSqliteFile(path, { create });
        navigate('/database');
      } catch (error) {
        toast({ title: 'Could not open the file', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
      }
    });

  const tables = active ? visibleTables(active) : [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl top-[22%] translate-y-0">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command loop>
          <CommandInput placeholder={onDatabase ? `Search tables and commands in ${active?.name}…` : 'Search commands and connections…'} />
          <CommandList>
            <CommandEmpty>Nothing matches.</CommandEmpty>

            {onDatabase && tables.length > 0 && (
              <CommandGroup heading="Tables">
                {tables.map((t) => (
                  <CommandItem key={t.name} value={`table ${t.name}`} onSelect={() => inDatabase({ type: 'openTable', table: t.name })}>
                    {t.type === 'view' ? <Eye /> : <TableOfContents />}
                    <span className="truncate">{t.name}</span>
                    {t.type === 'view' && <CommandShortcut>view</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {active && (
              <CommandGroup heading="Go to">
                <CommandItem value="go table editor" onSelect={() => inDatabase({ type: 'switchTab', tab: 'browse' })}>
                  <Table2 /> Table editor
                </CommandItem>
                <CommandItem value="go schema diagram" onSelect={() => inDatabase({ type: 'switchTab', tab: 'schema' })}>
                  <GitBranch /> Schema diagram
                </CommandItem>
                <CommandItem value="go sql editor" onSelect={() => inDatabase({ type: 'switchTab', tab: 'query' })}>
                  <Terminal /> SQL editor
                </CommandItem>
                {active.hasPgVector && (
                  <CommandItem value="go vector search" onSelect={() => inDatabase({ type: 'switchTab', tab: 'vectors' })}>
                    <Box /> Vector search
                  </CommandItem>
                )}
              </CommandGroup>
            )}

            {active && (
              <CommandGroup heading="Actions">
                <CommandItem value="new query tab" onSelect={() => inDatabase({ type: 'newQueryTab' })}>
                  <ListPlus /> New query tab
                </CommandItem>
                <CommandItem value="run query statement" onSelect={() => inDatabase({ type: 'runQuery' })}>
                  <Play /> Run the statement under the cursor
                  <CommandShortcut>{shortcutLabel('Mod+Enter')}</CommandShortcut>
                </CommandItem>
                <CommandItem value="text to sql ask ai" onSelect={() => inDatabase({ type: 'aiGenerate' })}>
                  <MessageSquareCode /> Text to SQL
                  <CommandShortcut>{shortcutLabel('Mod+K')}</CommandShortcut>
                </CommandItem>
                <CommandItem value="insert row" onSelect={() => inDatabase({ type: 'insertRow' })}>
                  <Plus /> Insert a row
                </CommandItem>
                <CommandItem value="import csv" onSelect={() => inDatabase({ type: 'importCsv' })}>
                  <Upload /> Import CSV…
                </CommandItem>
                <CommandItem value="export data" onSelect={() => inDatabase({ type: 'export' })}>
                  <Download /> Export…
                </CommandItem>
                <CommandItem value="refresh reload" onSelect={() => inDatabase({ type: 'refresh' })}>
                  <RefreshCw /> Refresh
                </CommandItem>
              </CommandGroup>
            )}

            <CommandGroup heading="Connections">
              {connections
                .filter((c) => c.id !== activeId || !onDatabase)
                .map((c) => (
                  <CommandItem key={c.id} value={`switch ${c.name} ${c.detail}`} onSelect={() => run(() => {
                    activateConnection(c.id);
                    navigate('/database');
                  })}>
                    {colorSwatch(c.color) ? <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorSwatch(c.color)! }} /> : c.dialect === 'postgres' ? <Server /> : <HardDrive />}
                    <span className="truncate">Switch to {c.name}</span>
                    <CommandShortcut>open</CommandShortcut>
                  </CommandItem>
                ))}
              {saved
                .filter((s) => !connections.some((c) => c.profileId === s.id))
                .map((s) => (
                  <CommandItem key={s.id} value={`connect ${s.name} ${describeSaved(s)}`} onSelect={() => connectSaved(s.id)}>
                    {colorSwatch(s.color) ? <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: colorSwatch(s.color)! }} /> : s.kind === 'postgres' ? <Server /> : <HardDrive />}
                    <span className="truncate">{s.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{describeSaved(s)}</span>
                  </CommandItem>
                ))}
              <CommandItem value="new postgres connection" onSelect={() => run(() => {
                if (location.pathname === '/') emitAppCommand({ type: 'newPostgres' });
                else {
                  setPendingCommand({ type: 'newPostgres' });
                  navigate('/');
                }
              })}>
                <Server /> New Postgres connection…
              </CommandItem>
              <CommandItem value="open sqlite file" onSelect={() => openFile(false)}>
                <FolderOpen /> Open SQLite file…
              </CommandItem>
              <CommandItem value="new sqlite database" onSelect={() => openFile(true)}>
                <FilePlus2 /> New SQLite database…
              </CommandItem>
              {active && (
                <CommandItem value={`close ${active.name}`} onSelect={() => run(async () => {
                  const last = connections.length === 1;
                  await closeConnection(active.id);
                  if (last) navigate('/');
                })}>
                  <X /> Close {active.name}
                </CommandItem>
              )}
            </CommandGroup>

            {active && (
              <CommandGroup heading="Safety mode">
                <CommandItem value="safety read-only" onSelect={() => choosePolicy('read-only')}>
                  <Eye /> Read-only {policy === 'read-only' && <CommandShortcut>current</CommandShortcut>}
                </CommandItem>
                <CommandItem value="safety guarded" onSelect={() => choosePolicy('guarded')}>
                  <ShieldCheck /> Guarded {policy === 'guarded' && <CommandShortcut>current</CommandShortcut>}
                </CommandItem>
                <CommandItem value="safety unrestricted" onSelect={() => choosePolicy('unrestricted')}>
                  <ShieldOff /> Unrestricted {policy === 'unrestricted' && <CommandShortcut>current</CommandShortcut>}
                </CommandItem>
              </CommandGroup>
            )}

            <CommandGroup heading="Appearance">
              <CommandItem value="theme light" onSelect={() => run(() => setTheme('light'))}>
                <Sun /> Light theme
              </CommandItem>
              <CommandItem value="theme dark" onSelect={() => run(() => setTheme('dark'))}>
                <Moon /> Dark theme
              </CommandItem>
              <CommandItem value="theme system" onSelect={() => run(() => setTheme('system'))}>
                <Monitor /> Match the system theme
              </CommandItem>
            </CommandGroup>

            <CommandGroup heading="App">
              <CommandItem value="settings ai provider agents" onSelect={() => run(() => window.dispatchEvent(new CustomEvent('openSettings', { detail: { tab: 'ai' } })))}>
                <Settings /> Settings
              </CommandItem>
            </CommandGroup>
          </CommandList>
          <div className="flex items-center gap-3 border-t px-3 py-2 text-[11px] text-muted-foreground">
            <span>↑↓ to move · Enter to choose · Esc to close</span>
            <span className="ml-auto">{shortcutLabel('Mod+P')} opens this anywhere</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
