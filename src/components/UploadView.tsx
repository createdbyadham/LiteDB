import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Database, Upload, FileUp, ArrowRight } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { useDatabase } from '@/hooks/useDatabase';
import { ElectronFile } from '@/types/electron';

const UploadView = () => {
  const { loadDatabase } = useDatabase();
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

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
        const arrayBuffer = await file.arrayBuffer();
        await processFile(arrayBuffer);
      } catch (error) {
        toast({
          title: "Error",
          description: error instanceof Error ? error.message : "Failed to process file",
          variant: "destructive"
        });
      }
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files?.[0]) return;

    const file = event.target.files[0];
    
    try {
      setIsLoading(true);
      const arrayBuffer = await file.arrayBuffer();
      const result = await processFile(arrayBuffer);
      if (result.success) {
        navigate('/database');
      } else {
        toast({
          title: "Error",
          description: result.error || "Failed to process file",
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to process file",
        variant: "destructive"
      });
    } finally {
      setIsLoading(false);
    }
  };

  const processFile = async (arrayBuffer: ArrayBuffer) => {
    try {
      const result = await loadDatabase(arrayBuffer);
      return { success: true };
    } catch (error) {
      return { 
        success: false,
        error: error instanceof Error ? error.message : "Failed to process file"
      };
    }
  };

  const handleButtonClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 bg-gradient-to-b from-background to-background/70 animate-fade-in">
      <Card className="w-full max-w-md mx-auto glass animate-scale-in">
        <CardHeader className="space-y-1 text-center">
          <div className="mx-auto mb-4 p-3 rounded-full bg-primary/10 w-16 h-16 flex items-center justify-center">
            <Database className="w-8 h-8 text-primary" />
          </div>
          <CardTitle className="text-2xl font-semibold tracking-tight">
            <span className="text-gradient">SQLite Viewer</span>
          </CardTitle>
          <CardDescription>
            Upload a SQLite database to view and edit its content
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
        </CardContent>
        <CardFooter className="flex flex-col space-y-3">
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
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".db,.sqlite,.sqlite3"
            className="hidden"
          />
          <div className="text-xs text-center text-muted-foreground">
            Your data remains local and is not uploaded to any server
          </div>
        </CardFooter>
      </Card>
    </div>
  );
};

export default UploadView;
