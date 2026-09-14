import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import TableEditor from '@/components/TableEditor';
import SqlEditor from '@/components/SqlEditor';
import SchemaVisualizer, { SchemaVisualizerRef } from '@/components/SchemaVisualizer';
import AppLayout from '@/components/AppLayout';
import StatusBar from '@/components/StatusBar';
import { Sidebar, SidebarItem } from '@/components/Sidebar';
import { useSqlite } from '@/hooks/useSqlite';
import { usePostgres } from '@/hooks/usePostgres';
import { useSidebar } from '@/contexts/SidebarContext';
import { sqliteService, RowData, ColumnInfo } from '@/lib/sqliteService';
import type { DiskAlert } from '@/lib/diskGuard';
import { pgService } from '@/lib/pgService';
import { tauriService } from '@/lib/tauri';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Database,
  Download,
  Server,
  Table2,
  TableOfContents,
  RefreshCw,
  Box,
} from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ExportDialog } from '@/components/ExportDialog';
import { SemanticSearch, VectorInspector, SimilarRowsModal, MockDataGenerator } from '@/components/VectorAdmin';

const DatabaseView = () => {
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [tableColumns, setTableColumns] = useState<ColumnInfo[]>([]);
  const [tableData, setTableData] = useState<{ columns: string[], rows: RowData[] }>({ columns: [], rows: [] });
  /** Bumped whenever something writes, to force the visible rows to reload. */
  const [dataVersion, setDataVersion] = useState(0);
  const [diskAlert, setDiskAlert] = useState<DiskAlert | null>(null);
  const [confirmReload, setConfirmReload] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('browse');
  const [lastSaved] = useState<Date | null>(null);
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
  } = useSqlite();

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
    refreshTables: refreshPostgresTables,
    // pgvector support
    hasPgVector,
    vectorColumns,
    findSimilarByRowId,
    findSimilarByVector
  } = usePostgres();

  // Vector inspection state
  const [vectorInspectorOpen, setVectorInspectorOpen] = useState(false);
  const [inspectedVector, setInspectedVector] = useState<{
    value: unknown;
    columnName: string;
    rowId?: string | number;
    tableName?: string;
  } | null>(null);

  // Similar rows modal state
  const [similarRowsModalOpen, setSimilarRowsModalOpen] = useState(false);
  const [similarRowsSourceRow, setSimilarRowsSourceRow] = useState<RowData | null>(null);

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
    : sqliteService.currentFilePath?.split(/[/\\]/).pop() || 'SQLite';

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

      const result = await tauriService.exportDatabase(dataUrl, format);
      if (result.success) {
        toast({ title: "Success", description: `Schema exported as ${format.toUpperCase()}` });
      } else if (result.error !== 'Export cancelled') {
        toast({ title: "Error", description: result.error || "Failed to export schema", variant: "destructive" });
      }
    } catch (error) {
      console.error(error);
      toast({ title: "Error", description: "Failed to export schema", variant: "destructive" });
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Ensure Postgres is disconnected when leaving the database view
      // This handles browser back button navigation
      pgService.disconnect();
    };
  }, []);

  // Effect to load table data when a table is selected
  useEffect(() => {
    if (!selectedTable) return;

    let mounted = true;

    // No spinner here. Switching tables already shows one (handleTableSelect);
    // a refresh after an agent's write must not, because swapping the grid
    // for a spinner unmounts it — and an open edit dialog, the scroll
    // position and the selection go with it.
    const loadTableData = async () => {
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
    // `dataVersion` is what lets a write elsewhere in the app pull fresh rows.
    // Without it this only ran on a table *change*, so after running an UPDATE
    // in the SQL editor the grid kept showing pre-write values — a successful
    // write that looks like a silent failure.
  }, [selectedTable, dataVersion]);

  // A ref, not a variable inside the effect below: that effect re-subscribes
  // on every render (`refreshSqliteTables` is a new function each time), and
  // its cleanup cancelled the timer before the toast could show.
  const inUseToastTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(inUseToastTimer.current), []);

  useEffect(() => {
    setDiskAlert(sqliteService.diskAlert);
    const onReloaded = () => {
      refreshSqliteTables();
      setDataVersion((v) => v + 1);
    };
    // The service fires this once per change of state, so each toast shows
    // once; the status bar keeps showing the state after the toast is gone.
    const onDiskAlert = () => {
      const alert = sqliteService.diskAlert;
      setDiskAlert(alert);
      if (alert === 'changed') {
        toast({
          title: 'File changed on disk',
          description:
            'Something else updated this database while you had unsaved edits. Saving would overwrite their version. Reload to load theirs — that discards every unsaved edit, not just the last one.',
          variant: 'destructive',
          duration: 20000,
          action: (
            <ToastAction altText="Reload from disk" onClick={() => setConfirmReload(true)}>
              Reload
            </ToastAction>
          ),
        });
      } else if (alert === 'in-use') {
        // The agent holds the file for a moment on every call, and a save
        // that lands then is refused and retried a second later. Only speak
        // up if it lasts; the status bar shows it either way.
        clearTimeout(inUseToastTimer.current);
        inUseToastTimer.current = setTimeout(() => {
          if (sqliteService.diskAlert !== 'in-use') return;
          toast({
            title: 'Database in use',
            description:
              'Another program has this file open, so LiteDB is not saving over it — one of you would silently lose writes. Your edits are kept and saved once it closes.',
            variant: 'destructive',
          });
        }, 3000);
      } else if (alert === 'missing') {
        toast({
          title: 'Database file not found',
          description: 'The file was moved or deleted. Your edits are kept in memory but cannot be saved there.',
          variant: 'destructive',
        });
      } else if (alert === 'save-failed') {
        toast({
          title: 'Auto-save failed',
          description: 'Could not write the database file. LiteDB keeps retrying; your edits are kept in memory.',
          variant: 'destructive',
        });
      }
    };
    window.addEventListener('sqliteFileReloaded', onReloaded);
    window.addEventListener('sqliteDiskAlert', onDiskAlert);
    return () => {
      window.removeEventListener('sqliteFileReloaded', onReloaded);
      window.removeEventListener('sqliteDiskAlert', onDiskAlert);
    };
  }, [refreshSqliteTables]);

  /**
   * Called after anything that changes the database from the SQL editor.
   *
   * Refreshes both the table list (a script may have created or dropped one)
   * and the rows on screen. Previously only the list was refreshed, and only
   * for DDL, so an UPDATE left the grid showing stale values.
   */
  const refreshAfterWrite = async () => {
    if (isPostgresActive) {
      await refreshPostgresTables();
    } else {
      refreshSqliteTables();
    }
    setDataVersion((version) => version + 1);
  };

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
        try {
          const sql = `DELETE FROM ${selectedTable} WHERE ${newRow.primaryKeyColumn} IN (${newRow.rowIds.map(id => `'${id}'`).join(',')})`;
          const result = sqliteService.executeBatchOperations([sql]);

          if (!result.success && result.errors.length > 0) {
            toast({
              title: "Delete Error",
              description: result.errors.join('\n'),
              variant: "destructive"
            });
          }

          return result.success;
        } catch (error) {
          toast({
            title: "Delete Error",
            description: error instanceof Error ? error.message : "Failed to delete rows",
            variant: "destructive"
          });
          return false;
        }
      } else if (oldRow) {
        const updated = sqliteService.updateRow(selectedTable, oldRow, newRow as RowData);
        // Re-read the row rather than trust the dialog's copy: only the edited
        // columns were written, and an agent may have changed the others while
        // the dialog was open.
        if (updated) setDataVersion((version) => version + 1);
        return updated;
      }
      return false;
    }
  };

  const handleRefresh = () => {
    if (isPostgresActive) {
      void refreshPostgresTables();
      setDataVersion((version) => version + 1);
      toast({
        title: "Refreshed",
        description: "Table list has been refreshed",
      });
      return;
    }
    if (sqliteService.isDirty || diskAlert) {
      setConfirmReload(true);
      return;
    }
    void sqliteService.reloadFromDisk();
  };

  const handleTableSelect = (tableName: string) => {
    if (tableName === selectedTable) return;
    setTableColumns([]);
    setTableData({ columns: [], rows: [] });
    setLoading(true);
    setTimeout(() => setSelectedTable(tableName), 0);
  };

  // Vector inspection handler
  const handleInspectVector = (
    value: unknown,
    columnName: string,
    rowId?: string | number,
    tableName?: string
  ) => {
    setInspectedVector({ value, columnName, rowId, tableName });
    setVectorInspectorOpen(true);
  };

  // Find similar rows handler
  const handleFindSimilar = (row: RowData) => {
    setSimilarRowsSourceRow(row);
    setSimilarRowsModalOpen(true);
  };

  // Get primary key column for current table
  const primaryKeyColumn = useMemo(() => {
    const pk = tableColumns.find(col => col.pk === 1);
    return pk?.name || 'id';
  }, [tableColumns]);

  // Wrapper for getTableColumns that returns the format SemanticSearch expects
  const getTableColumnsForSearch = async (tableName: string) => {
    const cols = isPostgresActive 
      ? await getPostgresTableColumns(tableName)
      : getSqliteTableColumns(tableName);
    return cols.map(c => ({ name: c.name, pk: c.pk, type: c.type }));
  };

  // Prepare sidebar items
  const sidebarItems: SidebarItem[] = useMemo(() => {
    return tables.map(table => ({
      id: table.name,
      label: table.name,
      icon: <TableOfContents />,
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
      hasPgVector={hasPgVector}
    >
      <div className="flex flex-col h-full overflow-hidden">
        {/* Header */}
        <header className="h-12 border-b bg-background flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-semibold">
              {activeTab === 'browse' && 'Table Editor'}
              {activeTab === 'schema' && 'Schema Visualizer'}
              {activeTab === 'query' && 'SQL Editor'}
              {activeTab === 'vectors' && 'Vector Search'}
              {activeTab === 'mock' && 'Mock Data Generator'}
            </h1>
            {isPostgresActive && (
              <Badge variant="outline" className="text-xs font-normal">
                <Server className="w-3 h-3 mr-1" />
                {pgService.currentConfig?.host}
              </Badge>
            )}
            {hasPgVector && activeTab !== 'vectors' && (
              <Badge variant="secondary" className="text-xs font-normal">
                <Box className="w-3 h-3 mr-1" />
                pgvector
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
                    vectorColumns={isPostgresActive ? vectorColumns : []}
                    onInspectVector={isPostgresActive && hasPgVector ? handleInspectVector : undefined}
                    onFindSimilar={isPostgresActive && hasPgVector ? handleFindSimilar : undefined}
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
                revision={dataVersion}
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
                refreshTables={refreshAfterWrite}
              />
            )}

            {activeTab === 'vectors' && hasPgVector && (
              <SemanticSearch
                vectorColumns={vectorColumns}
                findSimilarByRowId={findSimilarByRowId}
                findSimilarByVector={findSimilarByVector}
                getTableColumns={getTableColumnsForSearch}
                onInspectVector={handleInspectVector}
              />
            )}

            {activeTab === 'mock' && hasPgVector && (
              <MockDataGenerator
                vectorColumns={vectorColumns}
                getTableColumns={getTableColumnsForSearch}
                onInsertComplete={handleRefresh}
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
          diskAlert={diskAlert}
          onReloadFromDisk={() => setConfirmReload(true)}
        />
      </div>

      <AlertDialog open={confirmReload} onOpenChange={setConfirmReload}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reload from disk?</AlertDialogTitle>
            <AlertDialogDescription>
              {diskAlert === 'in-use'
                ? 'Another program has this database open. Reloading shows the file as it is now — writes that program has not folded into the file yet will not appear — and discards every unsaved edit.'
                : 'This replaces what is on screen with the file. Every unsaved edit will be discarded, not just the last one. This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void sqliteService.reloadFromDisk()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Reload and discard edits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        isPostgres={isPostgresActive}
        mode={activeTab === 'schema' ? 'schema' : 'data'}
        onExportSchema={handleSchemaExport}
      />

      {/* Vector Inspector Side Panel */}
      {hasPgVector && (
        <VectorInspector
          isOpen={vectorInspectorOpen}
          onClose={() => setVectorInspectorOpen(false)}
          vectorValue={inspectedVector?.value}
          columnName={inspectedVector?.columnName || ''}
          rowId={inspectedVector?.rowId}
          tableName={inspectedVector?.tableName}
        />
      )}

      {/* Similar Rows Modal */}
      {hasPgVector && (
        <SimilarRowsModal
          isOpen={similarRowsModalOpen}
          onClose={() => setSimilarRowsModalOpen(false)}
          sourceRow={similarRowsSourceRow}
          tableName={selectedTable}
          primaryKeyColumn={primaryKeyColumn}
          vectorColumns={vectorColumns}
          findSimilarByRowId={findSimilarByRowId}
          onInspectVector={handleInspectVector}
        />
      )}
    </AppLayout>
  );
};

export default DatabaseView;
