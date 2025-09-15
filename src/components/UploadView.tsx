import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Database, Upload, FileUp, Server } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useDatabase } from '@/hooks/useDatabase';
import { ElectronFile } from '@/types/electron';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PostgresConnectionForm from '@/components/PostgresConnectionForm';
import icon from '/titlebaricon2.png';

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
      const file = files[0];
      try {
        console.log('Drag and drop file:', { name: file.name, path: (file as ElectronFile).path, type: file.type });
        const arrayBuffer = await file.arrayBuffer();
        const result = await processFile(arrayBuffer, (file as ElectronFile).path);
        console.log('Drag and drop process result:', result);
        if (result.success) {
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
    const unsubscribe = window.electron.openFileDialog(async (filePath: string) => {
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
    <div className="absolute inset-0 flex items-center justify-center p-6 bg-gradient-to-b from-background to-background/70 animate-fade-in">
      <Card className="w-full max-w-md mx-auto glass animate-scale-in">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto mb-2 w-10 h-10 flex items-center justify-center">
            <img src={icon} alt="App Icon" className="w-auto h-auto" />
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight">
            <span className="text-gradient">Database Viewer</span>
          </CardTitle>
          <CardDescription>
            Connect to a database to view and edit its content
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs defaultValue="sqlite" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="sqlite">SQLite</TabsTrigger>
              <TabsTrigger value="postgres">PostgreSQL</TabsTrigger>
            </TabsList>
            
            <TabsContent value="sqlite" className="space-y-4 mt-4">
              <div
                className={`border-2 border-dashed rounded-lg p-8 transition-all duration-200 ease-in-out ${
                  isDragging 
                    ? 'border-primary/80 bg-primary/5' 
                    : 'border-border hover:border-primary/40 hover:bg-primary/5'
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="flex flex-col items-center justify-center space-y-3 text-center">
                  <div className="mb-2 p-3 rounded-full bg-primary/10">
                    <Upload className={`w-6 h-6 ${isDragging ? 'text-primary' : 'text-muted-foreground'}`} />
                  </div>
                  <div className="text-sm">
                    <span className="font-medium">Drag and drop</span> your SQLite database here
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Supports .db, .sqlite, and .sqlite3 files
                  </div>
                </div>
              </div>
              
              <Button 
                className="w-full transition-all" 
                onClick={handleButtonClick}
                disabled={isLoading}
              >
                {isLoading ? (
                  <div className="flex items-center space-x-2">
                    <div className="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full" />
                    <span>Loading...</span>
                  </div>
                ) : (
                  <div className="flex items-center space-x-2">
                    <FileUp className="w-4 h-4" />
                    <span>Browse Files</span>
                  </div>
                )}
              </Button>
            </TabsContent>
            
            <TabsContent value="postgres" className="mt-4">
              <PostgresConnectionForm onConnectionSuccess={handlePostgresConnect} />
            </TabsContent>
          </Tabs>
        </CardContent>
        <CardFooter>
          <div className="text-xs text-center w-full text-muted-foreground">
            Your data remains local and is not uploaded to any server
          </div>
        </CardFooter>
      </Card>
    </div>
  );
};

export default UploadView;
