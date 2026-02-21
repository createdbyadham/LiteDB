import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Upload, FileUp } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useSqlite } from '@/hooks/useSqlite';
import { FileWithPath } from '@/types/global';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PostgresConnectionForm from '@/components/PostgresConnectionForm';
import icon from '/titlebaricon2.png';
import { tauriService } from '@/lib/tauri';
import { listen } from '@tauri-apps/api/event';
import { pgService } from '@/lib/pgService';

const UploadView = () => {
  const { loadDatabase } = useSqlite();
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let isMounted = true;
    let unlisteners: (() => void)[] = [];

    const setupListeners = async () => {
      // Listener for 'tauri://file-drop' (legacy/standard)
      const unlistenDrop = await listen('tauri://file-drop', async (event) => {
        if (!isMounted) return;
        setIsDragging(false);
        
        const paths = event.payload as string[];
        if (paths && Array.isArray(paths) && paths.length > 0) {
          await loadAndProcessDatabase(paths[0]);
        }
      });
      if (!isMounted) { unlistenDrop(); return; }
      unlisteners.push(unlistenDrop);

      // Listener for 'tauri://drag-drop' (potential v2 alternative)
      const unlistenDragDrop = await listen('tauri://drag-drop', async (event) => {
        if (!isMounted) return;
        setIsDragging(false);
        
        const payload = event.payload as any;
        const paths = payload?.paths || (Array.isArray(payload) ? payload : []);
        
        if (paths && Array.isArray(paths) && paths.length > 0) {
          await loadAndProcessDatabase(paths[0]);
        }
      });
      if (!isMounted) { unlistenDragDrop(); return; }
      unlisteners.push(unlistenDragDrop);

      const unlistenHover = await listen('tauri://file-drop-hover', () => {
        if (isMounted) setIsDragging(true);
      });
      if (!isMounted) { unlistenHover(); return; }
      unlisteners.push(unlistenHover);

      const unlistenDragEnter = await listen('tauri://drag-enter', () => {
        if (isMounted) setIsDragging(true);
      });
      if (!isMounted) { unlistenDragEnter(); return; }
      unlisteners.push(unlistenDragEnter);

      const unlistenCancel = await listen('tauri://file-drop-cancelled', () => {
        if (isMounted) setIsDragging(false);
      });
      if (!isMounted) { unlistenCancel(); return; }
      unlisteners.push(unlistenCancel);

      const unlistenDragLeave = await listen('tauri://drag-leave', () => {
        if (isMounted) setIsDragging(false);
      });
      if (!isMounted) { unlistenDragLeave(); return; }
      unlisteners.push(unlistenDragLeave);
    };

    setupListeners();

    return () => {
      isMounted = false;
      unlisteners.forEach(fn => fn());
    };
  }, []);

  const loadAndProcessDatabase = async (filePath: string) => {
    // Ensure Postgres is disconnected before loading SQLite
    pgService.disconnect();
    
    setIsLoading(true);
    try {
      const result = await tauriService.readDatabase(filePath);
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to read database file');
      }
      
      const loadResult = await loadDatabase(result.data.buffer, filePath);
      if (loadResult) {
        navigate('/database');
      }
    } catch (error) {
      console.error('Database load error:', error);
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to process file",
        variant: "destructive"
      });
    } finally {
      setIsLoading(false);
    }
  };

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
      const file = files[0] as FileWithPath;
      
      // If we have a path, use the unified loader
      if (file.path) {
        await loadAndProcessDatabase(file.path);
      } else {
        // Fallback for files without path (less likely in Tauri but possible in browser mode)
        try {
          setIsLoading(true);
          const arrayBuffer = await file.arrayBuffer();
          const loadResult = await loadDatabase(arrayBuffer);
          if (loadResult) {
            navigate('/database');
          }
        } catch (error) {
          console.error('Browser drop error:', error);
          toast({
            title: "Error",
            description: "Failed to process file",
            variant: "destructive"
          });
        } finally {
          setIsLoading(false);
        }
      }
    }
  };

  const handleButtonClick = async () => {
    try {
      const filePath = await tauriService.openFileDialog();
      if (filePath) {
        await loadAndProcessDatabase(filePath);
      }
    } catch (error) {
      console.error('File selection error:', error);
    }
  };

  const handlePostgresConnect = () => {
    navigate('/database');
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 bg-gradient-to-b from-background to-background/70 animate-fade-in">
      <Card className="w-full max-w-md mx-auto glass animate-scale-in">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto w-10 h-10 flex items-center justify-center">
            <img src={icon} alt="App Icon" className="w-auto h-auto" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs defaultValue="sqlite" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="sqlite">SQLite</TabsTrigger>
              <TabsTrigger value="postgres">PostgreSQL</TabsTrigger>
            </TabsList>

            <TabsContent value="sqlite" className="space-y-4 mt-4">
              <div
                className={`border-2 border-dashed rounded-lg px-8 py-[40px] transition-all duration-200 ease-in-out ${isDragging
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