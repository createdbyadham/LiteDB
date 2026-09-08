import { useState, useMemo, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { 
  Loader2, 
  Box,
  Cpu,
  CheckCircle2,
  Download,
  AlertCircle,
  Plus,
  Sparkles,
  Database
} from 'lucide-react';
import { VectorColumnInfo, pgService } from '@/lib/pgService';
import { localEmbeddings, setProgressCallback, AVAILABLE_MODELS } from '@/lib/localEmbeddings';

interface MockDataGeneratorProps {
  vectorColumns: VectorColumnInfo[];
  getTableColumns: (tableName: string) => Promise<{ name: string; pk: number; type: string }[]>;
  onInsertComplete?: () => void;
}

export const MockDataGenerator = ({
  vectorColumns,
  getTableColumns,
  onInsertComplete
}: MockDataGeneratorProps) => {
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [tableColumns, setTableColumns] = useState<{ name: string; pk: number; type: string }[]>([]);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [sourceTexts, setSourceTexts] = useState<Record<string, string>>({});
  const [generatedVectors, setGeneratedVectors] = useState<Record<string, number[]>>({});
  const [isGenerating, setIsGenerating] = useState(false);
  const [isInserting, setIsInserting] = useState(false);
  
  // Local embedding model state
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelProgress, setModelProgress] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState<string>('bge-base');

  // Get the selected model info
  const selectedModel = useMemo(() => {
    return AVAILABLE_MODELS.find(m => m.id === selectedModelId);
  }, [selectedModelId]);

  // Initialize model status on mount
  useEffect(() => {
    if (localEmbeddings.isReady && localEmbeddings.currentModel) {
      setModelStatus('ready');
      setSelectedModelId(localEmbeddings.currentModel.id);
    } else if (localEmbeddings.error) {
      setModelStatus('error');
    }
  }, []);

  // Load the local embedding model
  const handleLoadModel = async () => {
    setModelStatus('loading');
    setModelProgress('Downloading model...');
    
    setProgressCallback((progress) => {
      if (progress.file) {
        const percent = progress.progress ? Math.round(progress.progress) : 0;
        setModelProgress(`${progress.file}: ${percent}%`);
      }
    });

    try {
      const success = await localEmbeddings.initialize(selectedModelId);
      if (success && localEmbeddings.currentModel) {
        setModelStatus('ready');
        setModelProgress('');
        toast({
          title: "Model Loaded",
          description: `${localEmbeddings.currentModel.name} (${localEmbeddings.currentModel.dimensions}d) ready`,
        });
      } else {
        setModelStatus('error');
        setModelProgress(localEmbeddings.error || 'Failed to load model');
      }
    } catch (e) {
      setModelStatus('error');
      setModelProgress(e instanceof Error ? e.message : 'Failed to load model');
    } finally {
      setProgressCallback(null);
    }
  };

  // Handle table change
  const handleTableChange = async (tableName: string) => {
    setSelectedTable(tableName);
    setFormData({});
    setSourceTexts({});
    setGeneratedVectors({});
    
    try {
      const columns = await getTableColumns(tableName);
      setTableColumns(columns);
    } catch (e) {
      console.error('Error fetching columns:', e);
      toast({
        title: "Error",
        description: "Failed to fetch table columns",
        variant: "destructive"
      });
    }
  };

  // Handle input change
  const handleInputChange = (column: string, value: string) => {
    setFormData(prev => ({ ...prev, [column]: value }));
  };

  // Handle source text change for vector generation
  const handleSourceTextChange = (column: string, value: string) => {
    setSourceTexts(prev => ({ ...prev, [column]: value }));
  };

  // Generate embedding
  const handleGenerateEmbedding = async (columnName: string) => {
    const text = sourceTexts[columnName];
    if (!text?.trim()) {
      toast({
        title: "Missing Text",
        description: "Please enter text to generate embedding",
        variant: "destructive"
      });
      return;
    }

    if (!localEmbeddings.isReady) {
      toast({
        title: "Model Not Ready",
        description: "Please load an embedding model first",
        variant: "destructive"
      });
      return;
    }

    setIsGenerating(true);
    try {
      const vector = await localEmbeddings.embed(text);
      setGeneratedVectors(prev => ({ ...prev, [columnName]: vector }));
      
      // Auto-fill the vector string representation in the form data
      // pgvector format: [1,2,3]
      const vectorStr = `[${vector.join(',')}]`;
      setFormData(prev => ({ ...prev, [columnName]: vectorStr }));

      toast({
        title: "Vector Generated",
        description: `Generated ${vector.length}-dimensional vector`,
      });
    } catch (e) {
      console.error('Embedding error:', e);
      toast({
        title: "Generation Failed",
        description: e instanceof Error ? e.message : "Failed to generate embedding",
        variant: "destructive"
      });
    } finally {
      setIsGenerating(false);
    }
  };

  // Insert row
  const handleInsert = async () => {
    if (!selectedTable) return;

    setIsInserting(true);
    try {
      // Filter out empty values (unless they are explicitly empty strings that are allowed)
      // For simplicity, we'll send all keys in formData
      const success = await pgService.insertRow(selectedTable, formData);
      
      if (success) {
        toast({
          title: "Success",
          description: "Row inserted successfully",
        });
        // Reset form
        setFormData({});
        setSourceTexts({});
        setGeneratedVectors({});
        onInsertComplete?.();
      }
    } catch (e) {
      console.error('Insert error:', e);
    } finally {
      setIsInserting(false);
    }
  };

  // Get vector columns for current table
  const currentVectorColumns = useMemo(() => {
    return vectorColumns.filter(vc => vc.tableName === selectedTable);
  }, [vectorColumns, selectedTable]);

  return (
    <div className="flex h-full">
      {/* Left Panel - Configuration */}
      <aside className="w-80 h-full bg-background border-r flex flex-col shrink-0">
        <div className="p-4 border-b">
          <h2 className="font-semibold flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            Mock Data Generator
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            Generate embeddings and insert rows
          </p>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-6">
            {/* Table Selection */}
            <div className="space-y-2">
              <Label>Target Table</Label>
              <Select value={selectedTable} onValueChange={handleTableChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a table" />
                </SelectTrigger>
                <SelectContent>
                  {[...new Set(vectorColumns.map(vc => vc.tableName))].map(table => (
                    <SelectItem key={table} value={table}>
                      {table}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Model Selection */}
            <div className="space-y-3 p-3 rounded-lg border bg-muted/30">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4" />
                <span className="text-sm font-medium">Embedding Model</span>
              </div>

              <Select 
                value={selectedModelId} 
                onValueChange={setSelectedModelId}
                disabled={modelStatus === 'loading'}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AVAILABLE_MODELS.map(model => (
                    <SelectItem key={model.id} value={model.id}>
                      <div className="flex items-center gap-2">
                        <span>{model.name}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {model.dimensions}d
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {modelStatus === 'idle' && (
                <Button 
                  size="sm" 
                  variant="outline" 
                  className="w-full"
                  onClick={handleLoadModel}
                >
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  Load Model
                </Button>
              )}

              {modelStatus === 'loading' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span className="text-xs">Loading...</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {modelProgress}
                  </p>
                </div>
              )}

              {modelStatus === 'ready' && (
                <div className="flex items-center gap-2 text-green-600 text-xs">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Model ready</span>
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      </aside>

      {/* Right Panel - Form */}
      <div className="flex-1 flex flex-col h-full overflow-hidden bg-muted/10">
        {selectedTable ? (
          <ScrollArea className="flex-1">
            <div className="p-8 max-w-3xl mx-auto space-y-8">
              <div className="space-y-6">
                {tableColumns.map(col => {
                  const isVector = currentVectorColumns.some(vc => vc.columnName === col.name);
                  const isPk = col.pk === 1;
                  
                  // Skip auto-increment PKs usually, but let's show them as optional or disabled?
                  // For now, just show everything.
                  
                  if (isVector) {
                    return (
                      <div key={col.name} className="space-y-4 p-4 border rounded-lg bg-background shadow-sm">
                        <div className="flex items-center justify-between">
                          <Label className="text-base font-medium flex items-center gap-2">
                            <Box className="w-4 h-4 text-primary" />
                            {col.name}
                            <Badge variant="secondary" className="text-xs font-normal">vector</Badge>
                          </Label>
                          {generatedVectors[col.name] && (
                            <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50">
                              Generated ({generatedVectors[col.name].length}d)
                            </Badge>
                          )}
                        </div>

                        <div className="grid gap-4">
                          <div className="space-y-2">
                            <Label className="text-xs text-muted-foreground">Source Text</Label>
                            <Textarea 
                              placeholder={`Enter text to generate ${col.name} embedding...`}
                              value={sourceTexts[col.name] || ''}
                              onChange={(e) => handleSourceTextChange(col.name, e.target.value)}
                              className="resize-none"
                              rows={3}
                            />
                          </div>

                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => handleGenerateEmbedding(col.name)}
                            disabled={isGenerating || modelStatus !== 'ready' || !sourceTexts[col.name]}
                            className="w-fit"
                          >
                            {isGenerating ? (
                              <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                            ) : (
                              <Sparkles className="w-3.5 h-3.5 mr-2" />
                            )}
                            Generate Embedding
                          </Button>

                          {formData[col.name] && (
                            <div className="space-y-1">
                              <Label className="text-xs text-muted-foreground">Vector Value (Preview)</Label>
                              <Input 
                                value={formData[col.name]} 
                                readOnly 
                                className="font-mono text-xs text-muted-foreground bg-muted" 
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={col.name} className="space-y-2">
                      <Label className="flex items-center gap-2">
                        {col.name}
                        {isPk && <Badge variant="outline" className="text-[10px]">PK</Badge>}
                        <span className="text-xs text-muted-foreground font-normal">({col.type})</span>
                      </Label>
                      <Input
                        value={formData[col.name] || ''}
                        onChange={(e) => handleInputChange(col.name, e.target.value)}
                        placeholder={`Enter ${col.name}`}
                      />
                    </div>
                  );
                })}
              </div>

              <div className="flex justify-end pt-4 border-t">
                <Button 
                  size="lg"
                  onClick={handleInsert}
                  disabled={isInserting || Object.keys(formData).length === 0}
                >
                  {isInserting ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4 mr-2" />
                  )}
                  Insert Row
                </Button>
              </div>
            </div>
          </ScrollArea>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <div className="text-center space-y-2">
              <Database className="w-12 h-12 mx-auto text-muted-foreground/50" />
              <p>Select a table to start generating data</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
