import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { toast } from '@/hooks/use-toast';
import { tauriService } from '@/lib/tauri';
import { csvRow, rowsToJson } from '@/lib/exportFormat';
import { buildXlsx } from '@/lib/xlsx';
import { formatRows } from '@/lib/db/sqlLiteral';
import { quoteIdent } from '@/lib/types';
import { visibleTables, type OpenConnection } from '@/lib/db/connections';

type DataFormat = 'csv' | 'json' | 'xlsx' | 'sql';
type ImageFormat = 'png' | 'svg';

const ALL = '__all__';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conn: OpenConnection;
  mode?: 'data' | 'schema';
  /** Preselected table: the one on screen. */
  initialTable?: string;
  onExportSchema?: (format: ImageFormat) => Promise<void>;
}

export function ExportDialog({ open, onOpenChange, conn, mode = 'data', initialTable, onExportSchema }: ExportDialogProps) {
  const tables = visibleTables(conn);
  const [format, setFormat] = useState<DataFormat | ImageFormat>(mode === 'schema' ? 'png' : 'csv');
  const [table, setTable] = useState<string>(initialTable || ALL);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormat(mode === 'schema' ? 'png' : 'csv');
    setTable(initialTable && tables.some((t) => t.name === initialTable) ? initialTable : ALL);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  const exportData = async () => {
    const targets = table === ALL ? tables.map((t) => t.name) : [table];
    if (targets.length === 0) {
      toast({ title: 'Nothing to export', description: 'This database has no tables.' });
      return;
    }
    const data = await Promise.all(targets.map(async (name) => ({ name, ...(await conn.client.exportTable(name)) })));
    let output: string | Uint8Array;
    let extension: string = format;
    if (format === 'xlsx') {
      output = buildXlsx(data.map((d) => ({ name: d.name, columns: d.columns, rows: d.rows })));
    } else if (format === 'json') {
      output =
        data.length === 1
          ? JSON.stringify(rowsToJson(data[0].rows), null, 2)
          : JSON.stringify(Object.fromEntries(data.map((d) => [d.name, rowsToJson(d.rows)])), null, 2);
    } else if (format === 'sql') {
      extension = 'sql';
      output = data
        .map((d) =>
          d.rows.length === 0
            ? `-- ${d.name}: no rows`
            : formatRows(
                d.columns,
                d.rows.map((r) => d.columns.map((c) => r[c])),
                'insert',
                { dialect: conn.dialect, table: conn.client.qualified(d.name), quotedColumns: d.columns.map((c) => quoteIdent(c, 'column')) },
              ),
        )
        .join('\n\n') + '\n';
    } else {
      // One table is plain CSV. Several go in one file, each under its name.
      output = data
        .map((d) => {
          const lines = [csvRow(d.columns), ...d.rows.map((r) => csvRow(d.columns.map((c) => r[c])))];
          return data.length === 1 ? lines.join('\n') : `Table: ${d.name}\n${lines.join('\n')}`;
        })
        .join('\n\n\n') + '\n';
    }
    const saved = await tauriService.exportDatabase(output, extension);
    if (saved.success) {
      const rows = data.reduce((n, d) => n + d.rows.length, 0);
      toast({ title: 'Exported', description: `${rows.toLocaleString()} rows from ${data.length === 1 ? data[0].name : `${data.length} tables`}.` });
      onOpenChange(false);
    } else if (saved.error !== 'Export cancelled') {
      toast({ title: 'Export failed', description: saved.error, variant: 'destructive' });
    }
  };

  const handleExport = async () => {
    setBusy(true);
    try {
      if (mode === 'schema') {
        await onExportSchema?.(format as ImageFormat);
        onOpenChange(false);
      } else {
        await exportData();
      }
    } catch (error) {
      toast({ title: 'Export failed', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{mode === 'schema' ? 'Export schema diagram' : 'Export data'}</DialogTitle>
          <DialogDescription>{mode === 'schema' ? 'Save the diagram as an image.' : 'Every row, not just the page on screen.'}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          {mode === 'data' && (
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Table</Label>
              <Select value={table} onValueChange={setTable}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All {tables.length} tables</SelectItem>
                  {tables.map((t) => (
                    <SelectItem key={t.name} value={t.name}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Format</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as DataFormat | ImageFormat)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {mode === 'data' ? (
                  <>
                    <SelectItem value="csv">CSV</SelectItem>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="xlsx">Excel (one sheet per table)</SelectItem>
                    <SelectItem value="sql">SQL INSERT statements</SelectItem>
                  </>
                ) : (
                  <>
                    <SelectItem value="png">PNG image</SelectItem>
                    <SelectItem value="svg">SVG image</SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleExport()} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
