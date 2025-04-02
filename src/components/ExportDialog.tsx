import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { toast } from '@/hooks/use-toast';
import { dbService } from '@/lib/dbService';
import { usePostgres } from '@/hooks/usePostgres';

type ExportFormat = 'csv' | 'json' | 'xlsx';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPostgres?: boolean;
}

export function ExportDialog({ open, onOpenChange, isPostgres = false }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [isExporting, setIsExporting] = useState(false);
  const [exportableTables, setExportableTables] = useState<string[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>('');
  
  const { tables: postgresTables, executeQuery: executePgQuery } = usePostgres();
  
  // Fetch available tables when dialog opens
  useEffect(() => {
    if (open && isPostgres && postgresTables.length > 0) {
      const tableNames = postgresTables.map(t => t.name);
      setExportableTables(tableNames);
      if (tableNames.length > 0 && !selectedTable) {
        setSelectedTable(tableNames[0]);
      }
    }
  }, [open, isPostgres, postgresTables]);

  const handleExport = async () => {
    try {
      setIsExporting(true);
      
      let exportData = '';  // Initialize with empty string
      let exportFormat = format;
      
      if (isPostgres) {
        // For PostgreSQL we need to export the selected table
        if (!selectedTable) {
          toast({
            title: "Error",
            description: "Please select a table to export",
            variant: "destructive"
          });
          return;
        }
        
        // Get the table data
        const result = await executePgQuery(`SELECT * FROM "${selectedTable}"`);
        if (!result) {
          toast({
            title: "Error",
            description: "Failed to fetch table data for export",
            variant: "destructive"
          });
          return;
        }
        
        // Format data based on the selected format
        if (format === 'json') {
          // JSON format
          exportData = JSON.stringify(result.rows, null, 2);
        } else if (format === 'csv') {
          // CSV format
          const header = result.columns.join(',');
          const rows = result.rows.map((row: any) => 
            result.columns.map(col => {
              const value = row[col];
              // Handle strings with commas by wrapping in quotes
              return typeof value === 'string' && value.includes(',') 
                ? `"${value.replace(/"/g, '""')}"` 
                : value === null ? '' : String(value);
            }).join(',')
          );
          exportData = [header, ...rows].join('\n');
        } else {
          // XLSX format not directly supported for PostgreSQL in this implementation
          // We'll use JSON as a fallback
          toast({
            title: "Warning",
            description: "Excel export not supported for PostgreSQL. Using JSON format instead.",
          });
          exportData = JSON.stringify(result.rows, null, 2);
          exportFormat = 'json';
        }
      } else {
        // Get data in selected format for SQLite
        const sqliteData = dbService.exportToFormat(format);
        if (!sqliteData) {
          toast({
            title: "Error",
            description: "No database loaded or empty database",
            variant: "destructive"
          });
          return;
        }
        exportData = sqliteData;
      }
      
      // Check if we have data to export
      if (!exportData || exportData.length === 0) {
        toast({
          title: "Error",
          description: "No data to export",
          variant: "destructive"
        });
        return;
      }
      
      if (!window.electron) {
        toast({
          title: "Error",
          description: "Electron API not available",
          variant: "destructive"
        });
        return;
      }
      
      // Export the data
      const result = await window.electron.exportDatabase(exportData, exportFormat);
      
      if (result.success) {
        toast({
          title: "Success",
          description: `${isPostgres ? 'Table' : 'Database'} exported successfully as ${exportFormat.toUpperCase()}`
        });
        onOpenChange(false);
      } else if (result.error !== 'Export cancelled') {
        toast({
          title: "Error",
          description: result.error || `Failed to export ${isPostgres ? 'table' : 'database'} as ${exportFormat.toUpperCase()}`,
          variant: "destructive"
        });
      }
    } catch (error) {
      toast({
        title: "Error",
        description: `Failed to export ${isPostgres ? 'table' : 'database'}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        variant: "destructive"
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Export {isPostgres ? 'Table' : 'Database'}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          {isPostgres && (
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="table" className="text-right">
                Table
              </Label>
              <Select
                value={selectedTable}
                onValueChange={(value) => setSelectedTable(value)}
              >
                <SelectTrigger className="col-span-3">
                  <SelectValue placeholder="Select table" />
                </SelectTrigger>
                <SelectContent>
                  {exportableTables.map(table => (
                    <SelectItem key={table} value={table}>{table}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="format" className="text-right">
              Format
            </Label>
            <Select
              value={format}
              onValueChange={(value) => setFormat(value as ExportFormat)}
            >
              <SelectTrigger className="col-span-3">
                <SelectValue placeholder="Select format" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="csv">CSV</SelectItem>
                <SelectItem value="json">JSON</SelectItem>
                {!isPostgres && <SelectItem value="xlsx">Excel</SelectItem>}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={isExporting || (isPostgres && !selectedTable)}>
            {isExporting ? 'Exporting...' : 'Export'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
} 