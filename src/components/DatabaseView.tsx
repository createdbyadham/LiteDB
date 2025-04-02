import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TableView from '@/components/TableView';
import BatchOperations from '@/components/QueryEditor';
import { useDatabase } from '@/hooks/useDatabase';
import { dbService, RowData } from '@/lib/dbService';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Database, ArrowLeft, Save, Download } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { ExportDialog } from '@/components/ExportDialog';
import TableSidebar from '@/components/TableSidebar';

const DatabaseView = () => {
  const [selectedTable, setSelectedTable] = useState<string>('');
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { isLoaded, isLoading, tables, getTableData, getTableColumns } = useDatabase();
  const navigate = useNavigate();

  const handleBackClick = () => {
    navigate('/', { replace: true });
  };

  const handleUpdateRow = async (oldRow: RowData, newRow: RowData): Promise<boolean> => {
    if (!selectedTable) return false;
    const success = dbService.updateRow(selectedTable, oldRow, newRow);
    if (success) {
      toast({
        title: "Success",
        description: "Row updated successfully"
      });
    } else {
      toast({
        title: "Error",
        description: "Failed to update row",
        variant: "destructive"
      });
    }
    return success;
  };

  const handleSaveDatabase = async () => {
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4">
          <Database className="w-16 h-16 text-muted-foreground/50 mx-auto animate-pulse" />
          <h2 className="text-xl font-medium">Loading database...</h2>
        </div>
      </div>
    );
  }

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4">
          <Database className="w-16 h-16 text-muted-foreground/50 mx-auto" />
          <h2 className="text-xl font-medium">No database loaded</h2>
          <p className="text-muted-foreground">
            Please load a database file to continue
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
    <div className="h-screen flex flex-col py-2 px-4 animate-fade-in">
      <div className="flex items-center justify-between mb-4 sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <Button variant="ghost" onClick={handleBackClick}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <div className="flex gap-2">
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
        
        <TabsContent value="browse" className="flex-1 h-full overflow-hidden">
          <div className="flex h-full">
            <TableSidebar 
              tables={tables}
              activeTable={selectedTable}
              onSelectTable={(tableName) => {
                // Clear current table before switching
                setSelectedTable('');
                // Use setTimeout to ensure state is cleared before loading new table
                setTimeout(() => setSelectedTable(tableName), 0);
              }}
              collapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
            />
            
            <div className={`flex-1 ${sidebarCollapsed ? 'pl-2' : 'pl-4'} overflow-hidden`}>
              {selectedTable ? (
                <div className="h-full flex flex-col">
                  <TableView 
                    key={selectedTable}
                    tableName={selectedTable}
                    {...getTableData(selectedTable)}
                    columnInfo={getTableColumns(selectedTable)}
                    onUpdateRow={handleUpdateRow}
                  />
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
          <BatchOperations />
        </TabsContent>
      </Tabs>

      <ExportDialog 
        open={exportDialogOpen} 
        onOpenChange={setExportDialogOpen} 
      />
    </div>
  );
};

export default DatabaseView;
