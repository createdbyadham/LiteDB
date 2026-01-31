import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import TableEditor from '@/components/TableEditor';
import SqlEditor from '@/components/SqlEditor';
import SchemaVisualizer, { SchemaVisualizerRef } from '@/components/SchemaVisualizer';
import AppLayout from '@/components/AppLayout';
import StatusBar from '@/components/StatusBar';
import { Sidebar, SidebarItem } from '@/components/Sidebar';
import { useDatabase } from '@/hooks/useDatabase';
import { usePostgres } from '@/hooks/usePostgres';
import { useSidebar } from '@/contexts/SidebarContext';
import { dbService, RowData, ColumnInfo } from '@/lib/dbService';
import { pgService } from '@/lib/pgService';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  Database, 
  Save, 
  Download, 
  Server,
  Table2,
  RefreshCw,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { ExportDialog } from '@/components/ExportDialog';

const DatabaseView = () => {
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [tableColumns, setTableColumns] = useState<ColumnInfo[]>([]);
  const [tableData, setTableData] = useState<{ columns: string[], rows: RowData[] }>({ columns: [], rows: [] });
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('browse');
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

  const schemaVisualizerRef = useRef<SchemaVisualizerRef>(null);

  const handleSchemaExport = async (format: 'png' | 'svg') => {
    if (!schemaVisualizerRef.current) return;
    
    try {
      const dataUrl = await schemaVisualizerRef.current.exportSchema(format);
      if (!dataUrl) {
         toast({ title: "Error", description: "Failed to generate schema image", variant: "destructive" });
         return;
      }
      
      if (window.electron) {
        const result = await window.electron.exportDatabase(dataUrl, format);
        if (result.success) {
           toast({ title: "Success", description: `Schema exported as ${format.toUpperCase()}` });
        } else if (result.error !== 'Export cancelled') {
           toast({ title: "Error", description: result.error || "Failed to export schema", variant: "destructive" });
        }
      }
    } catch (error) {
       console.error(error);
       toast({ title: "Error", description: "Failed to export schema", variant: "destructive" });
    }
  };

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

  const handleTableSelect = (tableName: string) => {
    if (tableName === selectedTable) return;
    setTableColumns([]);
    setTableData({ columns: [], rows: [] });
    setLoading(true);
    setTimeout(() => setSelectedTable(tableName), 0);
  };

  // Prepare sidebar items
  const sidebarItems: SidebarItem[] = useMemo(() => {
    return tables.map(table => ({
      id: table.name,
      label: table.name,
      icon: <Table2 />,
      tooltip: table.name,
      onClick: () => handleTableSelect(table.name)
    }));
  }, [tables, selectedTable]);

  const sidebarStats = (
    <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <Table2 className="w-3.5 h-3.5" />
      <span>{tables.length} tables</span>
    </div>
  );

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
            <Sidebar 
              title="Tables"
              collapsed={sidebarCollapsed}
              onToggleCollapse={toggleContentSidebar}
              items={sidebarItems}
              selectedId={selectedTable}
              stats={sidebarStats}
              searchPlaceholder="Search tables..."
              className="animate-fade-in"
            />
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
                  <TableEditor 
                    key={selectedTable}
                    tableName={selectedTable}
                    columns={tableData.columns}
                    rows={tableData.rows}
                    columnInfo={tableColumns}
                    onUpdateRow={handleUpdateRow}
                  />
                )
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground animate-fade-in">
                  <div className="text-center space-y-2">
                    <Table2 className="w-12 h-12 mx-auto text-muted-foreground/50" />
                    <p>Select a table to view its data</p>
                  </div>
                </div>
              )
            )}

            {activeTab === 'schema' && (
              <SchemaVisualizer 
                ref={schemaVisualizerRef}
                tables={tables}
                getTableColumns={getTableColumnsStable}
                getForeignKeys={getForeignKeysStable}
                getIndexes={getIndexesStable}
                isPostgres={isPostgresActive}
                onEditTable={(tableName) => {
                  handleTableSelect(tableName);
                  setActiveTab('browse');
                }}
              />
            )}

            {activeTab === 'query' && (
              <SqlEditor 
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
        mode={activeTab === 'schema' ? 'schema' : 'data'}
        onExportSchema={handleSchemaExport}
      />
    </AppLayout>
  );
};

export default DatabaseView;
