import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Navigate } from 'react-router-dom';
import TableEditor from '@/components/TableEditor';
import SqlEditor from '@/components/SqlEditor';
import SchemaVisualizer, { SchemaVisualizerRef } from '@/components/SchemaVisualizer';
import AppLayout from '@/components/AppLayout';
import StatusBar from '@/components/StatusBar';
import { Sidebar, SidebarItem } from '@/components/Sidebar';
import { useSidebar } from '@/contexts/SidebarContext';
import type { ColumnFilter, ColumnInfo, ForeignKeyInfo, RowData, TablePage, TableQuery } from '@/lib/types';
import { tauriService } from '@/lib/tauri';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Box, Download, Eye, Layers, RefreshCw, Server, Table2, TableOfContents, Upload } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { ExportDialog } from '@/components/ExportDialog';
import { ImportDialog } from '@/components/ImportDialog';
import { Star } from '@/components/Mascot/Star';
import { useMascot } from '@/lib/mascot';
import { SemanticSearch, VectorInspector, SimilarRowsModal, MockDataGenerator } from '@/components/VectorAdmin';
import {
  refreshConnectionTables,
  schemasWithTables,
  setSchemaFilter,
  useActiveConnection,
  visibleTables,
  type OpenConnection,
} from '@/lib/db/connections';
import { PgClient } from '@/lib/db/pgClient';
import { auditGridWrite } from '@/lib/db/audit';
import { ReadOnlyConnectionError } from '@/lib/queryGate';
import { useAppCommand } from '@/lib/commands';

const DEFAULT_QUERY: TableQuery = { limit: 100, offset: 0, search: '', sortColumn: null, sortDirection: 'asc', filters: [] };

type Tab = 'browse' | 'schema' | 'query' | 'vectors' | 'mock';

/** What each open connection was showing, so switching back restores it. */
const remembered = new Map<string, { table: string; tab: Tab; query: TableQuery }>();

const EMPTY_PAGE: TablePage = { columns: [], rows: [], total: 0 };

const DatabaseView = () => {
  const conn = useActiveConnection();
  if (!conn) return <Navigate to="/" replace />;
  return <Workspace key={conn.id} conn={conn} />;
};

function reportError(title: string, error: unknown) {
  toast({
    title: error instanceof ReadOnlyConnectionError ? 'Read-only connection' : title,
    description: error instanceof Error ? error.message : String(error),
    variant: 'destructive',
  });
}

function Workspace({ conn }: { conn: OpenConnection }) {
  const memory = remembered.get(conn.id);
  const client = conn.client;
  const [selectedTable, setSelectedTable] = useState<string>(memory?.table ?? '');
  const [activeTab, setActiveTab] = useState<Tab>(memory?.tab ?? 'browse');
  const [tableQuery, setTableQuery] = useState<TableQuery>(memory?.query ?? DEFAULT_QUERY);
  const [tableColumns, setTableColumns] = useState<ColumnInfo[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [tableData, setTableData] = useState<TablePage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped whenever something writes, to reload the visible rows. */
  const [dataVersion, setDataVersion] = useState(0);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importTarget, setImportTarget] = useState<{ table?: string } | null>(null);
  const [insertRequest, setInsertRequest] = useState(0);
  /**
   * Star was clicked, or a table dropped on it: show the SQL editor and open
   * Text to SQL there, starting the prompt with the table when there is one.
   */
  const [aiRequest, setAiRequest] = useState<{ seed?: string } | null>(null);
  const clearAiRequest = useCallback(() => setAiRequest(null), []);
  const askStar = useCallback(() => {
    setActiveTab('query');
    setAiRequest({});
  }, []);
  const askStarAbout = useCallback((table: string) => {
    setActiveTab('query');
    setAiRequest({ seed: `Using the ${table} table, ` });
  }, []);
  const { prefs: starPrefs } = useMascot();
  const { contentSidebarCollapsed: sidebarCollapsed, toggleContentSidebar } = useSidebar();

  const tables = useMemo(() => visibleTables(conn), [conn]);
  const schemas = useMemo(() => schemasWithTables(conn), [conn]);
  const pg = client instanceof PgClient ? client : null;
  const hasPgVector = conn.hasPgVector;

  useEffect(() => {
    remembered.set(conn.id, { table: selectedTable, tab: activeTab, query: tableQuery });
  }, [conn.id, selectedTable, activeTab, tableQuery]);

  // The remembered table may have been dropped since.
  useEffect(() => {
    if (selectedTable && conn.tables.length > 0 && !conn.tables.some((t) => t.name === selectedTable)) {
      setSelectedTable('');
    }
  }, [conn.tables, selectedTable]);

  // No spinner on a refresh after a write: swapping the grid for one would
  // unmount it, and an open edit, the scroll position and the selection with it.
  useEffect(() => {
    if (!selectedTable) return;
    let mounted = true;
    void (async () => {
      try {
        const [columns, keys, data] = await Promise.all([
          client.getColumns(selectedTable),
          client.getForeignKeys(selectedTable),
          client.queryTable(selectedTable, tableQuery),
        ]);
        // A delete or a narrower filter can leave the page past the end.
        if (data.rows.length === 0 && data.total > 0 && tableQuery.offset > 0) {
          const lastOffset = Math.floor((data.total - 1) / tableQuery.limit) * tableQuery.limit;
          if (mounted) setTableQuery((q) => ({ ...q, offset: lastOffset }));
          return;
        }
        if (!mounted) return;
        setTableColumns(columns);
        setForeignKeys(keys);
        setTableData(data);
        setLoadError(null);
      } catch (error) {
        if (!mounted) return;
        setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [client, selectedTable, dataVersion, tableQuery]);

  const refreshAfterWrite = useCallback(async () => {
    await refreshConnectionTables(conn.id).catch(() => undefined);
    setDataVersion((v) => v + 1);
  }, [conn.id]);

  // Another program (an agent through MCP, the user's own app) wrote the file.
  useEffect(() => {
    const onChange = (event: Event) => {
      if ((event as CustomEvent<{ id: string }>).detail?.id !== conn.id) return;
      void refreshAfterWrite();
    };
    window.addEventListener('dbExternalChange', onChange);
    return () => window.removeEventListener('dbExternalChange', onChange);
  }, [conn.id, refreshAfterWrite]);

  const handleRefresh = async () => {
    await refreshAfterWrite();
    toast({ title: 'Refreshed', description: `${conn.name} reloaded.` });
  };

  const selectedRef = useRef(selectedTable);
  selectedRef.current = selectedTable;
  const selectTable = useCallback((tableName: string, filters: ColumnFilter[] = []) => {
    setActiveTab('browse');
    if (selectedRef.current !== tableName) {
      // A different table shows a spinner until its first page arrives; the
      // same table with a new filter keeps the grid on screen.
      setTableColumns([]);
      setForeignKeys([]);
      setTableData(EMPTY_PAGE);
      setLoading(true);
    }
    setSelectedTable(tableName);
    setTableQuery({ ...DEFAULT_QUERY, filters });
  }, []);

  useAppCommand((command) => {
    switch (command.type) {
      case 'openTable':
        selectTable(command.table);
        break;
      case 'switchTab':
        if (command.tab !== 'vectors' || hasPgVector) setActiveTab(command.tab);
        break;
      case 'refresh':
        void handleRefresh();
        break;
      case 'export':
        setExportDialogOpen(true);
        break;
      case 'importCsv':
        setImportTarget({ table: command.table ?? (activeTab === 'browse' ? selectedTable || undefined : undefined) });
        break;
      case 'insertRow':
        if (selectedTable) {
          setActiveTab('browse');
          setInsertRequest((n) => n + 1);
        }
        break;
      case 'aiGenerate':
        askStar();
        break;
    }
  });

  // Every write path re-reads the page afterwards rather than trusting the
  // dialog's copy: only the edited columns were written, and an agent may have
  // changed others meanwhile.
  const handleUpdateRow = async (oldRow: RowData, newRow: RowData): Promise<boolean> => {
    try {
      const sql = await client.updateRow(selectedTable, oldRow, newRow);
      if (sql) auditGridWrite(conn, [sql], { ok: true, rows: 1 });
      setDataVersion((v) => v + 1);
      return true;
    } catch (error) {
      reportError('Row not updated', error);
      return false;
    }
  };

  const handleInsertRow = async (values: RowData): Promise<boolean> => {
    try {
      const sql = await client.insertRow(selectedTable, values);
      auditGridWrite(conn, [sql], { ok: true, rows: 1 });
      setDataVersion((v) => v + 1);
      toast({ title: 'Row inserted', description: `Added to ${selectedTable}.` });
      return true;
    } catch (error) {
      reportError('Row not inserted', error);
      return false;
    }
  };

  const handleDeleteRows = async (rows: RowData[]): Promise<boolean> => {
    try {
      const statements = await client.deleteRows(selectedTable, rows);
      auditGridWrite(conn, statements, { ok: true, rows: rows.length });
      setDataVersion((v) => v + 1);
      return true;
    } catch (error) {
      reportError('Rows not deleted', error);
      return false;
    }
  };

  const schemaVisualizerRef = useRef<SchemaVisualizerRef>(null);
  const handleSchemaExport = async (format: 'png' | 'svg') => {
    if (!schemaVisualizerRef.current) return;
    try {
      const dataUrl = await schemaVisualizerRef.current.exportSchema(format);
      if (!dataUrl) {
        toast({ title: 'Error', description: 'Failed to generate schema image', variant: 'destructive' });
        return;
      }
      const result = await tauriService.exportDatabase(dataUrl, format);
      if (result.success) toast({ title: 'Exported', description: `Schema saved as ${format.toUpperCase()}` });
      else if (result.error !== 'Export cancelled') toast({ title: 'Error', description: result.error || 'Failed to export schema', variant: 'destructive' });
    } catch (error) {
      reportError('Export failed', error);
    }
  };

  const getTableColumns = useCallback((name: string) => client.getColumns(name), [client]);
  const getForeignKeys = useCallback((name: string) => client.getForeignKeys(name), [client]);
  const getIndexes = useCallback((name: string) => client.getIndexes(name), [client]);
  const getColumnsForSearch = useCallback(
    async (name: string) => (await client.getColumns(name)).map((c) => ({ name: c.name, pk: c.pk, type: c.type })),
    [client],
  );

  // Vector inspection
  const [vectorInspectorOpen, setVectorInspectorOpen] = useState(false);
  const [inspectedVector, setInspectedVector] = useState<{ value: unknown; columnName: string; rowId?: string | number; tableName?: string } | null>(null);
  const [similarRowsModalOpen, setSimilarRowsModalOpen] = useState(false);
  const [similarRowsSourceRow, setSimilarRowsSourceRow] = useState<RowData | null>(null);
  const handleInspectVector = (value: unknown, columnName: string, rowId?: string | number, tableName?: string) => {
    setInspectedVector({ value, columnName, rowId, tableName });
    setVectorInspectorOpen(true);
  };
  const primaryKeyColumn = useMemo(() => tableColumns.find((c) => c.pk === 1)?.name || 'id', [tableColumns]);

  const sidebarItems: SidebarItem[] = useMemo(
    () =>
      tables.map((table) => ({
        id: table.name,
        label: table.name,
        icon: table.type === 'view' ? <Eye /> : <TableOfContents />,
        tooltip: table.type === 'view' ? `${table.name} (view, read-only)` : table.name,
        // Dragging a table onto Star asks about it; only offered while Star is shown.
        dragTable: starPrefs.visible ? table.name : undefined,
        onClick: () => selectTable(table.name),
      })),
    [tables, selectTable, starPrefs.visible],
  );

  const sidebarStats = (
    <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <Table2 className="w-3.5 h-3.5" />
      <span>
        {tables.length} {tables.length === 1 ? 'table' : 'tables'}
        {conn.dialect === 'postgres' && conn.schemaFilter === 'all' && schemas.length > 1 ? ` in ${schemas.length} schemas` : ''}
      </span>
    </div>
  );

  const schemaPicker = conn.dialect === 'postgres' && schemas.length > 1 && (
    <Select value={conn.schemaFilter} onValueChange={(value) => setSchemaFilter(conn.id, value)}>
      <SelectTrigger className="h-8 text-xs" aria-label="Schema">
        <Layers className="mr-1.5 h-3.5 w-3.5 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All schemas</SelectItem>
        {schemas.map((schema) => (
          <SelectItem key={schema} value={schema}>
            {schema}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const title: Record<Tab, string> = {
    browse: 'Table editor',
    schema: 'Schema',
    query: 'SQL editor',
    vectors: 'Vector search',
    mock: 'Mock data generator',
  };

  return (
    <AppLayout
      activeTab={activeTab}
      onTabChange={(tab) => setActiveTab(tab as Tab)}
      isConnected
      connectionType={conn.dialect}
      databaseName={conn.name}
      hasPgVector={hasPgVector}
    >
      <div className="flex flex-col h-full overflow-hidden">
        <header className="h-12 border-b bg-background flex items-center justify-between px-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-sm font-semibold">{title[activeTab]}</h1>
            {conn.dialect === 'postgres' && (
              <Badge variant="outline" className="text-xs font-normal max-w-[320px] truncate" title={conn.detail}>
                <Server className="w-3 h-3 mr-1 shrink-0" />
                <span className="truncate">{conn.detail}</span>
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
            <Button variant="ghost" size="sm" onClick={() => void handleRefresh()} className="h-8" title="Refresh" aria-label="Refresh">
              <RefreshCw className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportTarget({ table: activeTab === 'browse' ? selectedTable || undefined : undefined })}
              className="h-8"
            >
              <Upload className="w-4 h-4 mr-1.5" />
              Import
            </Button>
            <Button variant="outline" size="sm" onClick={() => setExportDialogOpen(true)} className="h-8">
              <Download className="w-4 h-4 mr-1.5" />
              Export
            </Button>
          </div>
        </header>

        <div className="flex-1 flex overflow-hidden">
          {activeTab === 'browse' && (
            <Sidebar
              title="Tables"
              collapsed={sidebarCollapsed}
              onToggleCollapse={toggleContentSidebar}
              items={sidebarItems}
              selectedId={selectedTable}
              stats={sidebarStats}
              toolbar={schemaPicker || undefined}
              searchPlaceholder="Search tables"
              className="animate-fade-in"
            />
          )}

          <div className="flex-1 overflow-hidden">
            {activeTab === 'browse' &&
              (selectedTable ? (
                loading ? (
                  <div className="flex items-center justify-center h-full">
                    <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
                  </div>
                ) : loadError ? (
                  <div className="flex items-center justify-center h-full p-6">
                    <div className="max-w-md text-center space-y-3">
                      <p className="text-sm font-medium">Could not load {selectedTable}</p>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap">{loadError}</p>
                      <Button size="sm" variant="outline" onClick={() => setDataVersion((v) => v + 1)}>
                        Try again
                      </Button>
                    </div>
                  </div>
                ) : (
                  <TableEditor
                    key={selectedTable}
                    conn={conn}
                    tableName={selectedTable}
                    page={tableData}
                    columnInfo={tableColumns}
                    foreignKeys={foreignKeys}
                    query={tableQuery}
                    onQueryChange={setTableQuery}
                    onUpdateRow={handleUpdateRow}
                    onInsertRow={handleInsertRow}
                    onDeleteRows={handleDeleteRows}
                    onNavigate={selectTable}
                    onImport={() => setImportTarget({ table: selectedTable })}
                    insertRequest={insertRequest}
                    vectorColumns={pg ? conn.vectorColumns : []}
                    onInspectVector={pg && hasPgVector ? handleInspectVector : undefined}
                    onFindSimilar={
                      pg && hasPgVector
                        ? (row) => {
                            setSimilarRowsSourceRow(row);
                            setSimilarRowsModalOpen(true);
                          }
                        : undefined
                    }
                  />
                )
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground animate-fade-in">
                  <div className="text-center space-y-2">
                    <Table2 className="w-12 h-12 mx-auto text-muted-foreground/50" />
                    <p>{tables.length ? 'Select a table to view its data' : 'This database has no tables yet'}</p>
                    {!tables.length && (
                      <p className="text-xs">Create one in the SQL editor, or import a CSV.</p>
                    )}
                  </div>
                </div>
              ))}

            {activeTab === 'schema' && (
              <SchemaVisualizer
                ref={schemaVisualizerRef}
                tables={tables}
                revision={dataVersion}
                getTableColumns={getTableColumns}
                getForeignKeys={getForeignKeys}
                getIndexes={getIndexes}
                isPostgres={conn.dialect === 'postgres'}
                onEditTable={(tableName) => selectTable(tableName)}
              />
            )}

            {/* Kept mounted: results, undo history and a running query survive a tab switch. */}
            <div className={activeTab === 'query' ? 'h-full' : 'hidden'}>
              <SqlEditor
                conn={conn}
                refreshTables={refreshAfterWrite}
                requestAiDialog={aiRequest}
                onAiDialogRequested={clearAiRequest}
              />
            </div>

            {activeTab === 'vectors' && pg && hasPgVector && (
              <SemanticSearch
                vectorColumns={conn.vectorColumns}
                findSimilarByRowId={(...args) => pg.findSimilarByRowId(...args)}
                findSimilarByVector={(...args) => pg.findSimilarByVector(...args)}
                getTableColumns={getColumnsForSearch}
                onInspectVector={handleInspectVector}
              />
            )}

            {activeTab === 'mock' && pg && hasPgVector && (
              <MockDataGenerator
                vectorColumns={conn.vectorColumns}
                getTableColumns={getColumnsForSearch}
                insertRow={async (table, values) => {
                  try {
                    const sql = await client.insertRow(table, values);
                    auditGridWrite(conn, [sql], { ok: true, rows: 1 });
                    return true;
                  } catch (error) {
                    reportError('Row not inserted', error);
                    return false;
                  }
                }}
                onInsertComplete={() => void refreshAfterWrite()}
              />
            )}
          </div>
        </div>

        <StatusBar conn={conn} tableCount={tables.length} />
      </div>

      {/* Star peeks over the status bar; clicking it opens Text to SQL. Hidden from Settings → Star. */}
      {starPrefs.visible && <Star onActivate={askStar} onAsk={askStarAbout} />}

      <ExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        conn={conn}
        mode={activeTab === 'schema' ? 'schema' : 'data'}
        initialTable={selectedTable}
        onExportSchema={handleSchemaExport}
      />

      <ImportDialog
        open={importTarget !== null}
        onOpenChange={(open) => !open && setImportTarget(null)}
        conn={conn}
        initialTable={importTarget?.table}
        onImported={(table) => {
          void refreshAfterWrite();
          selectTable(table);
        }}
      />

      {pg && hasPgVector && (
        <VectorInspector
          isOpen={vectorInspectorOpen}
          onClose={() => setVectorInspectorOpen(false)}
          vectorValue={inspectedVector?.value}
          columnName={inspectedVector?.columnName || ''}
          rowId={inspectedVector?.rowId}
          tableName={inspectedVector?.tableName}
        />
      )}

      {pg && hasPgVector && (
        <SimilarRowsModal
          isOpen={similarRowsModalOpen}
          onClose={() => setSimilarRowsModalOpen(false)}
          sourceRow={similarRowsSourceRow}
          tableName={selectedTable}
          primaryKeyColumn={primaryKeyColumn}
          vectorColumns={conn.vectorColumns}
          findSimilarByRowId={(...args) => pg.findSimilarByRowId(...args)}
          onInspectVector={handleInspectVector}
        />
      )}
    </AppLayout>
  );
}

export default DatabaseView;
