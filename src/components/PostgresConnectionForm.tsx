import React, { useEffect, useState } from 'react';
import { PgConfig } from '@/lib/pgService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { usePostgres } from '@/hooks/usePostgres';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronUp, ChevronDown, KeyRound, Server, X } from 'lucide-react';
import {
  describeConnection,
  forgetConnection,
  listRecentConnections,
  loadPassword,
  rememberConnection,
  type RecentConnection,
} from '@/lib/recentConnections';

interface PostgresConnectionFormProps {
  onConnectionSuccess?: () => void;
}

export default function PostgresConnectionForm({ onConnectionSuccess }: PostgresConnectionFormProps) {
  const { connectToDatabase, isConnecting } = usePostgres();
  const [showCredentialsDialog, setShowCredentialsDialog] = useState(false);
  const [recent, setRecent] = useState<RecentConnection[]>([]);
  const [savePassword, setSavePassword] = useState(true);

  const [config, setConfig] = useState<PgConfig>({
    host: 'localhost',
    port: 5432,
    database: '',
    username: 'postgres',
    password: '',
    ssl: false
  });

  useEffect(() => {
    setRecent(listRecentConnections());
  }, []);

  /**
   * Fill the form from a remembered connection and go straight to the
   * credentials step.
   *
   * A saved password is fetched from the OS keychain here rather than held in
   * component state from the start, so it exists in memory only between
   * choosing the connection and connecting.
   */
  const openRecent = async (entry: RecentConnection) => {
    const password = entry.hasSavedPassword ? await loadPassword(entry.id) : null;
    setConfig({
      host: entry.host,
      port: entry.port,
      database: entry.database,
      username: entry.username,
      password: password ?? '',
      ssl: entry.ssl,
    });
    setSavePassword(entry.hasSavedPassword);
    setShowCredentialsDialog(true);
  };

  const removeRecent = async (event: React.MouseEvent, id: string) => {
    // The row is itself a button; without this the click would also open it.
    event.stopPropagation();
    await forgetConnection(id);
    setRecent(listRecentConnections());
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type } = e.target;
    
    if (type === 'checkbox') {
      const checked = (e.target as HTMLInputElement).checked;
      setConfig(prev => ({ ...prev, [name]: checked }));
    } else if (name === 'port') {
      const portValue = parseInt(value, 10);
      setConfig(prev => ({ ...prev, [name]: isNaN(portValue) ? prev.port : portValue }));
    } else {
      setConfig(prev => ({ ...prev, [name]: value }));
    }
  };
  
  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowCredentialsDialog(true);
  };
  
  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowCredentialsDialog(false);

    const success = await connectToDatabase(config);

    if (success) {
      // Only remembered once it actually worked. Offering to reopen a
      // connection that never connected is worse than not offering.
      await rememberConnection(config, savePassword);
      setRecent(listRecentConnections());
      onConnectionSuccess?.();
    }
  };
  
  return (
    <>
      {recent.length > 0 && (
        <div className="mb-5 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Recent</Label>
          </div>
          <div className="space-y-1.5">
            {recent.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => void openRecent(entry)}
                className="group w-full flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/60 transition-colors"
              >
                <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs">{describeConnection(entry)}</span>
                {entry.hasSavedPassword && (
                  <KeyRound
                    className="h-3 w-3 shrink-0 text-emerald-500"
                    aria-label="Password saved"
                  />
                )}
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Forget ${describeConnection(entry)}`}
                  onClick={(event) => void removeRecent(event, entry.id)}
                  className="ml-auto shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background text-muted-foreground hover:text-foreground transition-opacity"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <div className="h-px flex-1 bg-border" />
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              or connect to a new one
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </div>
      )}

      <form onSubmit={handleFormSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="host">Host</Label>
            <Input 
              id="host" 
              name="host" 
              value={config.host} 
              onChange={handleChange} 
              required 
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="port">Port</Label>
            <div className="relative">
              <Input 
                id="port" 
                name="port" 
                type="number" 
                value={config.port} 
                onChange={handleChange} 
                required 
                className="pr-8 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <div className="absolute right-1 top-1 bottom-1 flex flex-col justify-center border-l pl-1 border-border/50">
                <button
                  type="button"
                  tabIndex={-1}
                  className="flex-1 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-tr-sm px-1 transition-colors"
                  onClick={() => setConfig(prev => ({ ...prev, port: Number(prev.port) + 1 }))}
                >
                  <ChevronUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  tabIndex={-1}
                  className="flex-1 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-br-sm px-1 transition-colors"
                  onClick={() => setConfig(prev => ({ ...prev, port: Math.max(0, Number(prev.port) - 1) }))}
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </div>
            </div>
          </div>
        </div>
        
        <div className="space-y-2">
          <Label htmlFor="database">Database Name</Label>
          <Input 
            id="database" 
            name="database" 
            value={config.database} 
            onChange={handleChange} 
            required 
          />
        </div>
        
        <div className="flex items-center space-x-2 pt-2">
          <Checkbox 
            id="ssl" 
            name="ssl" 
            checked={config.ssl} 
            onCheckedChange={(checked) => 
              setConfig(prev => ({ ...prev, ssl: checked === true }))
            } 
          />
          <Label htmlFor="ssl">Use SSL</Label>
        </div>
        
        <Button type="submit" className="w-full mt-4">
          Continue
        </Button>
      </form>

      <Dialog open={showCredentialsDialog} onOpenChange={setShowCredentialsDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Database Credentials</DialogTitle>
            <DialogDescription>
              Enter your PostgreSQL database credentials to connect
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleConnect} className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input 
                id="username" 
                name="username" 
                value={config.username} 
                onChange={handleChange} 
                required 
                autoFocus
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input 
                id="password" 
                name="password" 
                type="password" 
                value={config.password} 
                onChange={handleChange} 
              />
            </div>

            <div className="flex items-start space-x-2 pt-1">
              <Checkbox
                id="savePassword"
                checked={savePassword}
                onCheckedChange={(checked) => setSavePassword(checked === true)}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor="savePassword" className="text-sm font-normal">
                  Remember this connection
                </Label>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Host, database and username are stored locally. The password goes to your
                  operating system&apos;s keychain, never to a file.
                </p>
              </div>
            </div>

            <DialogFooter className="sm:justify-between pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCredentialsDialog(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isConnecting}>
                {isConnecting ? 'Connecting...' : 'Connect'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}