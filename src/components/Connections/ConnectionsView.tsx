import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Database, FilePlus2, FolderOpen, HardDrive, Loader2, MoreHorizontal, Plus, Search, Server, ShieldAlert, Upload } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import icon from '/titlebaricon2.png';
import { tauriService } from '@/lib/tauri';
import { pgSslHint } from '@/lib/pgSslHint';
import { formatPostgresUrl, looksLikePostgresUrl } from '@/lib/db/pgUrl';
import { inTauri, type PgConnectConfig } from '@/lib/db/native';
import { openPostgres, openSqliteFile, useConnections } from '@/lib/db/connections';
import {
  colorSwatch,
  deleteConnection,
  describeSaved,
  listSavedConnections,
  loadPassword,
  loadSshSecret,
  onSavedConnectionsChanged,
  saveConnection,
  type SavedConnection,
} from '@/lib/db/savedConnections';
import { takePendingCommand, useAppCommand } from '@/lib/commands';
import { ConnectionDialog } from './ConnectionDialog';

function relativeTime(iso: string | null): string {
  if (!iso) return 'never opened';
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

interface PasswordPrompt {
  entry: SavedConnection;
  needsPassword: boolean;
  needsSsh: boolean;
}

const ConnectionsView = () => {
  const navigate = useNavigate();
  const { connections: open } = useConnections();
  const [saved, setSaved] = useState<SavedConnection[]>(() => listSavedConnections());
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<{ initial: SavedConnection | null; url: string | null } | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SavedConnection | null>(null);
  const [prompt, setPrompt] = useState<PasswordPrompt | null>(null);

  useEffect(() => onSavedConnectionsChanged(() => setSaved(listSavedConnections())), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return saved;
    return saved.filter((c) => `${c.name} ${describeSaved(c)}`.toLowerCase().includes(q));
  }, [saved, query]);

  const openFile = useCallback(
    async (path: string, create = false) => {
      setConnecting(path);
      try {
        await openSqliteFile(path, { create });
        navigate('/database');
      } catch (error) {
        toast({
          title: create ? 'Could not create the database' : 'Could not open the file',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        });
      } finally {
        setConnecting(null);
      }
    },
    [navigate],
  );

  const connectPostgres = useCallback(
    async (entry: SavedConnection, password: string | null, sshSecret: string | null) => {
      const config: PgConnectConfig = {
        host: entry.host!,
        port: entry.port ?? 5432,
        database: entry.database!,
        username: entry.username ?? '',
        password: password ?? '',
        sslMode: entry.sslMode ?? 'disable',
        sslRootCert: entry.sslRootCert,
        ssh: entry.ssh?.host
          ? {
              host: entry.ssh.host,
              port: entry.ssh.port,
              username: entry.ssh.username,
              auth: entry.ssh.auth,
              password: entry.ssh.auth === 'password' ? (sshSecret ?? '') : undefined,
              privateKeyPath: entry.ssh.privateKeyPath,
              passphrase: entry.ssh.auth === 'key' ? (sshSecret ?? undefined) : undefined,
            }
          : null,
      };
      setConnecting(entry.id);
      try {
        const conn = await openPostgres(config, {
          profileId: entry.id,
          name: entry.name,
          color: entry.color,
          production: entry.production,
        });
        for (const notice of conn.info.notices) toast({ title: conn.name, description: notice });
        navigate('/database');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const hint = pgSslHint(message, (entry.sslMode ?? 'disable') !== 'disable');
        toast({
          title: `Could not connect to ${entry.name}`,
          description: hint ? `${hint} (${message})` : message,
          variant: 'destructive',
        });
      } finally {
        setConnecting(null);
      }
    },
    [navigate],
  );

  const connectSaved = useCallback(
    async (entry: SavedConnection) => {
      if (open.some((c) => c.profileId === entry.id)) {
        const conn = open.find((c) => c.profileId === entry.id)!;
        const { activateConnection } = await import('@/lib/db/connections');
        activateConnection(conn.id);
        navigate('/database');
        return;
      }
      if (entry.kind === 'sqlite') {
        if (entry.path) await openFile(entry.path);
        return;
      }
      const password = entry.hasPassword ? await loadPassword(entry.id) : null;
      const sshNeedsSecret = !!entry.ssh?.host && entry.ssh.auth === 'password';
      const sshSecret = entry.ssh?.host && entry.ssh.auth !== 'agent' && entry.hasSshSecret ? await loadSshSecret(entry.id) : null;
      const needsPassword = !entry.hasPassword || password === null;
      const needsSsh = sshNeedsSecret && sshSecret === null;
      if (needsPassword || needsSsh) {
        setPrompt({ entry, needsPassword, needsSsh });
        return;
      }
      await connectPostgres(entry, password, sshSecret);
    },
    [open, openFile, connectPostgres, navigate],
  );

  // A command sent from the palette before this view was on screen.
  useEffect(() => {
    const pending = takePendingCommand();
    if (!pending) return;
    if (pending.type === 'newPostgres') setDialog({ initial: null, url: null });
    if (pending.type === 'connectSaved') {
      const entry = listSavedConnections().find((c) => c.id === pending.id);
      if (entry) void connectSaved(entry);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useAppCommand((command) => {
    if (command.type === 'newPostgres') setDialog({ initial: null, url: null });
    if (command.type === 'connectSaved') {
      const entry = saved.find((c) => c.id === command.id);
      if (entry) void connectSaved(entry);
    }
  });

  // Drop a SQLite file anywhere on the screen.
  useEffect(() => {
    if (!inTauri()) return;
    let active = true;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      const add = async (event: string, handler: (payload: unknown) => void) => {
        const unlisten = await listen(event, (e) => handler(e.payload));
        if (active) unlisteners.push(unlisten);
        else unlisten();
      };
      await add('tauri://drag-enter', () => setIsDragging(true));
      await add('tauri://drag-over', () => setIsDragging(true));
      await add('tauri://drag-leave', () => setIsDragging(false));
      await add('tauri://drag-drop', (payload) => {
        setIsDragging(false);
        const paths = Array.isArray(payload) ? payload : ((payload as { paths?: string[] })?.paths ?? []);
        if (paths.length > 0) void openFile(String(paths[0]));
      });
    })();
    return () => {
      active = false;
      unlisteners.forEach((u) => u());
    };
  }, [openFile]);

  // Paste a postgres:// URL anywhere (outside a text field) to start a connection.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      const text = event.clipboardData?.getData('text') ?? '';
      if (looksLikePostgresUrl(text)) {
        event.preventDefault();
        setDialog({ initial: null, url: text });
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const browse = async () => {
    const path = await tauriService.openSqliteDialog();
    if (path) await openFile(path);
  };

  const createDatabase = async () => {
    const path = await tauriService.newSqliteDialog();
    if (path) await openFile(path, true);
  };

  const duplicate = async (entry: SavedConnection) => {
    const { id: _id, createdAt: _c, lastUsedAt: _l, hasPassword: _p, hasSshSecret: _s, ...rest } = entry;
    await saveConnection({ ...rest, name: `${entry.name} copy` });
  };

  const copyUrl = async (entry: SavedConnection) => {
    if (entry.kind !== 'postgres') return;
    const url = formatPostgresUrl({
      host: entry.host!,
      port: entry.port ?? 5432,
      database: entry.database!,
      username: entry.username ?? '',
      sslMode: entry.sslMode,
    });
    await navigator.clipboard.writeText(url);
    toast({ title: 'Copied', description: 'Connection URL copied, without the password.' });
  };

  const empty = saved.length === 0;

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background">
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 m-3 flex items-center justify-center rounded-2xl border-2 border-dashed border-key/70 bg-key/5">
          <div className="flex items-center gap-2 text-sm font-medium text-key">
            <Upload className="h-4 w-4" /> Drop to open the SQLite file
          </div>
        </div>
      )}
      <div className="mx-auto w-full max-w-3xl px-6 py-10 animate-fade-in">
        <div className="flex items-center gap-3 mb-8">
          <img src={icon} alt="" className="w-9 h-9" />
          <div className="flex-1">
            <h1 className="text-lg font-semibold">Connections</h1>
            <p className="text-sm text-muted-foreground">
              Open a SQLite file, or connect to PostgreSQL. Your data stays on this machine.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
          <button
            type="button"
            onClick={browse}
            className="group flex items-center gap-3 rounded-xl border p-4 text-left hover:bg-muted/50 transition-colors"
          >
            <span className="rounded-lg bg-secondary p-2"><FolderOpen className="h-4 w-4" /></span>
            <span>
              <span className="block text-sm font-medium">Open SQLite file</span>
              <span className="block text-xs text-muted-foreground">or drop one anywhere</span>
            </span>
          </button>
          <button
            type="button"
            onClick={createDatabase}
            className="group flex items-center gap-3 rounded-xl border p-4 text-left hover:bg-muted/50 transition-colors"
          >
            <span className="rounded-lg bg-secondary p-2"><FilePlus2 className="h-4 w-4" /></span>
            <span>
              <span className="block text-sm font-medium">New SQLite database</span>
              <span className="block text-xs text-muted-foreground">an empty file</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setDialog({ initial: null, url: null })}
            className="group flex items-center gap-3 rounded-xl border p-4 text-left hover:bg-muted/50 transition-colors"
          >
            <span className="rounded-lg bg-secondary p-2"><Server className="h-4 w-4" /></span>
            <span>
              <span className="block text-sm font-medium">Connect to Postgres</span>
              <span className="block text-xs text-muted-foreground">or paste a postgres:// URL</span>
            </span>
          </button>
        </div>

        {empty ? (
          <div className="rounded-xl border border-dashed p-10 text-center">
            <Database strokeWidth={1.5} className="mx-auto h-8 w-8 text-muted-foreground/60" />
            <p className="mt-3 text-sm font-medium">No saved connections yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Files you open and connections you save appear here, ready to reopen in one click.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-medium text-muted-foreground">Saved</h2>
              {saved.length > 5 && (
                <div className="relative w-56">
                  <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter connections" className="h-8 pl-8 text-xs" />
                </div>
              )}
            </div>
            <ul className="divide-y rounded-xl border overflow-hidden">
              {filtered.map((entry) => {
                const swatch = colorSwatch(entry.color);
                const isOpen = open.some((c) => c.profileId === entry.id);
                const Icon = entry.kind === 'postgres' ? Server : HardDrive;
                const busy = connecting === entry.id || connecting === entry.path;
                return (
                  <li key={entry.id} className="group relative flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                    {swatch && <span className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: swatch }} aria-hidden />}
                    <button
                      type="button"
                      onClick={() => void connectSaved(entry)}
                      disabled={busy}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{entry.name}</span>
                          {entry.production && (
                            <span className="inline-flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
                              <ShieldAlert className="h-3 w-3" /> production
                            </span>
                          )}
                          {isOpen && <span className="rounded bg-positive/15 px-1.5 py-0.5 text-[10px] font-medium text-positive">open</span>}
                        </span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">{describeSaved(entry)}</span>
                      </span>
                      <span className="hidden sm:block shrink-0 text-[11px] text-muted-foreground tabular-nums">{relativeTime(entry.lastUsedAt)}</span>
                      {busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 opacity-60 group-hover:opacity-100" aria-label={`More for ${entry.name}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem onClick={() => void connectSaved(entry)}>{isOpen ? 'Switch to it' : 'Connect'}</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setDialog({ initial: entry, url: null })}>Edit…</DropdownMenuItem>
                        {entry.kind === 'postgres' && <DropdownMenuItem onClick={() => void duplicate(entry)}>Duplicate</DropdownMenuItem>}
                        {entry.kind === 'postgres' && <DropdownMenuItem onClick={() => void copyUrl(entry)}>Copy URL</DropdownMenuItem>}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setConfirmDelete(entry)}>
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </li>
                );
              })}
              {filtered.length === 0 && <li className="px-4 py-6 text-center text-xs text-muted-foreground">Nothing matches “{query}”.</li>}
            </ul>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" className="text-xs" onClick={() => setDialog({ initial: null, url: null })}>
                <Plus className="mr-1 h-3.5 w-3.5" /> New Postgres connection
              </Button>
            </div>
          </div>
        )}
      </div>

      <ConnectionDialog
        open={dialog !== null}
        onOpenChange={(next) => !next && setDialog(null)}
        initial={dialog?.initial ?? null}
        prefillUrl={dialog?.url ?? null}
        onConnected={() => navigate('/database')}
      />

      <PasswordDialog
        prompt={prompt}
        onCancel={() => setPrompt(null)}
        onSubmit={async (password, sshSecret, remember) => {
          const entry = prompt!.entry;
          setPrompt(null);
          if (remember) {
            const { id, createdAt: _c, lastUsedAt: _l, hasPassword: _p, hasSshSecret: _s, ...rest } = entry;
            await saveConnection(
              { ...rest, id },
              {
                ...(prompt!.needsPassword ? { password } : {}),
                ...(prompt!.needsSsh ? { sshSecret } : {}),
              },
            );
          }
          const storedPassword = prompt!.needsPassword ? password : await loadPassword(entry.id);
          const storedSsh = prompt!.needsSsh ? sshSecret : entry.hasSshSecret ? await loadSshSecret(entry.id) : null;
          await connectPostgres(entry, storedPassword, storedSsh);
        }}
      />

      <AlertDialog open={confirmDelete !== null} onOpenChange={(next) => !next && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {confirmDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.kind === 'sqlite'
                ? 'It leaves this list. The database file itself is not touched.'
                : 'It leaves this list, and any password saved for it is deleted from the keychain. The database is not touched.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmDelete && void deleteConnection(confirmDelete.id)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

function PasswordDialog({
  prompt,
  onCancel,
  onSubmit,
}: {
  prompt: PasswordPrompt | null;
  onCancel: () => void;
  onSubmit: (password: string, sshSecret: string, remember: boolean) => void;
}) {
  const [password, setPassword] = useState('');
  const [sshSecret, setSshSecret] = useState('');
  const [remember, setRemember] = useState(false);
  useEffect(() => {
    setPassword('');
    setSshSecret('');
    setRemember(false);
  }, [prompt]);
  return (
    <Dialog open={prompt !== null} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit(password, sshSecret, remember);
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>Connect to {prompt?.entry.name}</DialogTitle>
            <DialogDescription className="font-mono text-xs">{prompt ? describeSaved(prompt.entry) : ''}</DialogDescription>
          </DialogHeader>
          {prompt?.needsPassword && (
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-password">Password</Label>
              <Input id="prompt-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </div>
          )}
          {prompt?.needsSsh && (
            <div className="grid gap-1.5">
              <Label htmlFor="prompt-ssh">SSH password</Label>
              <Input id="prompt-ssh" type="password" value={sshSecret} onChange={(e) => setSshSecret(e.target.value)} autoFocus={!prompt.needsPassword} />
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
            Remember in the OS keychain
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" className={cn()}>Connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default ConnectionsView;
