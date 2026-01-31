import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import TableView from '@/components/TableView';
import BatchOperations from '@/components/QueryEditor';
import SchemaVisualizer from '@/components/SchemaVisualizer';
import AppLayout from '@/components/AppLayout';
import StatusBar from '@/components/StatusBar';
import { useDatabase } from '@/hooks/useDatabase';
import { usePostgres } from '@/hooks/usePostgres';
import { useSidebar } from '@/contexts/SidebarContext';
import { dbService, RowData, ColumnInfo } from '@/lib/dbService';
import { pgService } from '@/lib/pgService';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { 
  Database, 
  Save, 
  Download, 
  Server,
  Table2,
  Search,
  RefreshCw,
  ChevronRight,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { ExportDialog } from '@/components/ExportDialog';
import { cn } from '@/lib/utils';

const DatabaseView = () => {
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [tableColumns, setTableColumns] = useState<ColumnInfo[]>([]);
  const [tableData, setTableData] = useState<{ columns: string[], rows: RowData[] }>({ columns: [], rows: [] });
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('browse');
  const [searchQuery, setSearchQuery] = useState('');
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const { contentSidebarCollapsed: sidebarCollapsed, toggleContentSidebar } = useSidebar();
  
  // SQLite hooks
  const { 
    isLoaded, 
    isLoading, 
    tables: sqliteTables, 
    getTableData: getSqliteTableData, 
    getTableColumns: getSqliteTableColumns,
    getForeignKeys: getSqliteForeignKeys,
    getIndexes: getSqliteIndexes,
    refreshTables: refreshSqliteTables 
  } = useDatabase();
  
  // PostgreSQL hooks
  const { 
    isConnected, 
    isConnecting, 
    tables: postgresTables, 
    getTableData: getPostgresTableData, 
    getTableColumns: getPostgresTableColumns,
    getForeignKeys: getPostgresForeignKeys,
    getIndexes: getPostgresIndexes,
    disconnect: disconnectPostgres, 
    refreshTables: refreshPostgresTables 
  } = usePostgres();
  
  const navigate = useNavigate();
  
  // Determine which database type is active
  const isPostgresActive = isConnected;
  const isSqliteActive = isLoaded && !isPostgresActive;
  
  // Combined tables from active source
  const tables = isPostgresActive ? postgresTables : sqliteTables;
  
  // Check if any database is available
  const databaseAvailable = isPostgresActive || isSqliteActive;
  const isLoadingDatabase = isLoading || isConnecting;

  // Get database name
  const databaseName = isPostgresActive 
    ? pgService.currentConfig?.database || 'PostgreSQL'
    : dbService.currentFilePath?.split(/[/\\]/).pop() || 'SQLite';

  // Filter tables based on search
  const filteredTables = tables.filter(table => 
    table.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Store the postgres active state in a ref to avoid dependency issues
  const isPostgresActiveRef = useRef(isPostgresActive);
  isPostgresActiveRef.current = isPostgresActive;

  // Store hook functions in refs to avoid dependency issues
  const sqliteFuncsRef = useRef({
    getTableData: getSqliteTableData,
    getTableColumns: getSqliteTableColumns,
    getForeignKeys: getSqliteForeignKeys,
    getIndexes: getSqliteIndexes,
  });
  sqliteFuncsRef.current = {
    getTableData: getSqliteTableData,
    getTableColumns: getSqliteTableColumns,
    getForeignKeys: getSqliteForeignKeys,
    getIndexes: getSqliteIndexes,
  };

  const postgresFuncsRef = useRef({
    getTableData: getPostgresTableData,
    getTableColumns: getPostgresTableColumns,
    getForeignKeys: getPostgresForeignKeys,
    getIndexes: getPostgresIndexes,
  });
  postgresFuncsRef.current = {
    getTableData: getPostgresTableData,
    getTableColumns: getPostgresTableColumns,
    getForeignKeys: getPostgresForeignKeys,
    getIndexes: getPostgresIndexes,
  };

  // Stable function references for schema visualizer
  const getTableColumnsStable = useCallback((tableName: string) => {
    if (isPostgresActiveRef.current) {
      return postgresFuncsRef.current.getTableColumns(tableName);
    } else {
      return sqliteFuncsRef.current.getTableColumns(tableName);
    }
  }, []);

  const getForeignKeysStable = useCallback((tableName: string) => {
    if (isPostgresActiveRef.current) {
      return postgresFuncsRef.current.getForeignKeys(tableName);
    } else {
      return sqliteFuncsRef.current.getForeignKeys(tableName);
    }
  }, []);

  const getIndexesStable = useCallback((tableName: string) => {
    if (isPostgresActiveRef.current) {
      return postgresFuncsRef.current.getIndexes(tableName);
    } else {
      return sqliteFuncsRef.current.getIndexes(tableName);
    }
  }, []);

  // Effect to load table data when a table is selected
  useEffect(() => {
    if (!selectedTable) return;
    
    let mounted = true;

    const loadTableData = async () => {
      if (mounted) setLoading(true);
      
      try {
        let columns, data;
        
        if (isPostgresActiveRef.current) {
          [columns, data] = await Promise.all([
            postgresFuncsRef.current.getTableColumns(selectedTable),
            postgresFuncsRef.current.getTableData(selectedTable),
          ]);
        } else {
          columns = sqliteFuncsRef.current.getTableColumns(selectedTable);
          data = sqliteFuncsRef.current.getTableData(selectedTable);
        }
        
        if (!mounted) return;
        setTableColumns(columns);
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
    
    loadTableData();
    
    return () => {
      mounted = false;
    };
  }, [selectedTable]);

  const handleBackClick = () => {
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
    return obj.type === 'delete' && Array.isArray(obj.rowIds) && typeof obj.primaryKeyColumn === 'string';
  }

  const handleUpdateRow = async (oldRow: RowData | null, newRow: RowData | DeleteOperation): Promise<boolean> => {
    if (!selectedTable) return false;
    
    if (isPostgresActive) {
      try {
        if (isDeleteOperation(newRow)) {
          return await pgService.deleteRows(selectedTable, newRow.primaryKeyColumn, newRow.rowIds);
        } else if (oldRow) {
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
      if (isDeleteOperation(newRow)) {
        const sql = `DELETE FROM ${selectedTable} WHERE ${newRow.primaryKeyColumn} IN (${newRow.rowIds.map(id => `'${id}'`).join(',')})`;
        const result = dbService.executeBatchOperations([sql]);
        return result.success;
      } else if (oldRow) {
        return dbService.updateRow(selectedTable, oldRow, newRow as RowData);
      }
      return false;
    }
  };

  const handleSaveDatabase = async () => {
    if (isPostgresActive) {
      toast({
        title: "Information",
        description: "PostgreSQL databases are saved on the server automatically",
      });
      return;
    }
    
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
        setLastSaved(new Date());
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

  const handleRefresh = () => {
    if (isPostgresActive) {
      refreshPostgresTables();
    } else {
      refreshSqliteTables();
    }
    toast({
      title: "Refreshed",
      description: "Table list has been refreshed",
    });
  };

  if (isLoadingDatabase) {
    return (
      <AppLayout isConnected={false}>
        <div className="flex items-center justify-center h-full">
          <div className="text-center space-y-4">
            <Database className="w-16 h-16 text-muted-foreground/50 mx-auto animate-pulse" />
            <h2 className="text-xl font-medium">Loading database...</h2>
          </div>
        </div>
      </AppLayout>
    );
  }

  if (!databaseAvailable) {
    return (
      <AppLayout isConnected={false}>
        <div className="flex items-center justify-center h-full">
          <div className="text-center space-y-4">
            <Database className="w-16 h-16 text-muted-foreground/50 mx-auto" />
            <h2 className="text-xl font-medium">No database loaded</h2>
            <p className="text-muted-foreground">
              Please load a database file or connect to PostgreSQL to continue
            </p>
            <Button onClick={handleBackClick} variant="outline">
              Back to Home
            </Button>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout 
      activeTab={activeTab}
      onTabChange={setActiveTab}
      isConnected={databaseAvailable}
      connectionType={isPostgresActive ? 'postgres' : 'sqlite'}
      databaseName={databaseName}
    >
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <header className="h-12 border-b bg-background flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold">
              {activeTab === 'browse' && 'Table Editor'}
              {activeTab === 'schema' && 'Schema Visualizer'}
              {activeTab === 'query' && 'SQL Editor'}
            </h1>
            {isPostgresActive && (
              <Badge variant="outline" className="text-xs font-normal">
                <Server className="w-3 h-3 mr-1" />
                {pgService.currentConfig?.host}
              </Badge>
            )}
          </div>
          
          <div className="flex items-center gap-2">
            <Button 
              variant="ghost" 
              size="sm"
              onClick={handleRefresh}
              className="h-8"
            >
              <RefreshCw className="w-4 h-4" />
            </Button>
            {isSqliteActive && (
              <Button 
                variant="outline" 
                size="sm"
                onClick={handleSaveDatabase}
                className="h-8"
              >
                <Save className="w-4 h-4 mr-1.5" />
                Save
              </Button>
            )}
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => setExportDialogOpen(true)}
              className="h-8"
            >
              <Download className="w-4 h-4 mr-1.5" />
              Export
            </Button>
          </div>
        </header>

        {/* Main Content Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* Table Sidebar - Only show in browse mode */}
          {activeTab === 'browse' && (
            <aside 
              className={cn(
                "h-full bg-background border-r transition-all duration-200 ease-out flex flex-col shrink-0",
                sidebarCollapsed ? "w-12" : "w-64"
              )}
            >
              {/* Sidebar Header */}
              <div className="flex items-center justify-between p-3 border-b">
                {!sidebarCollapsed && (
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Tables
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

              {!sidebarCollapsed && (
                <>
                  {/* Stats */}
                  <div className="p-3 border-b grid grid-cols-2 gap-2 text-xs">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Table2 className="w-3.5 h-3.5" />
                      <span>{tables.length} tables</span>
                    </div>

                  </div>

                  {/* Search */}
                  <div className="p-3 border-b">
                    <div className="relative">
                      <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search tables..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-8 h-9"
                      />
                    </div>
                  </div>

                  {/* Tables List */}
                  <ScrollArea className="flex-1">
                    <div className="p-2">
                      {filteredTables.length > 0 ? (
                        filteredTables.map((table) => (
                          <button
                            key={table.name}
                            onClick={() => {
                              if (table.name === selectedTable) return;
                              setTableColumns([]);
                              setTableData({ columns: [], rows: [] });
                              setLoading(true);
                              setTimeout(() => setSelectedTable(table.name), 0);
                            }}
                            className={cn(
                              "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                              "hover:bg-muted/50 flex items-center justify-between group",
                              selectedTable === table.name && "bg-muted"
                            )}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <Table2 className="w-4 h-4 text-muted-foreground shrink-0" />
                              <span className="truncate">{table.name}</span>
                            </div>
                            <ChevronRight className={cn(
                              "w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0",
                              selectedTable === table.name && "opacity-100"
                            )} />
                          </button>
                        ))
                      ) : (
                        <div className="text-center text-muted-foreground text-sm py-8">
                          {searchQuery ? 'No tables found' : 'No tables in database'}
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </>
              )}

              {/* Collapsed state - show table icons */}
              {sidebarCollapsed && (
                <ScrollArea className="flex-1">
                  <div className="p-1.5 space-y-1">
                    {filteredTables.map((table) => (
                      <Tooltip key={table.name} delayDuration={0}>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => {
                              if (table.name === selectedTable) return;
                              setTableColumns([]);
                              setTableData({ columns: [], rows: [] });
                              setLoading(true);
                              setTimeout(() => setSelectedTable(table.name), 0);
                            }}
                            className={cn(
                              "w-full flex items-center justify-center p-2 rounded-md transition-colors",
                              "hover:bg-muted/50",
                              selectedTable === table.name && "bg-muted"
                            )}
                          >
                            <Table2 className={cn(
                              "w-4 h-4",
                              selectedTable === table.name ? "text-primary" : "text-muted-foreground"
                            )} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {table.name}
                        </TooltipContent>
                      </Tooltip>
                    ))}
                  </div>
                </ScrollArea>
              )}
            </aside>
          )}

          {/* Content Area */}
          <div className="flex-1 overflow-hidden">
            {activeTab === 'browse' && (
              selectedTable ? (
                loading ? (
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
                )
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  <div className="text-center space-y-2">
                    <Table2 className="w-12 h-12 mx-auto text-muted-foreground/50" />
                    <p>Select a table to view its data</p>
                  </div>
                </div>
              )
            )}

            {activeTab === 'schema' && (
              <SchemaVisualizer 
                tables={tables}
                getTableColumns={getTableColumnsStable}
                getForeignKeys={getForeignKeysStable}
                getIndexes={getIndexesStable}
                isPostgres={isPostgresActive}
              />
            )}

            {activeTab === 'query' && (
              <BatchOperations 
                isPostgres={isPostgresActive} 
                refreshTables={isPostgresActive ? refreshPostgresTables : refreshSqliteTables} 
                onAutosave={handleSaveDatabase}
              />
            )}
          </div>
        </div>

        {/* Status Bar */}
        <StatusBar 
          isConnected={databaseAvailable}
          connectionType={isPostgresActive ? 'postgres' : 'sqlite'}
          databaseName={databaseName}
          tableCount={tables.length}
          lastSaved={lastSaved}
        />
      </div>

      <ExportDialog 
        open={exportDialogOpen} 
        onOpenChange={setExportDialogOpen} 
        isPostgres={isPostgresActive}
      />
    </AppLayout>
  );
};

export default DatabaseView;
