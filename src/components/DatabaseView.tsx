import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import TableView from '@/components/TableView';
import BatchOperations from '@/components/QueryEditor';
import { useDatabase } from '@/hooks/useDatabase';
import { dbService, RowData } from '@/lib/dbService';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Database, ArrowLeft, Save } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import SchemaVisualization from '@/components/SchemaVisualization';

const DatabaseView = () => {
  const [selectedTable, setSelectedTable] = useState<string>('');
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
    <div className="container py-4 space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={handleBackClick}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back
        </Button>
        <Button onClick={handleSaveDatabase}>
          <Save className="mr-2 h-4 w-4" />
          Save Database
        </Button>
      </div>

      <Tabs defaultValue="browse">
        <TabsList>
          <TabsTrigger value="browse">Browse</TabsTrigger>
          <TabsTrigger value="query">Batch Operations</TabsTrigger>
          <TabsTrigger value="schema">Schema Diagram</TabsTrigger>
        </TabsList>
        
        <TabsContent value="browse" className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {tables.map((table) => (
              <Button
                key={table.name}
                variant={selectedTable === table.name ? "default" : "outline"}
                onClick={() => {
                  // Clear current table before switching
                  setSelectedTable('');
                  // Use setTimeout to ensure state is cleared before loading new table
                  setTimeout(() => setSelectedTable(table.name), 0);
                }}
              >
                {table.name}
              </Button>
            ))}
          </div>
          
          {selectedTable && (
            <TableView 
              key={selectedTable} // Add key to force remount on table switch
              tableName={selectedTable}
              {...getTableData(selectedTable)}
              columnInfo={getTableColumns(selectedTable)}
              onUpdateRow={handleUpdateRow}
            />
          )}
        </TabsContent>
        
        <TabsContent value="query">
          <BatchOperations />
        </TabsContent>
        
        <TabsContent value="schema" className="h-[calc(100vh-200px)]">
          <SchemaVisualization tables={tables} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default DatabaseView;
