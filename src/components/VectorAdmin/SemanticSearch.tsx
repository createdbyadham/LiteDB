import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
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
  ArrowRight,
  AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { VectorColumnInfo, SimilarityResult } from '@/lib/pgService';
import { VectorBadge } from './VectorBadge';

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
  getTableColumns,
  onInspectVector
}: SemanticSearchProps) => {
  // Search mode: 'id' or 'text' (text requires external embedding)
  const [searchMode, setSearchMode] = useState<'id'>('id');
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [selectedColumn, setSelectedColumn] = useState<string>('');
  const [rowIdInput, setRowIdInput] = useState('');
  const [distanceMetric, setDistanceMetric] = useState<'<=>' | '<->' | '<#>'>('<=>');
  const [limit, setLimit] = useState(10);
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SimilarityResult[]>([]);
  const [primaryKeyColumn, setPrimaryKeyColumn] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

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
    if (!selectedTable || !selectedColumn || !rowIdInput.trim()) {
      toast({
        title: "Missing Input",
        description: "Please select a table, column, and enter a row ID",
        variant: "destructive"
      });
      return;
    }

    setIsSearching(true);
    setError(null);
    setResults([]);

    try {
      const searchResults = await findSimilarByRowId(
        selectedTable,
        selectedColumn,
        primaryKeyColumn,
        rowIdInput.trim(),
        limit,
        distanceMetric
      );
      
      setResults(searchResults);
      
      if (searchResults.length === 0) {
        setError('No similar rows found. Check that the row ID exists and has a valid vector.');
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
      <div className="w-80 border-r bg-muted/20 p-4 space-y-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Search className="w-5 h-5 text-primary" />
            <h2 className="font-semibold">Semantic Search</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Find similar rows using vector similarity
          </p>
        </div>

        <Separator />

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
              variant="outline"
              size="sm"
              className="flex-1"
              disabled
              title="Requires external embedding API"
            >
              <Type className="w-3.5 h-3.5 mr-1.5" />
              By Text
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            "By Text" requires connecting to Ollama/OpenAI (coming soon)
          </p>
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
          disabled={isSearching || !selectedTable || !selectedColumn}
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

      {/* Right Panel - Results */}
      <div className="flex-1 flex flex-col">
        {/* Results Header */}
        <div className="p-4 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">Results</h3>
              {results.length > 0 && (
                <Badge variant="secondary">{results.length} rows</Badge>
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
        <ScrollArea className="flex-1">
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
                  <TableHead className="w-[150px] sticky left-0 bg-background">
                    Similarity
                  </TableHead>
                  {displayColumns.slice(0, 5).map(col => (
                    <TableHead key={col} className="min-w-[100px]">
                      {col}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.map((result, idx) => (
                  <TableRow key={idx}>
                    <TableCell className="sticky left-0 bg-background">
                      <SimilarityBar 
                        score={result.similarity} 
                        isDistance={distanceMetric !== '<=>'} 
                      />
                    </TableCell>
                    {displayColumns.slice(0, 5).map(col => (
                      <TableCell key={col} className="max-w-[200px] truncate">
                        {formatCellValue(result.row[col], col)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </ScrollArea>
      </div>
    </div>
  );
};

export default SemanticSearch;
