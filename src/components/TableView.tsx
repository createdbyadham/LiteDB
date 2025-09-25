import { useState, useEffect, useCallback } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowUpDown, Search, Info, Database, ChevronLeft, ChevronRight, Save} from 'lucide-react';
import { ColumnInfo, RowData, dbService } from '@/lib/dbService';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { EditDialog } from '@/components/EditDialog';
import { toast } from '@/hooks/use-toast';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Portal } from '@radix-ui/react-portal';

interface TableViewProps {
  tableName: string;
  columns: string[];
  columnInfo: ColumnInfo[];
  rows: RowData[];
  onUpdateRow?: (oldRow: RowData, newRow: RowData) => Promise<boolean>;
}

const TableView = ({ tableName, columns, columnInfo, rows, onUpdateRow }: TableViewProps) => {
  const [filteredRows, setFilteredRows] = useState<RowData[]>([]);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [editingRow, setEditingRow] = useState<RowData | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const rowsPerPage = 100;
  
  // Reset state when table changes
  useEffect(() => {
    setFilteredRows([]);
    setSortColumn(null);
    setSortDirection('asc');
    setSearchQuery('');
    setCurrentPage(1);
  }, [tableName]);
  
  // Update filtered rows when data changes
  useEffect(() => {
    let result = [...rows];
    
    // Apply search filter
    if (searchQuery) {
      const lowerQuery = searchQuery.toLowerCase();
      result = result.filter(row => 
        Object.entries(row).some(([_, value]) => 
          String(value).toLowerCase().includes(lowerQuery)
        )
      );
    }
    
    // Apply sorting
    if (sortColumn) {
      result.sort((a, b) => {
        const valueA = a[sortColumn];
        const valueB = b[sortColumn];
        
        // Handle null values
        if (valueA === null && valueB === null) return 0;
        if (valueA === null) return sortDirection === 'asc' ? -1 : 1;
        if (valueB === null) return sortDirection === 'asc' ? 1 : -1;
        
        // Check if values are numbers
        const numA = Number(valueA);
        const numB = Number(valueB);
        
        if (!isNaN(numA) && !isNaN(numB)) {
          return sortDirection === 'asc' ? numA - numB : numB - numA;
        }
        
        // Otherwise sort as strings
        const strA = String(valueA);
        const strB = String(valueB);
        
        return sortDirection === 'asc' 
          ? strA.localeCompare(strB) 
          : strB.localeCompare(strA);
      });
    }
    
    setFilteredRows(result);
  }, [rows, searchQuery, sortColumn, sortDirection]);
  
  const handleSort = (column: string) => {
    if (sortColumn === column) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };
  
  const totalPages = Math.ceil(filteredRows.length / rowsPerPage);
  const paginatedRows = filteredRows.slice(
    (currentPage - 1) * rowsPerPage, 
    currentPage * rowsPerPage
  );
  
  // Map column names to their info
  const columnInfoMap = columnInfo.reduce((acc, info) => {
    acc[info.name] = info;
    return acc;
  }, {} as Record<string, ColumnInfo>);
  
  // Get the primary key column (if any)
  const primaryKeyColumn = columnInfo.find(col => col.pk === 1)?.name;
  
  const formatCellValue = (value: unknown) => {
    if (value === null) return <span className="text-muted-foreground italic">NULL</span>;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };
  
  const getColumnTypeLabel = (colName: string) => {
    const info = columnInfoMap[colName];
    if (!info) return null;
    
    const label = info.type || 'TEXT';
    
    const badges = [];
    
    if (info.pk) {
      badges.push(<Badge key="pk" variant="destructive" className="ml-1">PK</Badge>);
    }
    
    if (info.notnull) {
      badges.push(<Badge key="nn" variant="outline" className="ml-1">NOT NULL</Badge>);
    }
    
    return (
      <div className="flex items-center text-xs">
        <span className="text-muted-foreground">{label}</span>
        {badges}
      </div>
    );
  };

  const handleRowDoubleClick = (row: RowData) => {
    if (!onUpdateRow) return;
    // Create a copy of the row data to avoid reference issues
    setEditingRow({ ...row });
  };

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Delete' && selectedRows.size > 0) {
      setShowDeleteDialog(true);
    }
  }, [selectedRows]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleDeleteRows = async () => {
    try {
      if (!primaryKeyColumn) {
        throw new Error("No primary key found for this table");
      }

      const rowIds = Array.from(selectedRows);
      const success = await onUpdateRow?.(null, { type: 'delete', rowIds, primaryKeyColumn });

      if (success) {
        // Update the UI state
        const newRows = filteredRows.filter(row => {
          const rowId = String(row[primaryKeyColumn]);
          return !selectedRows.has(rowId);
        });
        setFilteredRows(newRows);
        setSelectedRows(new Set());
        toast({
          title: "Success",
          description: `${selectedRows.size} row(s) deleted successfully`,
        });
      }
    } catch (error) {
      console.error('Delete error:', error);
      toast({
        title: "Error",
        description: "Failed to delete rows",
        variant: "destructive"
      });
    } finally {
      setShowDeleteDialog(false);
    }
  };

  const handleRowUpdate = async (updatedRow: RowData) => {
    if (!editingRow || !onUpdateRow) return;
    
    try {
      const success = await onUpdateRow(editingRow, updatedRow);
      if (success) {
        toast({
          title: "Success",
          description: "Row updated successfully",
        });
        // Update the local state
        setFilteredRows(prev => 
          prev.map(row => {
            const primaryKey = columnInfo.find(col => col.pk === 1)?.name;
            if (primaryKey && row[primaryKey] === editingRow[primaryKey]) {
              return updatedRow;
            }
            return row;
          })
        );
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to update row",
        variant: "destructive"
      });
    } finally {
      setEditingRow(null);
    }
  };

  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex ml-2 items-center justify-between px-4 py-3">
          <div className="flex items-center space-x-2">
            <Database className="h-5 w-5 text-primary/80" />
            <h1 className="text-xl font-semibold tracking-tight">{tableName}</h1>
            <Badge variant="outline" className="ml-2">
              {filteredRows.length} {filteredRows.length === 1 ? 'row' : 'rows'}
            </Badge>
          </div>
          
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="h-10 px-2"
              onClick={async () => {
                const data = dbService.exportDatabase();
                console.log('Exporting database data:', data);
                if (data && window.electron) {
                  // If we don't have a current file path, show save dialog
                  if (!dbService.currentFilePath) {
                    toast({
                      title: "Error", 
                      description: "No database file loaded. Please load a database file first.",
                      variant: "destructive"
                    });
                    return;
                  }

                  console.log('Current file path:', dbService.currentFilePath);
                  const result = await window.electron.saveDatabase(dbService.currentFilePath, data);
                  console.log('Save result:', result);
                  if (result.success) {
                    toast({ title: "Success", description: "Database saved successfully" });
                  } else if (result.error !== 'Save cancelled') {
                    toast({ title: "Error", description: result.error || "Failed to save database", variant: "destructive" });
                  }
                }
              }}
            >
              <Save className= "h-4 w-4" />
              Save Changes
            </Button>
            <div className="relative w-64">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search table..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
        </div>
      </div>
      
      <div className="flex-1 overflow-hidden">
        <div className="h-full overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px] px-4 sticky top-0 bg-background z-40">
                  <div className="flex items-center h-full ml-2">
                    <Checkbox
                      checked={paginatedRows.length > 0 && paginatedRows.every(row =>
                        selectedRows.has(primaryKeyColumn ? String(row[primaryKeyColumn]) : String(row))
                      )}
                      onCheckedChange={(checked) => {
                        const newSelected = new Set(selectedRows);
                        paginatedRows.forEach(row => {
                          const rowId = primaryKeyColumn ? String(row[primaryKeyColumn]) : String(row);
                          if (checked) {
                            newSelected.add(rowId);
                          } else {
                            newSelected.delete(rowId);
                          }
                        });
                        setSelectedRows(newSelected);
                      }}
                      className="translate-y-[2px]"
                    />
                  </div>
                </TableHead>
                {columns.map((column) => (
                  <TableHead key={column} className="whitespace-nowrap sticky top-0 bg-background z-40">
                    <div className="flex items-center space-x-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSort(column)}
                        className="h-8 px-2 text-left font-medium"
                      >
                        {column}
                        {sortColumn === column && (
                          <ArrowUpDown 
                            className={`ml-1 h-3.5 w-3.5 transition-transform ${
                              sortDirection === 'desc' ? 'rotate-180' : ''
                            }`} 
                          />
                        )}
                      </Button>
                      
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6">
                              <Info className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          </TooltipTrigger>
                          <Portal>
                            <TooltipContent align="start" side="top" className="max-w-sm z-[9999]" sideOffset={5}>
                              {getColumnTypeLabel(column)}
                            </TooltipContent>
                          </Portal>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedRows.length > 0 ? (
                paginatedRows.map((row, rowIndex) => (
                  <TableRow 
                    key={primaryKeyColumn && row[primaryKeyColumn] ? String(row[primaryKeyColumn]) : rowIndex}
                    className="hover:bg-muted/30 cursor-pointer"
                    onDoubleClick={() => handleRowDoubleClick(row)}
                  >
                    <TableCell className="px-4 py-2">
                      <div className="flex items-center h-full ml-2">
                        <Checkbox
                          checked={selectedRows.has(primaryKeyColumn ? String(row[primaryKeyColumn]) : String(row))}
                          onCheckedChange={(checked) => {
                            const newSelected = new Set(selectedRows);
                            const rowId = primaryKeyColumn ? String(row[primaryKeyColumn]) : String(row);
                            if (checked) {
                              newSelected.add(rowId);
                            } else {
                              newSelected.delete(rowId);
                            }
                            setSelectedRows(newSelected);
                          }}
                        />
                      </div>
                    </TableCell>
                    {columns.map((column) => (
                      <TableCell key={column} className="whitespace-nowrap">
                        {formatCellValue(row[column])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell 
                    colSpan={columns.length + 1} 
                    className="h-32 text-center text-muted-foreground"
                  >
                    No results found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t bg-background">
          <div className="text-sm text-muted-foreground">
            Page {currentPage} of {totalPages}
          </div>
          
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <EditDialog
        open={editingRow !== null}
        onOpenChange={(open) => !open && setEditingRow(null)}
        row={editingRow ?? {}}
        columns={columns}
        columnInfo={columnInfo}
        onSave={handleRowUpdate}
      />

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action will delete {selectedRows.size} selected row(s). This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteRows}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TableView;
