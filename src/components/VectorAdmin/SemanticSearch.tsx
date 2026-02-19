import { useState, useMemo, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Slider } from '@/components/ui/slider';
import { toast } from '@/hooks/use-toast';
import { 
  Search, 
  Hash, 
  Type, 
  Loader2, 
  Box,
  AlertCircle,
  Cpu,
  CheckCircle2,
  Download,
  ChevronRight
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { VectorColumnInfo, SimilarityResult } from '@/lib/pgService';
import { VectorBadge } from './VectorBadge';
import { localEmbeddings, setProgressCallback, AVAILABLE_MODELS } from '@/lib/localEmbeddings';
import { useSidebar } from '@/contexts/SidebarContext';

interface SemanticSearchProps {
  vectorColumns: VectorColumnInfo[];
  findSimilarByRowId: (
    tableName: string,
    vectorColumn: string,
    primaryKeyColumn: string,
    rowId: string | number,
    limit?: number,
    distanceMetric?: '<=>' | '<->' | '<#>'
  ) => Promise<SimilarityResult[]>;
  findSimilarByVector: (
    tableName: string,
    vectorColumn: string,
    queryVector: number[],
    limit?: number,
    distanceMetric?: '<=>' | '<->' | '<#>'
  ) => Promise<SimilarityResult[]>;
  getTableColumns: (tableName: string) => Promise<{ name: string; pk: number }[]>;
  onInspectVector?: (value: unknown, columnName: string, rowId?: string | number, tableName?: string) => void;
}

// Distance metric options
const DISTANCE_METRICS = [
  { value: '<=>', label: 'Cosine Distance', description: 'Best for normalized vectors' },
  { value: '<->', label: 'L2 Distance', description: 'Euclidean distance' },
  { value: '<#>', label: 'Inner Product', description: 'Dot product (negative)' },
] as const;

// Similarity score bar component
const SimilarityBar = ({ score, isDistance = false }: { score: number; isDistance?: boolean }) => {
  // For cosine similarity, score is between 0 and 1
  // For distance metrics, lower is better, so we invert
  const displayScore = isDistance ? Math.max(0, 1 - score) : score;
  const percentage = Math.min(100, Math.max(0, displayScore * 100));
  
  // Color based on score
  const getColorClass = () => {
    if (percentage >= 80) return 'bg-green-500';
    if (percentage >= 60) return 'bg-lime-500';
    if (percentage >= 40) return 'bg-yellow-500';
    if (percentage >= 20) return 'bg-orange-500';
    return 'bg-red-500';
  };
  
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div 
          className={cn("h-full transition-all", getColorClass())}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-xs font-mono w-12 text-right">
        {displayScore.toFixed(3)}
      </span>
    </div>
  );
};

export const SemanticSearch = ({
  vectorColumns,
  findSimilarByRowId,
  findSimilarByVector,
  getTableColumns,
  onInspectVector
}: SemanticSearchProps) => {
  // Sidebar state from context
  const { contentSidebarCollapsed: sidebarCollapsed, toggleContentSidebar } = useSidebar();
  
  // Search mode: 'id' or 'text'
  const [searchMode, setSearchMode] = useState<'id' | 'text'>('id');
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [selectedColumn, setSelectedColumn] = useState<string>('');
  const [rowIdInput, setRowIdInput] = useState('');
  const [textInput, setTextInput] = useState('');
  const [distanceMetric, setDistanceMetric] = useState<'<=>' | '<->' | '<#>'>('<=>');
  const [limit, setLimit] = useState(10);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SimilarityResult[]>([]);
  const [primaryKeyColumn, setPrimaryKeyColumn] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  
  // Local embedding model state
  const [modelStatus, setModelStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [modelProgress, setModelProgress] = useState<string>('');
  const [selectedModelId, setSelectedModelId] = useState<string>('minilm');

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
          description: `${localEmbeddings.currentModel.name} (${localEmbeddings.currentModel.dimensions}d) ready for text search`,
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

  // Handle model change - reset status if different model selected
  const handleModelChange = (modelId: string) => {
    setSelectedModelId(modelId);
    if (localEmbeddings.currentModel?.id !== modelId) {
      setModelStatus('idle');
      setModelProgress('');
    }
  };

  // Get unique tables
  const tables = useMemo(() => {
    return [...new Set(vectorColumns.map(vc => vc.tableName))];
  }, [vectorColumns]);

  // Get columns for selected table
  const columnsForTable = useMemo(() => {
    return vectorColumns.filter(vc => vc.tableName === selectedTable);
  }, [vectorColumns, selectedTable]);

  // Get selected column info
  const selectedColumnInfo = useMemo(() => {
    return vectorColumns.find(
      vc => vc.tableName === selectedTable && vc.columnName === selectedColumn
    );
  }, [vectorColumns, selectedTable, selectedColumn]);

  // Handle table change
  const handleTableChange = async (tableName: string) => {
    setSelectedTable(tableName);
    setSelectedColumn('');
    setResults([]);
    setError(null);
    
    // Fetch primary key column
    try {
      const columns = await getTableColumns(tableName);
      const pk = columns.find(c => c.pk === 1);
      if (pk) {
        setPrimaryKeyColumn(pk.name);
      } else {
        setPrimaryKeyColumn('id'); // fallback
      }
    } catch (e) {
      console.error('Error fetching columns:', e);
    }
    
    // Auto-select first vector column
    const cols = vectorColumns.filter(vc => vc.tableName === tableName);
    if (cols.length === 1) {
      setSelectedColumn(cols[0].columnName);
    }
  };

  // Handle search
  const handleSearch = async () => {
    if (!selectedTable || !selectedColumn) {
      toast({
        title: "Missing Input",
        description: "Please select a table and vector column",
        variant: "destructive"
      });
      return;
    }

    if (searchMode === 'id' && !rowIdInput.trim()) {
      toast({
        title: "Missing Input",
        description: "Please enter a row ID",
        variant: "destructive"
      });
      return;
    }

    if (searchMode === 'text' && !textInput.trim()) {
      toast({
        title: "Missing Input",
        description: "Please enter search text",
        variant: "destructive"
      });
      return;
    }

    setIsSearching(true);
    setError(null);
    setResults([]);

    try {
      let searchResults: SimilarityResult[];

      if (searchMode === 'id') {
        searchResults = await findSimilarByRowId(
          selectedTable,
          selectedColumn,
          primaryKeyColumn,
          rowIdInput.trim(),
          limit,
          distanceMetric
        );
      } else {
        // Text search - embed the query first
        if (!localEmbeddings.isReady || !localEmbeddings.currentModel) {
          throw new Error('Embedding model not loaded. Click "Load Model" first.');
        }

        // Check dimension compatibility
        const columnDims = selectedColumnInfo?.dimensions || 0;
        const modelDims = localEmbeddings.currentModel.dimensions;
        if (columnDims !== modelDims) {
          throw new Error(
            `Dimension mismatch: Your column has ${columnDims} dimensions, ` +
            `but ${localEmbeddings.currentModel.name} produces ${modelDims} dimensions. ` +
            `Use "By Row ID" instead, or select a model with matching dimensions.`
          );
        }

        const queryVector = await localEmbeddings.embed(textInput.trim());
        searchResults = await findSimilarByVector(
          selectedTable,
          selectedColumn,
          queryVector,
          limit,
          distanceMetric
        );
      }
      
      setResults(searchResults);
      
      if (searchResults.length === 0) {
        setError(searchMode === 'id' 
          ? 'No similar rows found. Check that the row ID exists and has a valid vector.'
          : 'No similar rows found.'
        );
      }
    } catch (e) {
      console.error('Search error:', e);
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setIsSearching(false);
    }
  };

  // Get display columns (exclude vector columns for cleaner display)
  const displayColumns = useMemo(() => {
    if (results.length === 0) return [];
    const firstRow = results[0].row;
    return Object.keys(firstRow).filter(col => 
      col !== 'distance' && 
      col !== 'similarity' &&
      !vectorColumns.some(vc => vc.columnName === col)
    );
  }, [results, vectorColumns]);

  // Format cell value for display
  const formatCellValue = (value: unknown, columnName: string) => {
    if (value === null || value === undefined) {
      return <span className="text-muted-foreground italic">NULL</span>;
    }
    
    // Check if this is a vector column
    const vecCol = vectorColumns.find(vc => vc.columnName === columnName);
    if (vecCol) {
      return (
        <VectorBadge
          value={value}
          dimensions={vecCol.dimensions}
          onClick={() => onInspectVector?.(value, columnName, undefined, selectedTable)}
        />
      );
    }
    
    const str = String(value);
    if (str.length > 50) {
      return str.slice(0, 50) + '...';
    }
    return str;
  };

  return (
    <div className="flex h-full">
      {/* Left Panel - Controls */}
      <aside className={cn(
        "h-full bg-background border-r transition-all duration-200 ease-out flex flex-col shrink-0",
        sidebarCollapsed ? "w-12" : "w-72"
      )}>
        {/* Sidebar Header */}
        <div className="flex items-center justify-between p-3 border-b">
          {!sidebarCollapsed && (
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Search
            </span>
          )}
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn("h-7 w-7 text-muted-foreground", sidebarCollapsed && "mx-auto")}
                onClick={toggleContentSidebar}
              >
                <ChevronRight className={cn(
                  "h-4 w-4 transition-transform duration-200",
                  !sidebarCollapsed && "rotate-180"
                )} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Expanded state - show controls */}
        {!sidebarCollapsed && (
          <ScrollArea className="flex-1">
            <div className="p-3 space-y-4">

            {/* Table Selection */}
            <div className="space-y-2">
              <Label className="text-xs">Table</Label>
              <Select value={selectedTable} onValueChange={handleTableChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a table" />
                </SelectTrigger>
                <SelectContent>
                  {tables.map(table => (
                    <SelectItem key={table} value={table}>
                      {table}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Vector Column Selection */}
            <div className="space-y-2">
              <Label className="text-xs">Vector Column</Label>
              <Select 
                value={selectedColumn} 
                onValueChange={setSelectedColumn}
                disabled={!selectedTable}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select vector column" />
                </SelectTrigger>
                <SelectContent>
                  {columnsForTable.map(col => (
                    <SelectItem key={col.columnName} value={col.columnName}>
                      <div className="flex items-center gap-2">
                        <Box className="w-3.5 h-3.5" />
                        {col.columnName}
                        <Badge variant="outline" className="text-[10px] ml-1">
                          {col.dimensions}d
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            {/* Search Mode Toggle */}
            <div className="space-y-2">
              <Label className="text-xs">Search Method</Label>
              <div className="flex gap-2">
                <Button
                  variant={searchMode === 'id' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSearchMode('id')}
                  className="flex-1"
                >
                  <Hash className="w-3.5 h-3.5 mr-1.5" />
                  By Row ID
                </Button>
                <Button
                  variant={searchMode === 'text' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setSearchMode('text')}
                  className="flex-1"
                >
                  <Type className="w-3.5 h-3.5 mr-1.5" />
                  By Text
                </Button>
              </div>
            </div>

            {/* Row ID Input */}
            {searchMode === 'id' && (
              <div className="space-y-2">
                <Label className="text-xs">Row ID</Label>
                <Input
                  placeholder="Enter row ID..."
                  value={rowIdInput}
                  onChange={(e) => setRowIdInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                />
                <p className="text-[10px] text-muted-foreground">
                  Find rows similar to this row's vector
                </p>
              </div>
            )}

            {/* Text Input - with local model */}
            {searchMode === 'text' && (
              <div className="space-y-3">
                {/* Model Selection & Status */}
                <div className="p-3 rounded-lg border bg-muted/30 space-y-3">
                  <div className="flex items-center gap-2">
                    <Cpu className="w-4 h-4" />
                    <span className="text-xs font-medium">Local Embedding Model</span>
                  </div>

                  {/* Model Selector */}
                  <Select 
                    value={selectedModelId} 
                    onValueChange={handleModelChange}
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

                  {/* Model Info */}
                  {selectedModel && (
                    <p className="text-[10px] text-muted-foreground">
                      {selectedModel.description} • {selectedModel.size}
                    </p>
                  )}
                  
                  {modelStatus === 'idle' && (
                    <Button 
                      size="sm" 
                      variant="outline" 
                      className="w-full"
                      onClick={handleLoadModel}
                    >
                      <Download className="w-3.5 h-3.5 mr-1.5" />
                      Load {selectedModel?.name}
                    </Button>
                  )}
                  
                  {modelStatus === 'loading' && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span className="text-xs">Loading {selectedModel?.name}...</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {modelProgress}
                      </p>
                    </div>
                  )}
                  
                  {modelStatus === 'ready' && localEmbeddings.currentModel && (
                    <div className="flex items-center gap-2 text-green-600">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span className="text-xs">{localEmbeddings.currentModel.name} ready</span>
                      <Badge variant="outline" className="text-[10px] ml-auto">
                        {localEmbeddings.currentModel.dimensions}d
                      </Badge>
                    </div>
                  )}
                  
                  {modelStatus === 'error' && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 text-red-500">
                        <AlertCircle className="w-3.5 h-3.5" />
                        <span className="text-xs">Failed to load</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground">{modelProgress}</p>
                      <Button 
                        size="sm" 
                        variant="outline" 
                        className="w-full"
                        onClick={handleLoadModel}
                      >
                        Retry
                      </Button>
                    </div>
                  )}
                </div>

                {/* Text Input */}
                <div className="space-y-2">
                  <Label className="text-xs">Search Text</Label>
                  <Textarea
                    placeholder="Type your query... e.g., 'How to build an API?'"
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    className="h-20 resize-none text-sm"
                    disabled={modelStatus !== 'ready'}
                  />
                  {selectedColumnInfo && localEmbeddings.currentModel && 
                   selectedColumnInfo.dimensions !== localEmbeddings.currentModel.dimensions && (
                    <p className="text-[10px] text-amber-500">
                      ⚠️ Dimension mismatch: column has {selectedColumnInfo.dimensions}d, 
                      model produces {localEmbeddings.currentModel.dimensions}d
                    </p>
                  )}
                  {selectedColumnInfo && !localEmbeddings.currentModel && (
                    <p className="text-[10px] text-muted-foreground">
                      💡 Pick a model with {selectedColumnInfo.dimensions}d for best results
                    </p>
                  )}
                </div>
              </div>
            )}

            <Separator />

            {/* Distance Metric */}
            <div className="space-y-2">
              <Label className="text-xs">Distance Metric</Label>
              <Select 
                value={distanceMetric} 
                onValueChange={(v) => setDistanceMetric(v as any)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DISTANCE_METRICS.map(metric => (
                    <SelectItem key={metric.value} value={metric.value}>
                      <div>
                        <div className="font-medium">{metric.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {metric.description}
                        </div>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Limit Slider */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Results Limit</Label>
                <span className="text-xs font-mono">{limit}</span>
              </div>
              <Slider
                value={[limit]}
                onValueChange={([v]) => setLimit(v)}
                min={1}
                max={100}
                step={1}
              />
            </div>

            <Separator />

            {/* Search Button */}
            <Button 
              className="w-full" 
              onClick={handleSearch}
              disabled={
                isSearching || 
                !selectedTable || 
                !selectedColumn ||
                (searchMode === 'text' && modelStatus !== 'ready')
              }
            >
              {isSearching ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Search className="w-4 h-4 mr-2" />
              )}
              Search Similar
            </Button>

            {selectedColumnInfo && (
              <div className="text-xs text-muted-foreground text-center">
                Searching {selectedColumnInfo.dimensions}-dimensional space
              </div>
            )}
            </div>
          </ScrollArea>
        )}
      </aside>

      {/* Right Panel - Results */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Results Header - matches TableEditor sticky header */}
        <div className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex items-center justify-between px-4 h-[52px]">
            <div className="flex items-center space-x-2">
              <Search className="h-4 w-4 text-primary/80" />
              <h1 className="text-sm font-semibold tracking-tight">Search Results</h1>
              {results.length > 0 && (
                <Badge variant="outline" className="ml-2 text-xs font-normal">
                  {results.length} {results.length === 1 ? 'row' : 'rows'}
                </Badge>
              )}
            </div>
            {results.length > 0 && (
              <div className="text-xs text-muted-foreground">
                Sorted by similarity (highest first)
              </div>
            )}
          </div>
        </div>

        {/* Results Table */}
        <div className="flex-1 overflow-hidden">
          <div className="h-full overflow-auto">
            {error ? (
              <div className="flex items-center justify-center h-64">
                <div className="text-center space-y-2">
                  <AlertCircle className="w-10 h-10 text-muted-foreground mx-auto" />
                  <p className="text-muted-foreground">{error}</p>
                </div>
              </div>
            ) : results.length === 0 ? (
              <div className="flex items-center justify-center h-64">
                <div className="text-center space-y-2">
                  <Search className="w-10 h-10 text-muted-foreground mx-auto" />
                  <p className="text-muted-foreground">
                    Select a table and column, then enter a row ID to search
                  </p>
                </div>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[180px] whitespace-nowrap sticky top-0 bg-background z-40 pl-4">
                      Similarity
                    </TableHead>
                    {displayColumns.slice(0, 5).map(col => (
                      <TableHead key={col} className="whitespace-nowrap sticky top-0 bg-background z-40">
                        {col}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((result, idx) => (
                    <TableRow key={idx} className="hover:bg-muted/30">
                      <TableCell className="whitespace-nowrap pl-4">
                        <SimilarityBar 
                          score={result.similarity} 
                          isDistance={distanceMetric !== '<=>'} 
                        />
                      </TableCell>
                      {displayColumns.slice(0, 5).map(col => (
                        <TableCell key={col} className="whitespace-nowrap max-w-[200px] truncate">
                          {formatCellValue(result.row[col], col)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SemanticSearch;
