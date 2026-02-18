import { useState, useEffect, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import { Loader2, Search, Box } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SimilarityResult, VectorColumnInfo } from '@/lib/pgService';
import { RowData } from '@/lib/sqliteService';
import { VectorBadge } from './VectorBadge';

interface SimilarRowsModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceRow: RowData | null;
  tableName: string;
  primaryKeyColumn: string;
  vectorColumns: VectorColumnInfo[];
  findSimilarByRowId: (
    tableName: string,
    vectorColumn: string,
    primaryKeyColumn: string,
    rowId: string | number,
    limit?: number,
    distanceMetric?: '<=>' | '<->' | '<#>'
  ) => Promise<SimilarityResult[]>;
  onInspectVector?: (value: unknown, columnName: string, rowId?: string | number, tableName?: string) => void;
}

// Distance metric options
const DISTANCE_METRICS = [
  { value: '<=>', label: 'Cosine' },
  { value: '<->', label: 'L2' },
  { value: '<#>', label: 'Inner Product' },
] as const;

// Similarity bar component
const SimilarityBar = ({ score }: { score: number }) => {
  const percentage = Math.min(100, Math.max(0, score * 100));
  
  const getColorClass = () => {
    if (percentage >= 80) return 'bg-green-500';
    if (percentage >= 60) return 'bg-lime-500';
    if (percentage >= 40) return 'bg-yellow-500';
    if (percentage >= 20) return 'bg-orange-500';
    return 'bg-red-500';
  };
  
  return (
    <div className="flex items-center gap-2 min-w-[100px]">
      <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
        <div 
          className={cn("h-full transition-all", getColorClass())}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="text-xs font-mono w-10 text-right">
        {score.toFixed(2)}
      </span>
    </div>
  );
};

export const SimilarRowsModal = ({
  isOpen,
  onClose,
  sourceRow,
  tableName,
  primaryKeyColumn,
  vectorColumns,
  findSimilarByRowId,
  onInspectVector
}: SimilarRowsModalProps) => {
  const [selectedVectorColumn, setSelectedVectorColumn] = useState<string>('');
  const [distanceMetric, setDistanceMetric] = useState<'<=>' | '<->' | '<#>'>('<=>');
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<SimilarityResult[]>([]);

  // Get vector columns for this table
  const tableVectorColumns = useMemo(() => {
    return vectorColumns.filter(vc => vc.tableName === tableName);
  }, [vectorColumns, tableName]);

  // Auto-select first vector column
  useEffect(() => {
    if (tableVectorColumns.length > 0 && !selectedVectorColumn) {
      setSelectedVectorColumn(tableVectorColumns[0].columnName);
    }
  }, [tableVectorColumns, selectedVectorColumn]);

  // Run search when modal opens or parameters change
  useEffect(() => {
    if (!isOpen || !sourceRow || !selectedVectorColumn || !primaryKeyColumn) {
      return;
    }

    const rowId = sourceRow[primaryKeyColumn];
    if (rowId === undefined || rowId === null) {
      return;
    }

    const runSearch = async () => {
      setIsLoading(true);
      try {
        const searchResults = await findSimilarByRowId(
          tableName,
          selectedVectorColumn,
          primaryKeyColumn,
          rowId,
          10,
          distanceMetric
        );
        setResults(searchResults);
      } catch (e) {
        console.error('Similar search error:', e);
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    };

    runSearch();
  }, [isOpen, sourceRow, selectedVectorColumn, distanceMetric, tableName, primaryKeyColumn, findSimilarByRowId]);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setResults([]);
    }
  }, [isOpen]);

  // Get display columns
  const displayColumns = useMemo(() => {
    if (results.length === 0) return [];
    const firstRow = results[0].row;
    return Object.keys(firstRow).filter(col => 
      col !== 'distance' && 
      col !== 'similarity' &&
      !vectorColumns.some(vc => vc.columnName === col)
    ).slice(0, 4); // Limit columns for cleaner display
  }, [results, vectorColumns]);

  // Format cell value
  const formatCellValue = (value: unknown, columnName: string) => {
    if (value === null || value === undefined) {
      return <span className="text-muted-foreground italic">NULL</span>;
    }
    
    const vecCol = vectorColumns.find(vc => vc.columnName === columnName);
    if (vecCol) {
      return (
        <VectorBadge
          value={value}
          dimensions={vecCol.dimensions}
          onClick={() => onInspectVector?.(value, columnName, undefined, tableName)}
        />
      );
    }
    
    const str = String(value);
    return str.length > 30 ? str.slice(0, 30) + '...' : str;
  };

  const sourceRowId = sourceRow?.[primaryKeyColumn];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="w-5 h-5" />
            Find Similar Rows
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Source Row Info */}
          <div className="flex items-center gap-4 p-3 bg-muted/50 rounded-lg">
            <div className="text-sm">
              <span className="text-muted-foreground">Source Row:</span>{' '}
              <span className="font-mono font-medium">{primaryKeyColumn} = {String(sourceRowId)}</span>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2">
              <Select
                value={selectedVectorColumn}
                onValueChange={setSelectedVectorColumn}
              >
                <SelectTrigger className="w-[180px] h-8">
                  <SelectValue placeholder="Vector column" />
                </SelectTrigger>
                <SelectContent>
                  {tableVectorColumns.map(col => (
                    <SelectItem key={col.columnName} value={col.columnName}>
                      <div className="flex items-center gap-2">
                        <Box className="w-3 h-3" />
                        {col.columnName}
                        <Badge variant="outline" className="text-[10px]">
                          {col.dimensions}d
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={distanceMetric}
                onValueChange={(v) => setDistanceMetric(v as any)}
              >
                <SelectTrigger className="w-[120px] h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DISTANCE_METRICS.map(m => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Results */}
          <div className="border rounded-lg">
            <ScrollArea className="h-[400px]">
              {isLoading ? (
                <div className="flex items-center justify-center h-64">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : results.length === 0 ? (
                <div className="flex items-center justify-center h-64">
                  <div className="text-center text-muted-foreground">
                    <Search className="w-10 h-10 mx-auto mb-2 opacity-50" />
                    <p>No similar rows found</p>
                  </div>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[130px]">Similarity</TableHead>
                      {displayColumns.map(col => (
                        <TableHead key={col}>{col}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {results.map((result, idx) => (
                      <TableRow key={idx}>
                        <TableCell>
                          <SimilarityBar score={result.similarity} />
                        </TableCell>
                        {displayColumns.map(col => (
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

          {/* Footer */}
          <div className="flex justify-between items-center text-xs text-muted-foreground">
            <div>
              Showing top 10 nearest neighbors
            </div>
            <Button variant="outline" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SimilarRowsModal;
