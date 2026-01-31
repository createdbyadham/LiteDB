import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Upload, FileUp } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useDatabase } from '@/hooks/useDatabase';
import { ElectronFile } from '@/types/electron';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PostgresConnectionForm from '@/components/PostgresConnectionForm';

const UploadView = () => {
  const { loadDatabase } = useDatabase();
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    // Cleanup function for file dialog subscription
    let unsubscribe: (() => void) | undefined;
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, []);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0] as ElectronFile;
      try {
        console.log('Drag and drop file:', { name: file.name, path: file.path, type: file.type });
        
        let arrayBuffer: ArrayBuffer;
        
        // If we have a path (desktop file), use electron API
        if (file.path && window.electron) {
          const result = await window.electron.readDatabase(file.path);
          if (!result.success || !result.data) {
            throw new Error(result.error || 'Failed to read database file');
          }
          arrayBuffer = result.data.buffer;
        } else {
          // Fallback to browser File API for files without path
          arrayBuffer = await file.arrayBuffer();
        }
        
        const processResult = await processFile(arrayBuffer, file.path);
        console.log('Drag and drop process result:', processResult);
        if (processResult.success) {
          navigate('/database');
        }
      } catch (error) {
        console.error('Drag and drop error:', error);
        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to process file",
          variant: "destructive"
        });
      }
    }
  };

  const handleButtonClick = () => {
    if (!window.electron) {
      toast({
        title: "Error",
        description: "Electron API not available",
        variant: "destructive"
      });
      return;
    }

    setIsLoading(true);
    window.electron.openFileDialog(async (filePath: string) => {
      try {
        console.log('Selected file:', filePath);
        if (!window.electron) {
          throw new Error('Electron API not available');
        }
        const result = await window.electron.readDatabase(filePath);
        if (result.success && result.data) {
          const arrayBuffer = result.data.buffer;
          const processResult = await processFile(arrayBuffer, filePath);
          if (processResult.success) {
            navigate('/database');
          }
        } else {
          throw new Error(result.error || 'Failed to read database file');
        }
      } catch (error) {
        console.error('File selection error:', error);
        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to process file",
          variant: "destructive"
        });
      } finally {
        setIsLoading(false);
      }
    });
  };

  const processFile = async (arrayBuffer: ArrayBuffer, filePath?: string) => {
    try {
      console.log('Processing file with path:', filePath);
      const result = await loadDatabase(arrayBuffer, filePath);
      console.log('Database load result:', { success: result, filePath });
      return { success: true };
    } catch (error) {
      console.error('Process file error:', error);
      return { 
        success: false,
        error: error instanceof Error ? error.message : "Failed to process file"
      };
    }
  };

  const handlePostgresConnect = () => {
    navigate('/database');
  };

  return (
    <div className="h-full flex">
      {/* Main Content */}
      <main className="flex-1 flex items-center justify-center p-8 bg-gradient-to-br from-background via-background to-muted/20">
        <Card className="w-full max-w-lg glass animate-scale-in">
          <CardHeader className="space-y-1 text-center pb-2">
            <CardTitle className="text-2xl font-semibold tracking-tight">
              <span className="text-gradient">Connect to Database</span>
            </CardTitle>
            <CardDescription>
              Choose your database type and connect to start exploring
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <Tabs defaultValue="sqlite" className="w-full">
              <TabsList className="grid w-full grid-cols-2 h-11">
                <TabsTrigger value="sqlite" className="data-[state=active]:bg-background">
                  <Upload className="w-4 h-4 mr-2" />
                  SQLite
                </TabsTrigger>
                <TabsTrigger value="postgres" className="data-[state=active]:bg-background">
                  <FileUp className="w-4 h-4 mr-2" />
                  PostgreSQL
                </TabsTrigger>
              </TabsList>
              
              <TabsContent value="sqlite" className="space-y-4 mt-6">
                <div
                  className={`border-2 border-dashed rounded-xl p-10 transition-all duration-200 ease-in-out cursor-pointer ${
                    isDragging 
                      ? 'border-primary bg-primary/5 scale-[1.02]' 
                      : 'border-border hover:border-primary/50 hover:bg-muted/30'
                  }`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={handleButtonClick}
                >
                  <div className="flex flex-col items-center justify-center space-y-4 text-center">
                    <div className={`p-4 rounded-full transition-colors ${isDragging ? 'bg-primary/20' : 'bg-muted'}`}>
                      <Upload className={`w-8 h-8 transition-colors ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
                    </div>
                    <div>
                      <div className="text-base font-medium mb-1">
                        Drop your database file here
                      </div>
                      <div className="text-sm text-muted-foreground">
                        or click to browse
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground bg-muted/50 px-3 py-1 rounded-full">
                      .db, .sqlite, .sqlite3
                    </div>
                  </div>
                </div>
                
                {isLoading && (
                  <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                    <div className="animate-spin w-4 h-4 border-2 border-primary border-t-transparent rounded-full" />
                    <span>Loading database...</span>
                  </div>
                )}
              </TabsContent>
              
              <TabsContent value="postgres" className="mt-6">
                <PostgresConnectionForm onConnectionSuccess={handlePostgresConnect} />
              </TabsContent>
            </Tabs>
          </CardContent>
          <CardFooter className="pt-2">
            <div className="text-xs text-center w-full text-muted-foreground flex items-center justify-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              Your data remains local and secure
            </div>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
};

export default UploadView;
