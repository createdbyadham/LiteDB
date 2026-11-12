import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AlertCircle, Check, FolderOpen, Link2, Loader2, ShieldAlert } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { tauriService } from '@/lib/tauri';
import { pgSslHint, pgSupabaseDirectHint } from '@/lib/pgSslHint';
import { clearPolicyFor } from '@/lib/queryGate';
import { postgresConnectionId, sqliteConnectionId } from '@/lib/connectionId';
import { SSL_MODES, parsePostgresUrl, type SslMode } from '@/lib/db/pgUrl';
import type { PgConnectConfig } from '@/lib/db/native';
import { openPostgres, testPostgres, updateOpenConnectionMeta } from '@/lib/db/connections';
import {
  CONNECTION_COLORS,
  loadPassword,
  loadSshSecret,
  saveConnection,
  type SavedConnection,
} from '@/lib/db/savedConnections';

export interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** An existing connection to edit. Absent for a new one. */
  initial?: SavedConnection | null;
  /** Text pasted onto the home screen: filled in when it is a URL. */
  prefillUrl?: string | null;
  onConnected?: () => void;
}

interface Form {
  name: string;
  color: string | null;
  production: boolean;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  savePassword: boolean;
  sslMode: SslMode;
  sslRootCert: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshAuth: 'password' | 'key' | 'agent';
  sshPassword: string;
  sshKeyPath: string;
  sshPassphrase: string;
  saveSshSecret: boolean;
}

const EMPTY: Form = {
  name: '',
  color: null,
  production: false,
  host: 'localhost',
  port: '5432',
  database: '',
  username: 'postgres',
  password: '',
  savePassword: true,
  sslMode: 'disable',
  sslRootCert: '',
  sshEnabled: false,
  sshHost: '',
  sshPort: '22',
  sshUsername: '',
  sshAuth: 'key',
  sshPassword: '',
  sshKeyPath: '~/.ssh/id_ed25519',
  sshPassphrase: '',
  saveSshSecret: false,
};

function fromSaved(entry: SavedConnection): Form {
  return {
    ...EMPTY,
    name: entry.name,
    color: entry.color,
    production: entry.production,
    host: entry.host ?? 'localhost',
    port: String(entry.port ?? 5432),
    database: entry.database ?? '',
    username: entry.username ?? '',
    savePassword: entry.hasPassword ?? false,
    sslMode: entry.sslMode ?? 'disable',
    sslRootCert: entry.sslRootCert ?? '',
    sshEnabled: !!entry.ssh?.host,
    sshHost: entry.ssh?.host ?? '',
    sshPort: String(entry.ssh?.port ?? 22),
    sshUsername: entry.ssh?.username ?? '',
    sshAuth: entry.ssh?.auth ?? 'key',
    sshKeyPath: entry.ssh?.privateKeyPath ?? EMPTY.sshKeyPath,
    saveSshSecret: entry.hasSshSecret ?? false,
  };
}

function Field({ label, htmlFor, children, hint, className }: { label: string; htmlFor?: string; children: React.ReactNode; hint?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ColorPicker({ value, onChange }: { value: string | null; onChange: (color: string | null) => void }) {
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Color">
      <button
        type="button"
        role="radio"
        aria-checked={value === null}
        aria-label="No color"
        onClick={() => onChange(null)}
        className={cn(
          'h-5 w-5 rounded-full border border-dashed border-muted-foreground/50',
          value === null && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
        )}
      />
      {CONNECTION_COLORS.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={value === c.value}
          aria-label={c.label}
          title={c.label}
          onClick={() => onChange(c.value)}
          className={cn(
            'h-5 w-5 rounded-full flex items-center justify-center',
            value === c.value && 'ring-2 ring-ring ring-offset-2 ring-offset-background',
          )}
          style={{ backgroundColor: c.swatch }}
        >
          {value === c.value && <Check className="h-3 w-3 text-white" />}
        </button>
      ))}
    </div>
  );
}

export function ProductionToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={cn('flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors', checked && 'border-destructive/60 bg-destructive/5')}>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" aria-label="Production" />
      <div className="grid gap-0.5">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <ShieldAlert className={cn('h-3.5 w-3.5', checked ? 'text-destructive' : 'text-muted-foreground')} />
          Production
        </span>
        <span className="text-xs text-muted-foreground leading-snug">
          Opens read-only, for you and for any agent following the app, and turns the title bar red while it is on screen.
          You can still switch modes in the status bar.
        </span>
      </div>
    </label>
  );
}

export function ConnectionDialog({ open, onOpenChange, initial, prefillUrl, onConnected }: ConnectionDialogProps) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [url, setUrl] = useState('');
  const [urlNote, setUrlNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | 'connect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSqlite = initial?.kind === 'sqlite';
  const editing = !!initial;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setUrlNote(null);
    setUrl('');
    if (initial) {
      setForm(fromSaved(initial));
    } else {
      setForm(EMPTY);
      if (prefillUrl) applyUrl(prefillUrl);
    }
  }, [open, initial, prefillUrl]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  function applyUrl(text: string) {
    setUrl(text);
    const parsed = parsePostgresUrl(text);
    if (!parsed) {
      setUrlNote(text.trim() ? 'Not a postgres:// URL.' : null);
      return;
    }
    setForm((f) => ({
      ...f,
      host: parsed.host,
      port: String(parsed.port),
      database: parsed.database,
      username: parsed.username || f.username,
      // A placeholder is not a password, and must not wipe one already typed.
      password: parsed.passwordPlaceholder ? f.password : parsed.password || f.password,
      sslMode: parsed.sslMode ?? (/(neon\.tech|supabase\.co|supabase\.com|rds\.amazonaws\.com|render\.com|railway\.app|azure\.com|aivencloud\.com|digitalocean\.com)/i.test(parsed.host) ? 'require' : f.sslMode),
      sslRootCert: parsed.sslRootCert ?? f.sslRootCert,
    }));
    setUrlNote(
      parsed.passwordPlaceholder
        ? 'Filled in from the URL. Type your database password: the URL has a placeholder.'
        : `Filled in from the URL${parsed.password ? ', password included' : ''}.`,
    );
  }

  const defaultName = useMemo(
    () => (form.database && form.host ? `${form.database} on ${form.host}` : 'New connection'),
    [form.database, form.host],
  );

  const config = async (): Promise<PgConnectConfig> => {
    const port = Number(form.port);
    if (!form.host.trim()) throw new Error('Enter the host.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a port between 1 and 65535.');
    if (!form.database.trim()) throw new Error('Enter the database name.');
    if (!form.username.trim()) throw new Error('Enter the username.');
    // A saved secret is read here, at the moment of connecting, not held.
    let password = form.password;
    if (!password && initial?.hasPassword) password = (await loadPassword(initial.id)) ?? '';
    let sshSecret = form.sshAuth === 'password' ? form.sshPassword : form.sshPassphrase;
    if (form.sshEnabled && !sshSecret && initial?.hasSshSecret) sshSecret = (await loadSshSecret(initial.id)) ?? '';
    return {
      host: form.host.trim(),
      port,
      database: form.database.trim(),
      username: form.username.trim(),
      password,
      sslMode: form.sslMode,
      sslRootCert: form.sslRootCert.trim() || undefined,
      ssh: form.sshEnabled
        ? {
            host: form.sshHost.trim(),
            port: Number(form.sshPort) || 22,
            username: form.sshUsername.trim(),
            auth: form.sshAuth,
            password: form.sshAuth === 'password' ? sshSecret : undefined,
            privateKeyPath: form.sshAuth === 'key' ? form.sshKeyPath.trim() : undefined,
            passphrase: form.sshAuth === 'key' ? sshSecret : undefined,
          }
        : null,
    };
  };

  const describeError = (e: unknown): string => {
    const message = e instanceof Error ? e.message : String(e);
    const hint = pgSslHint(message, form.sslMode !== 'disable') ?? pgSupabaseDirectHint(form.host, message);
    return hint ? `${hint}\n\n${message}` : message;
  };

  const persist = async (): Promise<SavedConnection> => {
    if (isSqlite && initial) {
      const saved = await saveConnection({
        id: initial.id,
        kind: 'sqlite',
        path: initial.path,
        name: form.name.trim() || initial.name,
        color: form.color,
        production: form.production,
      });
      if (form.production && !initial.production && initial.path) clearPolicyFor(sqliteConnectionId(initial.path));
      updateOpenConnectionMeta(saved.id, { name: saved.name, color: saved.color, production: saved.production });
      return saved;
    }
    const port = Number(form.port) || 5432;
    const sshSecret = form.sshAuth === 'password' ? form.sshPassword : form.sshPassphrase;
    const saved = await saveConnection(
      {
        id: initial?.id,
        kind: 'postgres',
        name: form.name.trim() || defaultName,
        color: form.color,
        production: form.production,
        host: form.host.trim(),
        port,
        database: form.database.trim(),
        username: form.username.trim(),
        sslMode: form.sslMode,
        sslRootCert: form.sslRootCert.trim() || undefined,
        ssh: form.sshEnabled
          ? {
              host: form.sshHost.trim(),
              port: Number(form.sshPort) || 22,
              username: form.sshUsername.trim(),
              auth: form.sshAuth,
              privateKeyPath: form.sshAuth === 'key' ? form.sshKeyPath.trim() : undefined,
            }
          : null,
      },
      {
        // Typed now: store or forget as the box says. Left blank: keep what is stored,
        // unless the box was unticked.
        password: form.savePassword ? (form.password ? form.password : undefined) : null,
        sshSecret: form.sshEnabled && form.saveSshSecret && form.sshAuth !== 'agent' ? (sshSecret ? sshSecret : undefined) : null,
      },
    );
    // Turning the tag on should mean read-only now, not whatever was chosen before.
    if (form.production && !initial?.production) clearPolicyFor(postgresConnectionId(saved.host!, saved.port!, saved.database!, saved.username ?? ''));
    updateOpenConnectionMeta(saved.id, { name: saved.name, color: saved.color, production: saved.production });
    return saved;
  };

  const handleTest = async () => {
    setBusy('test');
    setError(null);
    try {
      const info = await testPostgres(await config());
      const version = info.serverVersion ? `PostgreSQL ${info.serverVersion.split(' ')[0]}` : 'PostgreSQL';
      toast({
        title: 'Connection works',
        description: [version, ...info.notices].join(' · '),
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    setBusy('save');
    setError(null);
    try {
      await persist();
      onOpenChange(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const handleConnect = async () => {
    setBusy('connect');
    setError(null);
    try {
      const cfg = await config();
      const saved = await persist();
      const conn = await openPostgres(cfg, {
        profileId: saved.id,
        name: saved.name,
        color: saved.color,
        production: saved.production,
      });
      for (const notice of conn.info.notices) toast({ title: conn.name, description: notice });
      onOpenChange(false);
      onConnected?.();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const verifying = form.sslMode === 'verify-ca' || form.sslMode === 'verify-full';

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-[560px] max-h-[88vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle>
            {isSqlite ? 'Edit connection' : editing ? `Edit ${initial?.name}` : 'New Postgres connection'}
          </DialogTitle>
          <DialogDescription>
            {isSqlite
              ? initial?.path
              : 'Paste a connection URL, or fill in the fields. Passwords go to your OS keychain, never to a file.'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 space-y-5">
          {!isSqlite && (
            <Field
              label="Connection URL"
              htmlFor="pg-url"
              hint={urlNote ?? 'What Neon, Supabase, Railway and most hosts give you.'}
            >
              <div className="relative">
                <Link2 className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="pg-url"
                  value={url}
                  onChange={(e) => applyUrl(e.target.value)}
                  placeholder="postgresql://user:password@host:5432/database"
                  className="pl-8 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            </Field>
          )}

          <div className="grid grid-cols-[1fr_auto] gap-4 items-end">
            <Field label="Name" htmlFor="conn-name">
              <Input
                id="conn-name"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder={isSqlite ? initial?.name : defaultName}
              />
            </Field>
            <Field label="Color">
              <div className="h-9 flex items-center">
                <ColorPicker value={form.color} onChange={(c) => set('color', c)} />
              </div>
            </Field>
          </div>

          <ProductionToggle checked={form.production} onChange={(v) => set('production', v)} />

          {!isSqlite && (
            <>
              <div className="grid grid-cols-[1fr_96px] gap-3">
                <Field label="Host" htmlFor="pg-host">
                  <Input id="pg-host" value={form.host} onChange={(e) => set('host', e.target.value)} spellCheck={false} />
                </Field>
                <Field label="Port" htmlFor="pg-port">
                  <Input id="pg-port" value={form.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
                </Field>
              </div>
              <Field label="Database" htmlFor="pg-db">
                <Input id="pg-db" value={form.database} onChange={(e) => set('database', e.target.value)} spellCheck={false} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Username" htmlFor="pg-user">
                  <Input id="pg-user" value={form.username} onChange={(e) => set('username', e.target.value)} spellCheck={false} autoComplete="off" />
                </Field>
                <Field label="Password" htmlFor="pg-pass">
                  <Input
                    id="pg-pass"
                    type="password"
                    value={form.password}
                    onChange={(e) => set('password', e.target.value)}
                    placeholder={initial?.hasPassword ? 'Saved in keychain' : ''}
                    autoComplete="new-password"
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <Checkbox checked={form.savePassword} onCheckedChange={(v) => set('savePassword', v === true)} />
                Remember the password in the OS keychain
              </label>

              <div className="grid grid-cols-[180px_1fr] gap-3 items-start">
                <Field label="SSL">
                  <Select value={form.sslMode} onValueChange={(v) => set('sslMode', v as SslMode)}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SSL_MODES.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <p className="pt-6 text-[11px] leading-snug text-muted-foreground">
                  {SSL_MODES.find((m) => m.value === form.sslMode)?.hint}
                </p>
              </div>
              {verifying && (
                <Field label="CA certificate" hint="The PEM file your provider publishes. Leave blank to trust the system's CAs.">
                  <div className="flex gap-2">
                    <Input value={form.sslRootCert} onChange={(e) => set('sslRootCert', e.target.value)} placeholder="/path/to/ca.pem" className="font-mono text-xs" spellCheck={false} />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9"
                      onClick={async () => {
                        const path = await tauriService.pickFile('CA certificate', ['pem', 'crt', 'cer']);
                        if (path) set('sslRootCert', path);
                      }}
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </Field>
              )}

              <div className="rounded-lg border">
                <label className="flex items-center justify-between gap-3 p-3 cursor-pointer">
                  <div>
                    <div className="text-sm font-medium">Connect through SSH</div>
                    <div className="text-xs text-muted-foreground">For databases behind a bastion. Host and port above are as the bastion sees them.</div>
                  </div>
                  <Switch checked={form.sshEnabled} onCheckedChange={(v) => set('sshEnabled', v)} />
                </label>
                {form.sshEnabled && (
                  <div className="border-t p-3 space-y-3">
                    <div className="grid grid-cols-[1fr_80px] gap-3">
                      <Field label="SSH host" htmlFor="ssh-host">
                        <Input id="ssh-host" value={form.sshHost} onChange={(e) => set('sshHost', e.target.value)} placeholder="bastion.example.com" spellCheck={false} />
                      </Field>
                      <Field label="Port" htmlFor="ssh-port">
                        <Input id="ssh-port" value={form.sshPort} onChange={(e) => set('sshPort', e.target.value.replace(/\D/g, ''))} inputMode="numeric" />
                      </Field>
                    </div>
                    <Field label="SSH user" htmlFor="ssh-user">
                      <Input id="ssh-user" value={form.sshUsername} onChange={(e) => set('sshUsername', e.target.value)} spellCheck={false} autoComplete="off" />
                    </Field>
                    <div className="flex gap-1 rounded-md bg-muted p-1 text-xs" role="radiogroup" aria-label="SSH authentication">
                      {(['key', 'password', 'agent'] as const).map((method) => (
                        <button
                          key={method}
                          type="button"
                          role="radio"
                          aria-checked={form.sshAuth === method}
                          onClick={() => set('sshAuth', method)}
                          className={cn(
                            'flex-1 rounded px-2 py-1 transition-colors',
                            form.sshAuth === method ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {method === 'key' ? 'Private key' : method === 'password' ? 'Password' : 'SSH agent'}
                        </button>
                      ))}
                    </div>
                    {form.sshAuth === 'key' && (
                      <>
                        <Field label="Private key file">
                          <div className="flex gap-2">
                            <Input value={form.sshKeyPath} onChange={(e) => set('sshKeyPath', e.target.value)} className="font-mono text-xs" spellCheck={false} />
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-9"
                              onClick={async () => {
                                const path = await tauriService.pickFile('SSH private key');
                                if (path) set('sshKeyPath', path);
                              }}
                            >
                              <FolderOpen className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </Field>
                        <Field label="Passphrase" htmlFor="ssh-passphrase">
                          <Input
                            id="ssh-passphrase"
                            type="password"
                            value={form.sshPassphrase}
                            onChange={(e) => set('sshPassphrase', e.target.value)}
                            placeholder={initial?.hasSshSecret ? 'Saved in keychain' : 'Leave blank if the key has none'}
                            autoComplete="new-password"
                          />
                        </Field>
                      </>
                    )}
                    {form.sshAuth === 'password' && (
                      <Field label="SSH password" htmlFor="ssh-password">
                        <Input
                          id="ssh-password"
                          type="password"
                          value={form.sshPassword}
                          onChange={(e) => set('sshPassword', e.target.value)}
                          placeholder={initial?.hasSshSecret ? 'Saved in keychain' : ''}
                          autoComplete="new-password"
                        />
                      </Field>
                    )}
                    {form.sshAuth === 'agent' && (
                      <p className="text-xs text-muted-foreground">
                        Uses the keys loaded in your SSH agent (the OpenSSH agent service or Pageant on Windows, SSH_AUTH_SOCK elsewhere).
                      </p>
                    )}
                    {form.sshAuth !== 'agent' && (
                      <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                        <Checkbox checked={form.saveSshSecret} onCheckedChange={(v) => set('saveSshSecret', v === true)} />
                        Remember the {form.sshAuth === 'password' ? 'SSH password' : 'passphrase'} in the OS keychain
                      </label>
                    )}
                  </div>
                )}
              </div>
            </>
          )}

          {error && (
            <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive whitespace-pre-wrap break-words">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t gap-2 sm:justify-between">
          {!isSqlite ? (
            <Button type="button" variant="ghost" onClick={handleTest} disabled={!!busy}>
              {busy === 'test' && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Test
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={handleSave} disabled={!!busy}>
              {busy === 'save' && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
            {!isSqlite && (
              <Button type="button" onClick={handleConnect} disabled={!!busy}>
                {busy === 'connect' && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                {editing ? 'Save and connect' : 'Connect'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
