import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import TableView from '@/components/TableView';
import BatchOperations from '@/components/QueryEditor';
import { useDatabase } from '@/hooks/useDatabase';
import { usePostgres } from '@/hooks/usePostgres';
import { dbService, RowData, ColumnInfo } from '@/lib/dbService';
import { pgService } from '@/lib/pgService';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Database, ArrowLeft, Save, Download, Server } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { ExportDialog } from '@/components/ExportDialog';
import TableSidebar from '@/components/TableSidebar';

const DatabaseView = () => {
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [tableColumns, setTableColumns] = useState<ColumnInfo[]>([]);
  const [tableData, setTableData] = useState<{ columns: string[], rows: RowData[] }>({ columns: [], rows: [] });
  const [loading, setLoading] = useState(false);
  
  // SQLite hooks
  const { isLoaded, isLoading, tables: sqliteTables, getTableData: getSqliteTableData, getTableColumns: getSqliteTableColumns, refreshTables: refreshSqliteTables } = useDatabase();
  // PostgreSQL hooks
  const { isConnected, isConnecting, tables: postgresTables, getTableData: getPostgresTableData, getTableColumns: getPostgresTableColumns, disconnect: disconnectPostgres, refreshTables: refreshPostgresTables } = usePostgres();
  
  const navigate = useNavigate();
  
  // Determine which database type is active
  const isPostgresActive = isConnected;
  const isSqliteActive = isLoaded && !isPostgresActive;
  
  // Combined tables from active source
  const tables = isPostgresActive ? postgresTables : sqliteTables;
  
  // Check if any database is available
  const databaseAvailable = isPostgresActive || isSqliteActive;
  const isLoadingDatabase = isLoading || isConnecting;

  // Memoize the getTableData and getTableColumns functions to prevent infinite loops
  const getTableData = useCallback(async (tableName: string) => {
    if (isPostgresActive) {
      return await getPostgresTableData(tableName);
    } else {
      return getSqliteTableData(tableName);
    }
  }, [isPostgresActive, getPostgresTableData, getSqliteTableData]);

  const getTableColumns = useCallback(async (tableName: string) => {
    if (isPostgresActive) {
      return await getPostgresTableColumns(tableName);
    } else {
      return getSqliteTableColumns(tableName);
    }
  }, [isPostgresActive, getPostgresTableColumns, getSqliteTableColumns]);

  // Effect to load table data when a table is selected
  useEffect(() => {
    // Skip the effect if no table is selected
    if (!selectedTable) return;
    
    let mounted = true;
    console.log(`Loading data for table: ${selectedTable}`);

    const loadTableData = async () => {
      if (mounted) setLoading(true);
      
      try {
        // Get table columns
        const columns = await getTableColumns(selectedTable);
        if (!mounted) return;
        setTableColumns(columns);
        
        // Get table data
        const data = await getTableData(selectedTable);
        if (!mounted) return;
        setTableData(data);
      } catch (error) {
        console.error('Error loading table data:', error);
        if (mounted) {
          toast({
            title: 'Error',
            description: 'Failed to load table data',
            variant: 'destructive'
          });
        }
      } finally {
        if (mounted) setLoading(false);
      }
    };
    
    // Use requestAnimationFrame to ensure the loading state is applied first
    const frameId = requestAnimationFrame(() => {
      loadTableData();
    });
    
    return () => {
      mounted = false;
      cancelAnimationFrame(frameId);
    };
  }, [selectedTable]);  // Only depend on selectedTable, not the functions

  const handleBackClick = () => {
    // Disconnect PostgreSQL if connected before navigating
    if (isPostgresActive) {
      disconnectPostgres();
    }
    navigate('/', { replace: true });
  };

  interface DeleteOperation {
    type: 'delete';
    rowIds: string[];
    primaryKeyColumn: string;
  }

  function isDeleteOperation(value: unknown): value is DeleteOperation {
    if (value === null || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    const typeValue = (obj as { type?: unknown }).type;
    const rowIds = (obj as { rowIds?: unknown }).rowIds;
    const primaryKeyColumn = (obj as { primaryKeyColumn?: unknown }).primaryKeyColumn;
    return typeValue === 'delete' && Array.isArray(rowIds) && typeof primaryKeyColumn === 'string';
  }

  const handleUpdateRow = async (oldRow: RowData | null, newRow: RowData | DeleteOperation): Promise<boolean> => {
    if (!selectedTable) return false;
    
    if (isPostgresActive) {
      try {
        if (isDeleteOperation(newRow)) {
          // Handle PostgreSQL delete
          return await pgService.deleteRows(selectedTable, newRow.primaryKeyColumn, newRow.rowIds);
        } else if (oldRow) {
          // Handle PostgreSQL update
          return await pgService.updateRow(selectedTable, oldRow, newRow as RowData);
        }
        return false;
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to update/delete PostgreSQL row(s)",
          variant: "destructive"
        });
        return false;
      }
    } else {
      // SQLite operations
      if (isDeleteOperation(newRow)) {
        // Handle SQLite delete
        const sql = `DELETE FROM ${selectedTable} WHERE ${newRow.primaryKeyColumn} IN (${newRow.rowIds.map(id => `'${id}'`).join(',')})`;
        const result = dbService.executeBatchOperations([sql]);
        return result.success;
      } else if (oldRow) {
        // Handle SQLite update
        return dbService.updateRow(selectedTable, oldRow, newRow as RowData);
      }
      return false;
    }
  };

  const handleSaveDatabase = async () => {
    if (isPostgresActive) {
      // PostgreSQL databases don't need to be saved locally
      toast({
        title: "Information",
        description: "PostgreSQL databases are saved on the server automatically",
      });
      return;
    }
    
    // SQLite save logic
    const data = dbService.exportDatabase();
    if (!data) {
      toast({
        title: "Error",
        description: "No database changes to save",
        variant: "destructive"
      });
      return;
    }

    if (!dbService.currentFilePath || !window.electron) {
      toast({
        title: "Error",
        description: "No database file loaded. Please load a database file first.",
        variant: "destructive"
      });
      return;
    }

    try {
      const result = await window.electron.saveDatabase(dbService.currentFilePath, data);
      if (result.success) {
        toast({
          title: "Success",
          description: "Database saved successfully"
        });
      } else {
        toast({
          title: "Error",
          description: result.error || "Failed to save database",
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to save database",
        variant: "destructive"
      });
    }
  };

  if (isLoadingDatabase) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4 ml-4">
          <Database className="w-16 h-16 text-muted-foreground/50 mx-auto animate-pulse" />
          <h2 className="text-xl font-medium">Loading database...</h2>
        </div>
      </div>
    );
  }

  if (!databaseAvailable) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4 ml-4">
          <Database className="w-16 h-16 text-muted-foreground/50 mx-auto" />
          <h2 className="text-xl font-medium">No database loaded</h2>
          <p className="text-muted-foreground">
            Please load a database file or connect to PostgreSQL to continue
          </p>
          <Button onClick={handleBackClick} variant="outline">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Upload
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col py-2 animate-fade-in">
      <div className="flex items-center justify-between mb-4 sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center ml-2">
          <Button variant="ghost" onClick={handleBackClick}>
            <ArrowLeft className="h-2 w-2" />
          </Button>
          {isPostgresActive && (
            <div className="ml-4 flex items-center text-sm text-muted-foreground">
              <Server className="w-4 h-4 mr-1" />
              <span>PostgreSQL: {pgService.currentConfig?.database}@{pgService.currentConfig?.host}</span>
            </div>
          )}
        </div>
        <div className="flex gap-2 mr-4">
          {isSqliteActive && (
            <Button onClick={handleSaveDatabase} variant="outline">
              <Save className="mr-2 h-4 w-4" />
              Save
            </Button>
          )}
          <Button onClick={() => setExportDialogOpen(true)} variant="outline">
            <Download className="mr-2 h-4 w-4" />
            Export
          </Button>
        </div>
      </div>

      <Tabs defaultValue="browse" className="h-[calc(100vh-120px)] flex flex-col">
        <TabsList className="mb-2 sticky top-14 z-40 bg-background">
          <TabsTrigger value="browse">Browse</TabsTrigger>
          <TabsTrigger value="query">Batch Operations</TabsTrigger>
        </TabsList>
        
        <TabsContent value="browse" className="flex-1 h-full overflow-hidden animate-fade-in">
          <div className="flex h-full">
            <TableSidebar 
              tables={tables}
              activeTable={selectedTable}
              onSelectTable={(tableName) => {
                if (tableName === selectedTable) return; // Skip if already selected
                
                // Reset data first, then set the selected table
                setTableColumns([]);
                setTableData({ columns: [], rows: [] });
                setLoading(true); // Set loading immediately
                
                // Use setTimeout to ensure state updates are batched properly
                setTimeout(() => {
                  setSelectedTable(tableName);
                }, 0);
              }}
              collapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            />
            
            <div className={`flex-1 overflow-hidden`}>
              {selectedTable ? (
                <div className="h-full flex flex-col">
                  {loading ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
                    </div>
                  ) : (
                    <TableView 
                      key={selectedTable}
                      tableName={selectedTable}
                      columns={tableData.columns}
                      rows={tableData.rows}
                      columnInfo={tableColumns}
                      onUpdateRow={handleUpdateRow}
                    />
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <p>Select a table to view its data</p>
                </div>
              )}
            </div>
          </div>
        </TabsContent>
        
        <TabsContent value="query" className="flex-1 overflow-hidden">
          <BatchOperations 
            isPostgres={isPostgresActive} 
            refreshTables={isPostgresActive ? refreshPostgresTables : refreshSqliteTables} 
            onAutosave={handleSaveDatabase}
          />
        </TabsContent>
      </Tabs>

      <ExportDialog 
        open={exportDialogOpen} 
        onOpenChange={setExportDialogOpen} 
        isPostgres={isPostgresActive}
      />
    </div>
  );
};

export default DatabaseView;
