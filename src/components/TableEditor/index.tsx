import { useState, useEffect, useCallback, useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ArrowUpDown, Search, Info, Database, ChevronLeft, ChevronRight, ScanSearch, KeyRound } from 'lucide-react';
import { ColumnInfo, RowData } from '@/lib/sqliteService';
import { primaryKeyColumns, type TableQuery } from '@/lib/types';
import { VectorColumnInfo } from '@/lib/pgService';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { 
  ContextMenu, 
  ContextMenuContent, 
  ContextMenuItem, 
  ContextMenuSeparator,
  ContextMenuTrigger 
} from '@/components/ui/context-menu';
import { EditDialog } from '@/components/EditDialog';
import { VectorBadge } from '@/components/VectorAdmin/VectorBadge';
import { toast } from '@/hooks/use-toast';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Portal } from '@radix-ui/react-portal';

interface TableViewProps {
  tableName: string;
  columns: string[];
  columnInfo: ColumnInfo[];
  /** The current page only. Paging, search and sort run in SQL. */
  rows: RowData[];
  /** Rows matching the search across every page. */
  totalRows: number;
  query: TableQuery;
  onQueryChange: (query: TableQuery) => void;
  /** Hidden column that addresses rows when the table has no primary key. */
  rowLocator?: string;
  /** Views: rows can be read, not edited or deleted. */
  readOnly?: boolean;
  onUpdateRow?: (oldRow: RowData, newRow: RowData) => Promise<boolean>;
  onDeleteRows?: (rows: RowData[]) => Promise<boolean>;
  // Vector support
  vectorColumns?: VectorColumnInfo[];
  onInspectVector?: (value: unknown, columnName: string, rowId?: string | number, tableName?: string) => void;
  onFindSimilar?: (row: RowData) => void;
}

/** True while focus is in something you type into, where Delete edits text. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

const TableEditor = ({
  tableName,
  columns,
  columnInfo,
  rows,
  totalRows,
  query,
  onQueryChange,
  rowLocator,
  readOnly = false,
  onUpdateRow,
  onDeleteRows,
  vectorColumns = [],
  onInspectVector,
  onFindSimilar
}: TableViewProps) => {
  const [searchInput, setSearchInput] = useState(query.search ?? '');
  const [editingRow, setEditingRow] = useState<RowData | null>(null);
  /** Selected rows by key, kept across pages so a delete can span them. */
  const [selectedRows, setSelectedRows] = useState<Map<string, RowData>>(new Map());
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const sortColumn = query.sortColumn ?? null;
  const sortDirection = query.sortDirection ?? 'asc';
  const currentPage = Math.floor(query.offset / query.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(totalRows / query.limit));
  const paginatedRows = rows;

  // Search runs a query per keystroke otherwise; wait for a short pause.
  useEffect(() => {
    if (searchInput === (query.search ?? '')) return;
    const timer = setTimeout(() => {
      onQueryChange({ ...query, search: searchInput, offset: 0 });
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput, query, onQueryChange]);

  const handleSort = (column: string) => {
    const direction = sortColumn === column && sortDirection === 'asc' ? 'desc' : 'asc';
    onQueryChange({ ...query, sortColumn: column, sortDirection: direction, offset: 0 });
  };

  const goToPage = (page: number) => {
    const clamped = Math.min(Math.max(page, 1), totalPages);
    onQueryChange({ ...query, offset: (clamped - 1) * query.limit });
  };

  // Every key column, so tables keyed by two columns address one row.
  const keyColumns = useMemo(() => primaryKeyColumns(columnInfo), [columnInfo]);
  const rowKey = useCallback(
    (row: RowData) => keyColumns.length > 0
      ? JSON.stringify(keyColumns.map(col => row[col.name] ?? null))
      : JSON.stringify(rowLocator ? row[rowLocator] ?? null : null),
    [keyColumns, rowLocator],
  );
  const canAddressRows = !readOnly && (keyColumns.length > 0 || !!rowLocator);

  // Map column names to their info
  const columnInfoMap = columnInfo.reduce((acc, info) => {
    acc[info.name] = info;
    return acc;
  }, {} as Record<string, ColumnInfo>);

  // First key column, for the vector tools that take a single row id.
  const primaryKeyColumn = keyColumns[0]?.name;

  // Check if a column is a vector column
  const getVectorColumnInfo = (columnName: string): VectorColumnInfo | undefined => {
    return vectorColumns.find(vc => vc.tableName === tableName && vc.columnName === columnName);
  };

  // Check if the table has any vector columns (for showing Find Similar option)
  const hasVectorColumns = vectorColumns.some(vc => vc.tableName === tableName);

  const formatCellValue = (value: unknown, columnName?: string, row?: RowData) => {
    if (value === null) return <span className="text-muted-foreground italic">NULL</span>;
    
    // Check if this column is a vector column
    if (columnName) {
      const vecInfo = getVectorColumnInfo(columnName);
      if (vecInfo) {
        const rowId = primaryKeyColumn && row ? row[primaryKeyColumn] as string | number | undefined : undefined;
        return (
          <VectorBadge
            value={value}
            dimensions={vecInfo.dimensions}
            onClick={() => onInspectVector?.(value, columnName, rowId, tableName)}
          />
        );
      }
    }
    
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const getColumnTypeLabel = (colName: string) => {
    const info = columnInfoMap[colName];
    if (!info) return null;

    const label = info.type || 'TEXT';

    const badges = [];

    if (info.pk) {
      badges.push(<span key="pk" className="ml-2 inline-flex items-center gap-1 text-key"><KeyRound className="h-3 w-3" />primary key</span>);
    }

    if (info.notnull) {
      badges.push(<span key="nn" className="ml-2 text-muted-foreground">not null</span>);
    }

    return (
      <div className="flex items-center text-xs">
        <span className="font-mono text-muted-foreground">{label}</span>
        {badges}
      </div>
    );
  };

  const handleRowDoubleClick = (row: RowData) => {
    if (!onUpdateRow) return;
    if (!canAddressRows) {
      toast({
        title: "Row can't be edited here",
        description: readOnly
          ? `${tableName} is a view, so it is read-only`
          : "This table has no primary key, so a single row cannot be addressed. Use the SQL editor",
      });
      return;
    }
    // Create a copy of the row data to avoid reference issues
    setEditingRow({ ...row });
  };

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Delete in the search box, a dialog or the SQL editor edits text; it must
    // not offer to delete the rows that happen to be ticked.
    if (e.key !== 'Delete' || selectedRows.size === 0) return;
    if (isTypingTarget(e.target) || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    setShowDeleteDialog(true);
  }, [selectedRows]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const toggleRow = (row: RowData, checked: boolean) => {
    setSelectedRows(prev => {
      const next = new Map(prev);
      if (checked) next.set(rowKey(row), row);
      else next.delete(rowKey(row));
      return next;
    });
  };

  const handleDeleteRows = async () => {
    try {
      if (!canAddressRows) {
        throw new Error("This table has no primary key, so rows cannot be addressed. Use the SQL editor");
      }
      const count = selectedRows.size;
      const success = await onDeleteRows?.(Array.from(selectedRows.values()));
      if (success) {
        setSelectedRows(new Map());
        toast({
          title: "Deleted",
          description: `${count.toLocaleString()} ${count === 1 ? 'row' : 'rows'} deleted`,
        });
      }
    } catch (error) {
      console.error('Delete error:', error);
      toast({
        title: "Rows not deleted",
        description: error instanceof Error ? error.message : "Failed to delete rows",
        variant: "destructive"
      });
    } finally {
      setShowDeleteDialog(false);
    }
  };

  const handleRowUpdate = async (updatedRow: RowData) => {
    if (!editingRow || !onUpdateRow) return;
    try {
      // The parent re-reads the page after a successful write.
      await onUpdateRow(editingRow, updatedRow);
    } finally {
      setEditingRow(null);
    }
  };

  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="sticky top-0 z-40 border-b bg-background">
        <div className="flex items-center justify-between px-4 h-12">
          <div className="flex items-center space-x-2">
            <Database strokeWidth={1.5} className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-sm font-medium">{tableName}</h1>
            {readOnly && <span className="text-xs text-muted-foreground">view · read-only</span>}
            <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">
              {totalRows.toLocaleString()} {totalRows === 1 ? 'row' : 'rows'}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative w-64">
              <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search rows"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-8 h-8 text-xs"
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
                      disabled={!canAddressRows}
                      checked={canAddressRows && paginatedRows.length > 0 && paginatedRows.every(row => selectedRows.has(rowKey(row)))}
                      onCheckedChange={(checked) => paginatedRows.forEach(row => toggleRow(row, checked === true))}
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
                        className="h-8 px-2 text-left font-medium text-muted-foreground hover:text-foreground"
                      >
                        {columnInfoMap[column]?.pk ? (
                          <KeyRound className="mr-1.5 h-3.5 w-3.5 text-key" aria-label="Primary key" />
                        ) : null}
                        {column}
                        {sortColumn === column && (
                          <ArrowUpDown
                            className={`ml-1 h-3.5 w-3.5 transition-transform ${sortDirection === 'desc' ? 'rotate-180' : ''
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
                  <ContextMenu key={canAddressRows ? rowKey(row) : rowIndex}>
                    <ContextMenuTrigger asChild>
                      <TableRow
                        className="hover:bg-muted/30 cursor-pointer"
                        onDoubleClick={() => handleRowDoubleClick(row)}
                      >
                        <TableCell className="px-4 py-2">
                          <div className="flex items-center h-full ml-2">
                            <Checkbox
                              disabled={!canAddressRows}
                              checked={selectedRows.has(rowKey(row))}
                              onCheckedChange={(checked) => toggleRow(row, checked === true)}
                            />
                          </div>
                        </TableCell>
                        {columns.map((column) => (
                          <TableCell key={column} className="whitespace-nowrap pl-6 tabular-nums">
                            {formatCellValue(row[column], column, row)}
                          </TableCell>
                        ))}
                      </TableRow>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onClick={() => handleRowDoubleClick(row)}>
                        Edit row
                      </ContextMenuItem>
                      {hasVectorColumns && onFindSimilar && (
                        <>
                          <ContextMenuSeparator />
                          <ContextMenuItem onClick={() => onFindSimilar(row)}>
                            <ScanSearch className="w-4 h-4 mr-2" />
                            Find similar rows
                          </ContextMenuItem>
                        </>
                      )}
                    </ContextMenuContent>
                  </ContextMenu>
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
            <span className="tabular-nums">
              {totalRows === 0 ? 0 : (query.offset + 1).toLocaleString()}–{Math.min(query.offset + query.limit, totalRows).toLocaleString()} of {totalRows.toLocaleString()}
            </span>
            <span className="ml-3 text-muted-foreground/70 tabular-nums">Page {currentPage.toLocaleString()} of {totalPages.toLocaleString()}</span>
          </div>

          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => goToPage(currentPage - 1)}
              disabled={currentPage <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={() => goToPage(currentPage + 1)}
              disabled={currentPage >= totalPages}
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
            <AlertDialogTitle>Delete {selectedRows.size.toLocaleString()} {selectedRows.size === 1 ? 'row' : 'rows'}?</AlertDialogTitle>
            <AlertDialogDescription>
              They are removed from {tableName}. This can't be undone.
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

export default TableEditor;
