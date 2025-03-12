import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { dbService } from '@/lib/dbService';
import { toast } from '@/hooks/use-toast';
import { AlertCircle, PlayCircle, Save, Trash, CheckCircle2, Info } from 'lucide-react';

const BatchOperations = () => {
  const [sqlScript, setSqlScript] = useState('');
  const [useTransaction, setUseTransaction] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<{ 
    success: boolean;
    affectedTables: string[];
    errors: string[];
    executionTime?: number;
  } | null>(null);
  const [savedScripts, setSavedScripts] = useState<{ name: string; sql: string }[]>([]);
  const [scriptName, setScriptName] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Function to execute the SQL script
  const executeScript = async () => {
    if (!sqlScript.trim()) {
      toast({
        title: "Empty Script",
        description: "Please enter SQL statements to execute",
        variant: "destructive"
      });
      return;
    }

    setIsRunning(true);
    setResults(null);

    try {
      // Split script into statements by semicolons
      // This is a simple parser and may not handle all SQL syntax perfectly
      // Especially if semicolons occur in string literals or comments
      const statements = sqlScript
        .split(';')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0);

      if (statements.length === 0) {
        toast({
          title: "Invalid Script",
          description: "No valid SQL statements found",
          variant: "destructive"
        });
        setIsRunning(false);
        return;
      }

      const startTime = performance.now();
      const result = dbService.executeBatchOperations(statements, useTransaction);
      const endTime = performance.now();

      setResults({
        ...result,
        executionTime: Math.round(endTime - startTime)
      });

      if (result.success) {
        toast({
          title: "Success",
          description: `Executed ${statements.length} statement${statements.length > 1 ? 's' : ''} successfully`
        });
      } else {
        toast({
          title: "Execution Error",
          description: `${result.errors.length} error${result.errors.length > 1 ? 's' : ''} occurred`,
          variant: "destructive"
        });
      }
    } catch (error) {
      setResults({
        success: false,
        affectedTables: [],
        errors: [error instanceof Error ? error.message : "Unknown error occurred"]
      });
      
      toast({
        title: "Execution Failed",
        description: error instanceof Error ? error.message : "Unknown error occurred",
        variant: "destructive"
      });
    } finally {
      setIsRunning(false);
    }
  };

  const saveScript = () => {
    if (!sqlScript.trim()) {
      toast({
        title: "Empty Script",
        description: "Cannot save an empty script",
        variant: "destructive"
      });
      return;
    }

    if (!scriptName.trim()) {
      toast({
        title: "Missing Name",
        description: "Please provide a name for your script",
        variant: "destructive"
      });
      return;
    }

    // Check for duplicates
    if (savedScripts.some(script => script.name === scriptName)) {
      toast({
        title: "Duplicate Name",
        description: "A script with this name already exists",
        variant: "destructive"
      });
      return;
    }

    const newScript = { name: scriptName, sql: sqlScript };
    setSavedScripts([...savedScripts, newScript]);
    
    // Save to localStorage for persistence
    const existingScripts = JSON.parse(localStorage.getItem('savedScripts') || '[]');
    localStorage.setItem('savedScripts', JSON.stringify([...existingScripts, newScript]));
    
    setScriptName('');
    toast({
      title: "Script Saved",
      description: `"${scriptName}" has been saved to your collection`
    });
  };

  const loadScript = (script: { name: string; sql: string }) => {
    setSqlScript(script.sql);
    toast({
      title: "Script Loaded",
      description: `"${script.name}" is ready to edit or execute`
    });
  };

  const deleteScript = (scriptToDelete: { name: string; sql: string }) => {
    const updatedScripts = savedScripts.filter(script => script.name !== scriptToDelete.name);
    setSavedScripts(updatedScripts);
    
    // Update localStorage
    localStorage.setItem('savedScripts', JSON.stringify(updatedScripts));
    
    toast({
      title: "Script Deleted",
      description: `"${scriptToDelete.name}" has been removed from your collection`
    });
  };

  // Load saved scripts from localStorage when component mounts
  useEffect(() => {
    try {
      const storedScripts = localStorage.getItem('savedScripts');
      if (storedScripts) {
        setSavedScripts(JSON.parse(storedScripts));
      }
    } catch (error) {
      console.error("Error loading saved scripts:", error);
    }
  }, []);

  return (
    <div className="space-y-4 animate-fade-in">
      <Tabs defaultValue="editor" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="editor">Script Editor</TabsTrigger>
          <TabsTrigger value="savedScripts">Saved Scripts</TabsTrigger>
        </TabsList>
        
        <TabsContent value="editor" className="space-y-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-4">
                <div className="flex items-center space-x-2">
                  <Switch 
                    id="transaction-mode" 
                    checked={useTransaction} 
                    onCheckedChange={setUseTransaction} 
                  />
                  <Label htmlFor="transaction-mode">
                    Use Transaction (All or Nothing)
                  </Label>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center space-x-2">
                  <input
                    type="text"
                    placeholder="Script name"
                    className="flex h-9 w-[250px] rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    value={scriptName}
                    onChange={(e) => setScriptName(e.target.value)}
                  />
                  <Button variant="outline" onClick={saveScript}>
                    <Save className="mr-2 h-4 w-4" />
                    Save Script
                  </Button>
                </div>
                <Button onClick={executeScript} disabled={isRunning}>
                  <PlayCircle className="mr-2 h-4 w-4" />
                  {isRunning ? 'Running...' : 'Execute Script'}
                </Button>
              </div>
            </div>
            
            <Textarea
              ref={textareaRef}
              placeholder="Enter SQL statements separated by semicolons (;)..."
              className="font-mono min-h-[300px] resize-y"
              value={sqlScript}
              onChange={(e) => setSqlScript(e.target.value)}
            />
            
            {results && (
              <div className="space-y-2">
                <Alert variant={results.success ? "default" : "destructive"}>
                  <div className="flex items-center gap-2">
                    {results.success ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <AlertCircle className="h-4 w-4" />
                    )}
                    <AlertTitle>
                      {results.success ? 'Script executed successfully' : 'Script execution failed'}
                    </AlertTitle>
                  </div>
                  <AlertDescription>
                    <div className="mt-2">
                      <p>Execution time: {results.executionTime}ms</p>
                      
                      {results.affectedTables.length > 0 && (
                        <div className="mt-2">
                          <p>Affected tables:</p>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {results.affectedTables.map(table => (
                              <span key={table} className="inline-flex items-center px-2 py-1 bg-secondary text-secondary-foreground rounded-md text-xs">
                                {table}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      
                      {results.errors.length > 0 && (
                        <div className="mt-2">
                          <p>Errors:</p>
                          <ScrollArea className="h-[150px] w-full mt-1 rounded-md border">
                            <div className="p-4">
                              {results.errors.map((error, index) => (
                                <div key={index} className="border-b border-border pb-2 mb-2 last:pb-0 last:mb-0 last:border-b-0">
                                  <code className="text-xs font-mono">{error}</code>
                                </div>
                              ))}
                            </div>
                          </ScrollArea>
                        </div>
                      )}
                    </div>
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </div>
        </TabsContent>
        
        <TabsContent value="savedScripts">
          {savedScripts.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {savedScripts.map((script, index) => (
                <Card key={index}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg">{script.name}</CardTitle>
                    <CardDescription className="line-clamp-1 text-xs font-mono">
                      {script.sql.substring(0, 60)}...
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="flex justify-end space-x-2">
                      <Button variant="outline" size="sm" onClick={() => loadScript(script)}>
                        Load
                      </Button>
                      <Button 
                        variant="destructive" 
                        size="sm"
                        onClick={() => deleteScript(script)}
                      >
                        <Trash className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center p-8 text-center">
              <Info className="h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium">No saved scripts</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Save your SQL scripts to quickly access them later
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default BatchOperations; 