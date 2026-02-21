import React, { useState } from 'react';
import { PgConfig } from '@/lib/pgService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { usePostgres } from '@/hooks/usePostgres';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronUp, ChevronDown } from 'lucide-react';

interface PostgresConnectionFormProps {
  onConnectionSuccess?: () => void;
}

export default function PostgresConnectionForm({ onConnectionSuccess }: PostgresConnectionFormProps) {
  const { connectToDatabase, isConnecting } = usePostgres();
  const [showCredentialsDialog, setShowCredentialsDialog] = useState(false);
  
  const [config, setConfig] = useState<PgConfig>({
    host: 'localhost',
    port: 5432,
    database: '',
    username: 'postgres',
    password: '',
    ssl: false
  });
  
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
    
    if (success && onConnectionSuccess) {
      onConnectionSuccess();
    }
  };
  
  return (
    <>
      <Card className="w-full max-w-md mx-auto">
        <CardHeader>
          <CardTitle>Connect to PostgreSQL</CardTitle>
          <CardDescription>
            Enter your PostgreSQL database connection details
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleFormSubmit}>
          <CardContent className="space-y-4">
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
      /* Hide default browser spinners and add right padding to make room for custom buttons */
      className="pr-8 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
    />
    <div className="absolute right-1 top-1 bottom-1 flex flex-col justify-center border-l pl-1 border-border/50">
      <button
        type="button"
        tabIndex={-1} // Prevents these buttons from interrupting normal form tabbing
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
            
            <div className="flex items-center space-x-2">
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
          </CardContent>
          
          <CardFooter>
            <Button type="submit" className="w-full">
              Continue
            </Button>
          </CardFooter>
        </form>
      </Card>

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

            <DialogFooter className="sm:justify-between">
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