import { useEffect, useMemo, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { tauriService } from '@/lib/tauri';
import { ReadOnlyConnectionError } from '@/lib/queryGate';
import { quoteIdent, type ColumnInfo } from '@/lib/types';
import { DELIMITERS, detectDelimiter, headerNames, inferColumnType, parseCsv, sqlTypeFor, type Delimiter, type InferredType } from '@/lib/db/csv';
import { fileName } from '@/lib/db/savedConnections';
import { auditGridWrite } from '@/lib/db/audit';
import { refreshConnectionTables, visibleTables, type OpenConnection } from '@/lib/db/connections';

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conn: OpenConnection;
  /** Import into this table by default. */
  initialTable?: string;
  onImported: (table: string) => void;
}

const SKIP = '__skip__';
const TYPES: InferredType[] = ['integer', 'real', 'boolean', 'date', 'timestamp', 'text'];

function tableNameFrom(path: string): string {
  const base = fileName(path).replace(/\.[^.]+$/, '');
  const cleaned = base.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return /^[a-z_]/.test(cleaned) ? cleaned || 'imported' : `t_${cleaned}`;
}

export function ImportDialog({ open, onOpenChange, conn, initialTable, onImported }: ImportDialogProps) {
  const tables = visibleTables(conn).filter((t) => t.type !== 'view');
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [delimiter, setDelimiter] = useState<Delimiter>(',');
  const [hasHeader, setHasHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [target, setTarget] = useState<'existing' | 'new'>(initialTable ? 'existing' : 'new');
  const [table, setTable] = useState(initialTable ?? '');
  const [newName, setNewName] = useState('');
  const [tableColumns, setTableColumns] = useState<ColumnInfo[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [types, setTypes] = useState<InferredType[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFile(null);
    setTarget(initialTable ? 'existing' : 'new');
    setTable(initialTable ?? tables[0]?.name ?? '');
    setNewName('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialTable]);

  const records = useMemo(() => (file ? parseCsv(file.text, delimiter) : []), [file, delimiter]);
  const width = useMemo(() => records.reduce((n, r) => Math.max(n, r.length), 0), [records]);
  const header = useMemo(
    () => headerNames(hasHeader && records[0] ? Array.from({ length: width }, (_, i) => records[0][i] ?? '') : Array.from({ length: width }, () => '')),
    [records, hasHeader, width],
  );
  const body = useMemo(() => (hasHeader ? records.slice(1) : records), [records, hasHeader]);

  // New table: a type per column from its values.
  useEffect(() => {
    setTypes(header.map((_, i) => inferColumnType(body.slice(0, 2000).map((r) => r[i] ?? ''))));
  }, [header, body]);

  // Existing table: its columns, matched to CSV columns by name.
  useEffect(() => {
    if (target !== 'existing' || !table) return;
    let cancelled = false;
    void conn.client.getColumns(table).then((columns) => {
      if (cancelled) return;
      setTableColumns(columns);
      const auto: Record<string, string> = {};
      for (const col of columns) {
        const match = header.find((h) => h.toLowerCase() === col.name.toLowerCase());
        auto[col.name] = match ?? SKIP;
      }
      setMapping(auto);
    });
    return () => {
      cancelled = true;
    };
  }, [conn.client, target, table, header]);

  const chooseFile = async () => {
    try {
      const picked = await tauriService.openTextFile(['csv', 'tsv', 'txt']);
      if (!picked) return;
      setFile(picked);
      setDelimiter(detectDelimiter(picked.text));
      setNewName(tableNameFrom(picked.path));
    } catch (error) {
      toast({ title: 'Could not read the file', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    }
  };

  const cellValue = (text: string | undefined, type?: InferredType): unknown => {
    const value = text ?? '';
    if (emptyAsNull && value === '') return null;
    // SQLite has no boolean: store 1 and 0, as its own drivers do.
    if (type === 'boolean' && conn.dialect === 'sqlite') {
      const t = value.trim().toLowerCase();
      if (['true', 't', 'yes', 'y', '1'].includes(t)) return 1;
      if (['false', 'f', 'no', 'n', '0'].includes(t)) return 0;
    }
    return value;
  };

  const mappedColumns = Object.entries(mapping).filter(([, csv]) => csv !== SKIP);

  const runImport = async () => {
    if (!file) return;
    setBusy(true);
    const statements: string[] = [];
    try {
      let tableName = table;
      let columns: string[];
      let rows: unknown[][];
      if (target === 'new') {
        tableName = newName.trim();
        if (!tableName) throw new Error('Name the new table.');
        if (conn.tables.some((t) => t.name.toLowerCase() === tableName.toLowerCase())) {
          throw new Error(`${tableName} already exists. Pick another name, or import into it.`);
        }
        statements.push(await conn.client.createTable(tableName, header.map((name, i) => ({ name, type: sqlTypeFor(types[i] ?? 'text', conn.dialect) }))));
        await refreshConnectionTables(conn.id);
        columns = header;
        rows = body.map((r) => header.map((_, i) => cellValue(r[i], types[i])));
      } else {
        if (!tableName) throw new Error('Choose a table.');
        if (mappedColumns.length === 0) throw new Error('Match at least one column.');
        columns = mappedColumns.map(([col]) => col);
        const indexes = mappedColumns.map(([, csv]) => header.indexOf(csv));
        rows = body.map((r) => indexes.map((i) => cellValue(r[i])));
      }
      const { inserted } = await conn.client.importRows(tableName, columns, rows);
      statements.push(
        `INSERT INTO ${conn.client.qualified(tableName)} (${columns.map((c) => quoteIdent(c, 'column')).join(', ')}) VALUES (…) /* ${inserted} rows from ${fileName(file.path)} */`,
      );
      auditGridWrite(conn, statements, { ok: true, rows: inserted });
      toast({ title: 'Imported', description: `${inserted.toLocaleString()} rows into ${tableName}.` });
      onOpenChange(false);
      onImported(tableName);
    } catch (error) {
      if (statements.length) auditGridWrite(conn, statements, { ok: false, error: error instanceof Error ? error.message : String(error) });
      toast({
        title: error instanceof ReadOnlyConnectionError ? 'Read-only connection' : 'Import failed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      });
    } finally {
      setBusy(false);
    }
  };

  const preview = body.slice(0, 6);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle>Import CSV</DialogTitle>
          <DialogDescription>
            {file ? `${fileName(file.path)} · ${body.length.toLocaleString()} rows · ${width} columns` : 'Rows go in inside one transaction: all of them, or none.'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 space-y-5">
          {!file ? (
            <button
              type="button"
              onClick={() => void chooseFile()}
              className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed p-10 text-sm text-muted-foreground hover:bg-muted/40"
            >
              <FileUp className="h-6 w-6" />
              Choose a CSV or TSV file
            </button>
          ) : (
            <>
              <div className="flex flex-wrap items-end gap-4">
                <div className="grid gap-1.5">
                  <Label className="text-xs text-muted-foreground">Delimiter</Label>
                  <Select value={delimiter} onValueChange={(v) => setDelimiter(v as Delimiter)}>
                    <SelectTrigger className="h-8 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DELIMITERS.map((d) => (
                        <SelectItem key={d.label} value={d.value}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 pb-1.5 text-xs cursor-pointer">
                  <Checkbox checked={hasHeader} onCheckedChange={(v) => setHasHeader(v === true)} />
                  First row is a header
                </label>
                <label className="flex items-center gap-2 pb-1.5 text-xs cursor-pointer">
                  <Checkbox checked={emptyAsNull} onCheckedChange={(v) => setEmptyAsNull(v === true)} />
                  Empty fields are NULL
                </label>
                <Button variant="ghost" size="sm" className="ml-auto h-8 text-xs" onClick={() => void chooseFile()}>
                  Another file
                </Button>
              </div>

              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      {header.map((h, i) => (
                        <th key={i} className="whitespace-nowrap px-2 py-1.5 text-left font-medium">
                          {h}
                          {target === 'new' && <span className="ml-1 font-normal text-muted-foreground">{types[i]}</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row, r) => (
                      <tr key={r} className="border-t">
                        {header.map((_, i) => (
                          <td key={i} className="max-w-[200px] truncate whitespace-nowrap px-2 py-1 font-mono">
                            {row[i] === undefined || (row[i] === '' && emptyAsNull) ? <span className="italic text-muted-foreground">NULL</span> : row[i]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex gap-1 rounded-md bg-muted p-1 text-xs w-fit" role="radiogroup" aria-label="Import into">
                {(['new', 'existing'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={target === value}
                    disabled={value === 'existing' && tables.length === 0}
                    onClick={() => setTarget(value)}
                    className={cn('rounded px-3 py-1 transition-colors', target === value ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                  >
                    {value === 'new' ? 'New table' : 'Existing table'}
                  </button>
                ))}
              </div>

              {target === 'new' ? (
                <div className="grid gap-3">
                  <div className="grid gap-1.5 max-w-xs">
                    <Label className="text-xs text-muted-foreground">Table name</Label>
                    <Input value={newName} onChange={(e) => setNewName(e.target.value)} className="h-8 font-mono text-xs" />
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {header.map((h, i) => (
                      <div key={i} className="flex items-center gap-2 rounded-md border px-2 py-1">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{h}</span>
                        <Select value={types[i] ?? 'text'} onValueChange={(v) => setTypes((t) => t.map((x, j) => (j === i ? (v as InferredType) : x)))}>
                          <SelectTrigger className="h-7 w-28 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {TYPES.map((t) => (
                              <SelectItem key={t} value={t}>
                                {sqlTypeFor(t, conn.dialect)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="grid gap-3">
                  <div className="grid gap-1.5 max-w-xs">
                    <Label className="text-xs text-muted-foreground">Table</Label>
                    <Select value={table} onValueChange={setTable}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Choose a table" />
                      </SelectTrigger>
                      <SelectContent>
                        {tables.map((t) => (
                          <SelectItem key={t.name} value={t.name}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {tableColumns.map((col) => (
                      <div key={col.name} className="flex items-center gap-2 rounded-md border px-2 py-1">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={col.type}>
                          {col.name}
                          {col.generated && <span className="ml-1 text-muted-foreground">auto</span>}
                        </span>
                        <span className="text-muted-foreground text-xs">←</span>
                        <Select value={mapping[col.name] ?? SKIP} onValueChange={(v) => setMapping((m) => ({ ...m, [col.name]: v }))}>
                          <SelectTrigger className="h-7 w-40 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={SKIP}>Leave out</SelectItem>
                            {header.map((h) => (
                              <SelectItem key={h} value={h}>
                                {h}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">Columns left out take their default value.</p>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void runImport()} disabled={!file || busy || body.length === 0}>
            {busy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
            Import {body.length ? body.length.toLocaleString() : ''} rows
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
