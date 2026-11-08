import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Braces,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Filter,
  KeyRound,
  Link2,
  MoreVertical,
  Plus,
  ScanSearch,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { DataGrid, type CellPosition, type GridColumn } from '@/components/DataGrid';
import { defaultCell } from '@/components/DataGrid/defaultCell';
import { EditDialog } from '@/components/EditDialog';
import { JsonViewer } from '@/components/JsonViewer';
import { VectorBadge } from '@/components/VectorAdmin/VectorBadge';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { copyText } from '@/lib/clipboard';
import {
  FILTER_OPS,
  primaryKeyColumns,
  quoteIdent,
  type ColumnFilter,
  type ColumnInfo,
  type FilterOp,
  type ForeignKeyInfo,
  type ReferencingKey,
  type RowData,
  type TablePage,
  type TableQuery,
} from '@/lib/types';
import type { VectorColumnInfo } from '@/lib/db/pgClient';
import type { OpenConnection } from '@/lib/db/connections';
import { asJsonDocument, editText, parseCellText, typeFamily } from '@/lib/db/cellParse';
import { COPY_FORMATS, cellText, formatRows, type CopyFormat } from '@/lib/db/sqlLiteral';

interface TableEditorProps {
  conn: OpenConnection;
  tableName: string;
  page: TablePage;
  columnInfo: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
  query: TableQuery;
  onQueryChange: (query: TableQuery) => void;
  onUpdateRow: (oldRow: RowData, newRow: RowData) => Promise<boolean>;
  onInsertRow: (values: RowData) => Promise<boolean>;
  onDeleteRows: (rows: RowData[]) => Promise<boolean>;
  /** Follow a foreign key: open that table filtered to the rows it names. */
  onNavigate: (table: string, filters: ColumnFilter[]) => void;
  onImport: () => void;
  /** Bumped by the command palette to open the insert dialog. */
  insertRequest: number;
  vectorColumns?: VectorColumnInfo[];
  onInspectVector?: (value: unknown, columnName: string, rowId?: string | number, tableName?: string) => void;
  onFindSimilar?: (row: RowData) => void;
}

const PAGE_SIZES = [50, 100, 250, 500, 1000];

/** True while focus is in something you type into, where Delete edits text. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function describeFilter(filter: ColumnFilter): string {
  const op = FILTER_OPS.find((o) => o.value === filter.op);
  if (!op?.needsValue) return `${filter.column} ${op?.label ?? filter.op}`;
  const value = filter.value === null ? 'NULL' : cellText(filter.value);
  return `${filter.column} ${filter.op === 'contains' ? 'contains' : filter.op} ${value.length > 40 ? value.slice(0, 40) + '…' : value}`;
}

function InlineEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (text: string, move: 'down' | 'right' | 'left' | null) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (move: 'down' | 'right' | 'left' | null) => {
    if (done.current) return;
    done.current = true;
    onCommit(text, move);
  };
  return (
    <input
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish('down');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish(e.shiftKey ? 'left' : 'right');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      className="h-full w-full bg-background px-2 text-xs outline outline-2 -outline-offset-2 outline-key tabular-nums"
      spellCheck={false}
    />
  );
}

const TableEditor = ({
  conn,
  tableName,
  page,
  columnInfo,
  foreignKeys,
  query,
  onQueryChange,
  onUpdateRow,
  onInsertRow,
  onDeleteRows,
  onNavigate,
  onImport,
  insertRequest,
  vectorColumns = [],
  onInspectVector,
  onFindSimilar,
}: TableEditorProps) => {
  const { columns, rows: rowObjects, total: totalRows, rowLocator, readOnly = false, totalEstimated } = page;
  const [searchInput, setSearchInput] = useState(query.search ?? '');
  const [editingRow, setEditingRow] = useState<RowData | null>(null);
  const [insertValues, setInsertValues] = useState<RowData | null>(null);
  const [editingCell, setEditingCell] = useState<CellPosition | null>(null);
  /** Picked rows by key, kept across pages so a delete can span them. */
  const [selectedRows, setSelectedRows] = useState<Map<string, RowData>>(new Map());
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [jsonCell, setJsonCell] = useState<{ row: RowData; column: string; value: unknown } | null>(null);
  const [referencing, setReferencing] = useState<ReferencingKey[] | null>(null);
  const [filterDraft, setFilterDraft] = useState<{ column: string; op: FilterOp; value: string } | null>(null);
  const client = conn.client;
  const dialect = conn.dialect;

  const filters = query.filters ?? [];
  const sortColumn = query.sortColumn ?? null;
  const sortDirection = query.sortDirection ?? 'asc';
  const currentPage = Math.floor(query.offset / query.limit) + 1;
  const totalPages = Math.max(1, Math.ceil(totalRows / query.limit));

  // Search runs a query per keystroke otherwise; wait for a short pause.
  useEffect(() => {
    if (searchInput === (query.search ?? '')) return;
    const timer = setTimeout(() => onQueryChange({ ...query, search: searchInput, offset: 0 }), 250);
    return () => clearTimeout(timer);
  }, [searchInput, query, onQueryChange]);

  const columnInfoMap = useMemo(() => new Map(columnInfo.map((c) => [c.name, c])), [columnInfo]);
  const keyColumns = useMemo(() => primaryKeyColumns(columnInfo), [columnInfo]);
  const canAddressRows = !readOnly && (keyColumns.length > 0 || !!rowLocator);
  const rowKey = useCallback(
    (row: RowData) =>
      keyColumns.length > 0
        ? JSON.stringify(keyColumns.map((col) => row[col.name] ?? null))
        : JSON.stringify(rowLocator ? (row[rowLocator] ?? null) : null),
    [keyColumns, rowLocator],
  );
  const rowsAsArrays = useMemo(() => rowObjects.map((row) => columns.map((c) => row[c])), [rowObjects, columns]);

  /** Single-column foreign keys by source column: the ones a click can follow. */
  const fkByColumn = useMemo(() => {
    const groups = new Map<number, ForeignKeyInfo[]>();
    for (const fk of foreignKeys) groups.set(fk.id, [...(groups.get(fk.id) ?? []), fk]);
    const map = new Map<string, ForeignKeyInfo[]>();
    for (const group of groups.values()) {
      const sorted = [...group].sort((a, b) => a.seq - b.seq);
      for (const part of sorted) map.set(part.from, sorted);
    }
    return map;
  }, [foreignKeys]);

  const vectorFor = (column: string) => vectorColumns.find((vc) => vc.tableName === tableName && vc.columnName === column);
  const hasVectorColumns = vectorColumns.some((vc) => vc.tableName === tableName);

  const gridColumns: GridColumn[] = useMemo(
    () => columns.map((name) => ({ key: name, title: name, type: columnInfoMap.get(name)?.type })),
    [columns, columnInfoMap],
  );

  // --- actions ---------------------------------------------------------------

  const followForeignKey = useCallback(
    (row: RowData, column: string) => {
      const parts = fkByColumn.get(column);
      if (!parts) return;
      const filtersForKey: ColumnFilter[] = parts.map((p) => ({ column: p.to || p.from, op: '=', value: row[p.from] }));
      if (filtersForKey.some((f) => f.value === null || f.value === undefined)) {
        toast({ title: 'Nothing to follow', description: `${column} is NULL, so it points at no row.` });
        return;
      }
      onNavigate(parts[0].table, filtersForKey);
    },
    [fkByColumn, onNavigate],
  );

  const copyRows = async (rows: RowData[], format: CopyFormat) => {
    try {
      const text = formatRows(
        columns,
        rows.map((row) => columns.map((c) => row[c])),
        format,
        { dialect, table: client.qualified(tableName), quotedColumns: columns.map((c) => quoteIdent(c, 'column')) },
      );
      await copyText(text);
      toast({ title: 'Copied', description: `${rows.length.toLocaleString()} ${rows.length === 1 ? 'row' : 'rows'} as ${COPY_FORMATS.find((f) => f.value === format)?.label.split(' (')[0]}.` });
    } catch (error) {
      toast({ title: 'Not copied', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    }
  };

  const copyCell = async (cell: CellPosition) => {
    const value = rowsAsArrays[cell.row]?.[cell.col];
    await copyText(value === null || value === undefined ? '' : cellText(value));
  };

  const startEdit = (cell: CellPosition) => {
    const column = columns[cell.col];
    const row = rowObjects[cell.row];
    if (!row || !column) return;
    if (!canAddressRows) {
      toast({
        title: "Rows can't be edited here",
        description: readOnly ? `${tableName} is a view, so it is read-only.` : 'This table has no primary key, so a single row cannot be addressed. Use the SQL editor.',
      });
      return;
    }
    const info = columnInfoMap.get(column);
    const value = row[column];
    if (value instanceof Uint8Array || (value !== null && typeof value === 'object')) {
      setEditingRow({ ...row });
      return;
    }
    const doc = asJsonDocument(value);
    if (doc !== undefined || (info && typeFamily(info.type) === 'json')) {
      setJsonCell({ row, column, value: doc ?? value });
      return;
    }
    if (typeof value === 'string' && (value.length > 200 || value.includes('\n'))) {
      setEditingRow({ ...row });
      return;
    }
    setEditingCell(cell);
  };

  const commitCell = async (cell: CellPosition, text: string) => {
    setEditingCell(null);
    const column = columns[cell.col];
    const row = rowObjects[cell.row];
    const info = columnInfoMap.get(column);
    if (!row || !info) return;
    if (text === editText(row[column])) return;
    const parsed = parseCellText(info, text);
    if (!parsed.ok) {
      toast({ title: 'Not saved', description: parsed.error, variant: 'destructive' });
      return;
    }
    await onUpdateRow(row, { ...row, [column]: parsed.value });
  };

  const setNull = async (cell: CellPosition) => {
    const column = columns[cell.col];
    const row = rowObjects[cell.row];
    const info = columnInfoMap.get(column);
    if (!row || !info) return;
    if (info.notnull) {
      toast({ title: 'Not saved', description: `${column} cannot be NULL.`, variant: 'destructive' });
      return;
    }
    await onUpdateRow(row, { ...row, [column]: null });
  };

  const openInsert = useCallback((prefill: RowData = {}) => {
    if (readOnly) {
      toast({ title: 'Read-only', description: `${tableName} is a view.` });
      return;
    }
    setInsertValues(prefill);
  }, [readOnly, tableName]);

  const lastInsertRequest = useRef(insertRequest);
  useEffect(() => {
    if (insertRequest !== lastInsertRequest.current) {
      lastInsertRequest.current = insertRequest;
      openInsert();
    }
  }, [insertRequest, openInsert]);

  const duplicate = (row: RowData) => {
    const copy: RowData = {};
    for (const column of columns) {
      const info = columnInfoMap.get(column);
      if (info?.generated || (info?.pk && keyColumns.length === 1)) continue;
      copy[column] = row[column];
    }
    openInsert(copy);
  };

  const loadReferencing = async () => {
    if (referencing !== null) return;
    try {
      setReferencing(await client.getReferencingKeys(tableName));
    } catch {
      setReferencing([]);
    }
  };

  const toggleRow = (row: RowData, checked: boolean) => {
    setSelectedRows((prev) => {
      const next = new Map(prev);
      if (checked) next.set(rowKey(row), row);
      else next.delete(rowKey(row));
      return next;
    });
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Delete in the search box, a dialog or the SQL editor edits text; it must
      // not offer to delete the rows that happen to be ticked.
      if (e.key !== 'Delete' || selectedRows.size === 0) return;
      if (isTypingTarget(e.target) || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      setShowDeleteDialog(true);
    },
    [selectedRows],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleDeleteRows = async () => {
    const rows = Array.from(selectedRows.values());
    const ok = await onDeleteRows(rows);
    if (ok) {
      setSelectedRows(new Map());
      toast({ title: 'Deleted', description: `${rows.length.toLocaleString()} ${rows.length === 1 ? 'row' : 'rows'} deleted.` });
    }
    setShowDeleteDialog(false);
  };

  const setSort = (column: string, direction: 'asc' | 'desc' | null) =>
    onQueryChange({ ...query, sortColumn: direction ? column : null, sortDirection: direction ?? 'asc', offset: 0 });

  const addFilter = (filter: ColumnFilter) => onQueryChange({ ...query, filters: [...filters, filter], offset: 0 });
  const removeFilter = (index: number) => onQueryChange({ ...query, filters: filters.filter((_, i) => i !== index), offset: 0 });

  const submitFilterDraft = () => {
    if (!filterDraft) return;
    const op = FILTER_OPS.find((o) => o.value === filterDraft.op);
    addFilter({ column: filterDraft.column, op: filterDraft.op, value: op?.needsValue ? filterDraft.value : undefined });
    setFilterDraft(null);
  };

  // --- rendering -------------------------------------------------------------

  const renderCell = (value: unknown, rowIndex: number, col: number) => {
    const column = columns[col];
    const row = rowObjects[rowIndex];
    const vec = vectorFor(column);
    if (vec && value !== null && value !== undefined) {
      const rowId = keyColumns[0] && row ? (row[keyColumns[0].name] as string | number | undefined) : undefined;
      return <VectorBadge value={value} dimensions={vec.dimensions} onClick={() => onInspectVector?.(value, column, rowId, tableName)} />;
    }
    if (value !== null && value !== undefined && fkByColumn.has(column)) {
      return (
        <span className="inline-flex items-center gap-1">
          <span>{defaultCell(value)}</span>
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => row && followForeignKey(row, column)}
            className="rounded p-0.5 text-key/80 hover:bg-key/15 hover:text-key"
            title={`Open the ${fkByColumn.get(column)![0].table} row this points at`}
          >
            <ArrowRight className="h-3 w-3" />
          </button>
        </span>
      );
    }
    const doc = asJsonDocument(value);
    if (doc !== undefined) {
      return (
        <span className="inline-flex items-center gap-1.5">
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => row && setJsonCell({ row, column, value: doc })}
            className="inline-flex items-center gap-0.5 rounded bg-muted px-1 text-[10px] text-muted-foreground hover:text-foreground"
            title="View JSON"
          >
            <Braces className="h-3 w-3" />
            {Array.isArray(doc) ? `${doc.length}` : 'json'}
          </button>
          <span className="truncate font-mono text-muted-foreground">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
        </span>
      );
    }
    return defaultCell(value);
  };

  const renderHeader = (col: number) => {
    const column = columns[col];
    const info = columnInfoMap.get(column);
    const fk = fkByColumn.get(column);
    return (
      <>
        {info && info.pk > 0 && <KeyRound className="h-3 w-3 shrink-0 text-key" aria-label="Primary key" />}
        {fk && <Link2 className="h-3 w-3 shrink-0 text-key/70" aria-label={`References ${fk[0].table}`} />}
        {sortColumn === column && (sortDirection === 'desc' ? <ArrowDown className="h-3 w-3 shrink-0 text-foreground" /> : <ArrowUp className="h-3 w-3 shrink-0 text-foreground" />)}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" tabIndex={-1} className="shrink-0 rounded p-0.5 opacity-0 group-hover/header:opacity-100 hover:bg-muted data-[state=open]:opacity-100" aria-label={`${column} options`}>
              <MoreVertical className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="font-mono text-xs font-normal text-muted-foreground">
              {info?.type || 'untyped'}
              {info?.notnull ? ' · not null' : ''}
              {info?.defaultValue ? ` · default ${info.defaultValue}` : ''}
              {fk ? ` · → ${fk[0].table}` : ''}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setSort(column, 'asc')}>
              <ArrowUp className="mr-2 h-3.5 w-3.5" /> Sort ascending
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setSort(column, 'desc')}>
              <ArrowDown className="mr-2 h-3.5 w-3.5" /> Sort descending
            </DropdownMenuItem>
            {sortColumn === column && <DropdownMenuItem onClick={() => setSort(column, null)}>Clear sort</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setFilterDraft({ column, op: '=', value: '' })}>
              <Filter className="mr-2 h-3.5 w-3.5" /> Filter…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => addFilter({ column, op: 'is null' })}>Show NULLs only</DropdownMenuItem>
            <DropdownMenuItem onClick={() => addFilter({ column, op: 'is not null' })}>Hide NULLs</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void copyText(column)}>
              <Copy className="mr-2 h-3.5 w-3.5" /> Copy name
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    );
  };

  const contextMenu = (cell: CellPosition) => {
    const row = rowObjects[cell.row];
    if (!row) return null;
    const column = columns[cell.col];
    const value = row[column];
    const doc = asJsonDocument(value);
    const fk = fkByColumn.get(column);
    const targets = selectedRows.size > 0 && selectedRows.has(rowKey(row)) ? Array.from(selectedRows.values()) : [row];
    return (
      <>
        <ContextMenuItem onClick={() => void copyCell(cell)}>
          <Copy className="mr-2 h-3.5 w-3.5" /> Copy cell
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <span className="ml-[22px]">Copy {targets.length > 1 ? `${targets.length} rows` : 'row'} as</span>
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-60">
            {COPY_FORMATS.map((f) => (
              <ContextMenuItem key={f.value} onClick={() => void copyRows(targets, f.value)}>
                {f.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onClick={() => addFilter({ column, op: value === null ? 'is null' : '=', value: value === null ? undefined : value })}>
          <Filter className="mr-2 h-3.5 w-3.5" /> Filter to this value
        </ContextMenuItem>
        <ContextMenuSeparator />
        {fk && value !== null && value !== undefined && (
          <ContextMenuItem onClick={() => followForeignKey(row, column)}>
            <ArrowRight className="mr-2 h-3.5 w-3.5" /> Open in {fk[0].table}
          </ContextMenuItem>
        )}
        <ContextMenuSub onOpenChange={(open) => open && void loadReferencing()}>
          <ContextMenuSubTrigger>
            <Link2 className="mr-2 h-3.5 w-3.5" /> Referenced by
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-64">
            {referencing === null && <ContextMenuItem disabled>Looking…</ContextMenuItem>}
            {referencing?.length === 0 && <ContextMenuItem disabled>No foreign keys point here</ContextMenuItem>}
            {referencing?.map((ref) => (
              <ContextMenuItem
                key={`${ref.table}:${ref.columns.join(',')}`}
                onClick={() => {
                  const values = ref.refColumns.map((c) => row[c]);
                  if (values.some((v) => v === undefined)) {
                    toast({ title: 'Cannot follow', description: 'This row lacks the referenced column.' });
                    return;
                  }
                  onNavigate(ref.table, ref.columns.map((c, i) => ({ column: c, op: '=', value: values[i] })));
                }}
              >
                <span className="truncate">
                  {ref.table}
                  <span className="text-muted-foreground"> · {ref.columns.join(', ')}</span>
                </span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        {doc !== undefined && (
          <ContextMenuItem onClick={() => setJsonCell({ row, column, value: doc })}>
            <Braces className="mr-2 h-3.5 w-3.5" /> View JSON
          </ContextMenuItem>
        )}
        {hasVectorColumns && onFindSimilar && (
          <ContextMenuItem onClick={() => onFindSimilar(row)}>
            <ScanSearch className="mr-2 h-3.5 w-3.5" /> Find similar rows
          </ContextMenuItem>
        )}
        {canAddressRows && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => startEdit(cell)}>Edit cell</ContextMenuItem>
            <ContextMenuItem onClick={() => setEditingRow({ ...row })}>Edit row…</ContextMenuItem>
            <ContextMenuItem onClick={() => void setNull(cell)}>Set to NULL</ContextMenuItem>
            <ContextMenuItem onClick={() => duplicate(row)}>Duplicate row</ContextMenuItem>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => {
                setSelectedRows(new Map(targets.map((r) => [rowKey(r), r])));
                setShowDeleteDialog(true);
              }}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete {targets.length > 1 ? `${targets.length} rows` : 'row'}
            </ContextMenuItem>
          </>
        )}
      </>
    );
  };

  const pageAllChecked = canAddressRows && rowObjects.length > 0 && rowObjects.every((row) => selectedRows.has(rowKey(row)));

  return (
    <div className="flex flex-col h-full animate-fade-in">
      <div className="border-b bg-background">
        <div className="flex items-center justify-between gap-3 px-4 h-12">
          <div className="flex items-center gap-2 min-w-0">
            <Database strokeWidth={1.5} className="h-4 w-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-sm font-medium">{tableName}</h1>
            {readOnly && <span className="shrink-0 text-xs text-muted-foreground">view · read-only</span>}
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums" title={totalEstimated ? "The planner's estimate: too many rows to count on every page" : undefined}>
              {totalEstimated ? '≈ ' : ''}
              {totalRows.toLocaleString()} {totalRows === 1 ? 'row' : 'rows'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {selectedRows.size > 0 && (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 text-xs">
                      <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy {selectedRows.size}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    {COPY_FORMATS.map((f) => (
                      <DropdownMenuItem key={f.value} onClick={() => void copyRows(Array.from(selectedRows.values()), f.value)}>
                        {f.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" size="sm" className="h-8 text-xs text-destructive hover:text-destructive" onClick={() => setShowDeleteDialog(true)}>
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Delete {selectedRows.size}
                </Button>
              </>
            )}
            <div className="relative w-56">
              <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Search rows" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} className="pl-8 h-8 text-xs" />
            </div>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setFilterDraft({ column: columns[0] ?? '', op: '=', value: '' })} disabled={columns.length === 0}>
              <Filter className="mr-1.5 h-3.5 w-3.5" /> Filter
            </Button>
            {!readOnly && (
              <>
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onImport} title="Import CSV into this table">
                  <Upload className="h-3.5 w-3.5" />
                </Button>
                <Button size="sm" className="h-8 text-xs" onClick={() => openInsert()}>
                  <Plus className="mr-1 h-3.5 w-3.5" /> Insert row
                </Button>
              </>
            )}
          </div>
        </div>

        {(filters.length > 0 || filterDraft) && (
          <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2.5">
            {filters.map((filter, i) => (
              <span key={i} className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 font-mono text-[11px]">
                {describeFilter(filter)}
                <button type="button" onClick={() => removeFilter(i)} className="rounded hover:bg-background" aria-label="Remove filter">
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {filterDraft && (
              <form
                className="flex items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitFilterDraft();
                }}
              >
                <Select value={filterDraft.column} onValueChange={(v) => setFilterDraft({ ...filterDraft, column: v })}>
                  <SelectTrigger className="h-7 w-40 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {columns.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={filterDraft.op} onValueChange={(v) => setFilterDraft({ ...filterDraft, op: v as FilterOp })}>
                  <SelectTrigger className="h-7 w-36 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTER_OPS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {FILTER_OPS.find((o) => o.value === filterDraft.op)?.needsValue && (
                  <Input autoFocus value={filterDraft.value} onChange={(e) => setFilterDraft({ ...filterDraft, value: e.target.value })} className="h-7 w-44 text-xs" placeholder="value" />
                )}
                <Button type="submit" size="sm" className="h-7 text-xs">
                  Apply
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setFilterDraft(null)}>
                  Cancel
                </Button>
              </form>
            )}
            {filters.length > 1 && !filterDraft && (
              <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => onQueryChange({ ...query, filters: [], offset: 0 })}>
                Clear all
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden">
        <DataGrid
          columns={gridColumns}
          rows={rowsAsArrays}
          rowKey={(i) => (canAddressRows ? rowKey(rowObjects[i]) : String(i))}
          renderCell={renderCell}
          renderHeader={renderHeader}
          onHeaderClick={(col) => {
            const column = columns[col];
            setSort(column, sortColumn === column && sortDirection === 'asc' ? 'desc' : 'asc');
          }}
          checkboxes
          checkboxesDisabled={!canAddressRows}
          isRowChecked={(i) => selectedRows.has(rowKey(rowObjects[i]))}
          onToggleRow={(i, checked) => toggleRow(rowObjects[i], checked)}
          allChecked={pageAllChecked}
          onToggleAll={(checked) => rowObjects.forEach((row) => toggleRow(row, checked))}
          onEditRequest={startEdit}
          onCopy={(cell) => {
            if (selectedRows.size > 0) void copyRows(Array.from(selectedRows.values()), 'tsv');
            else void copyCell(cell);
          }}
          editingCell={editingCell}
          renderEditor={(cell) => (
            <InlineEditor
              initial={editText(rowObjects[cell.row]?.[columns[cell.col]])}
              onCancel={() => setEditingCell(null)}
              onCommit={(text) => void commitCell(cell, text)}
            />
          )}
          contextMenu={contextMenu}
          emptyMessage={filters.length || query.search ? 'No rows match' : 'This table is empty'}
        />
      </div>

      <div className="flex items-center justify-between px-4 py-1.5 border-t bg-background text-xs">
        <div className="flex items-center gap-3 text-muted-foreground tabular-nums">
          <span>
            {totalRows === 0 ? 0 : (query.offset + 1).toLocaleString()}–{Math.min(query.offset + query.limit, totalRows).toLocaleString()} of {totalEstimated ? '≈ ' : ''}
            {totalRows.toLocaleString()}
          </span>
          {canAddressRows && <span className="hidden md:inline text-muted-foreground/70">Double-click a cell to edit · Enter saves · Esc cancels</span>}
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(query.limit)} onValueChange={(v) => onQueryChange({ ...query, limit: Number(v), offset: 0 })}>
            <SelectTrigger className="h-7 w-[104px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} per page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground tabular-nums">
            Page {currentPage.toLocaleString()} of {totalPages.toLocaleString()}
          </span>
          <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => onQueryChange({ ...query, offset: Math.max(0, query.offset - query.limit) })} disabled={currentPage <= 1} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => onQueryChange({ ...query, offset: query.offset + query.limit })} disabled={currentPage >= totalPages} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <EditDialog
        open={editingRow !== null}
        onOpenChange={(open) => !open && setEditingRow(null)}
        row={editingRow ?? {}}
        columns={columns}
        columnInfo={columnInfo}
        onSave={async (updated) => {
          if (!editingRow) return;
          await onUpdateRow(editingRow, updated);
        }}
      />

      <EditDialog
        open={insertValues !== null}
        onOpenChange={(open) => !open && setInsertValues(null)}
        row={insertValues ?? {}}
        columns={columnInfo.map((c) => c.name)}
        columnInfo={columnInfo}
        mode="insert"
        onSave={(values) => onInsertRow(values)}
      />

      <JsonViewer
        open={jsonCell !== null}
        onOpenChange={(open) => !open && setJsonCell(null)}
        title={jsonCell ? `${tableName}.${jsonCell.column}` : ''}
        value={jsonCell?.value}
        onSave={
          canAddressRows && jsonCell
            ? (text) => onUpdateRow(jsonCell.row, { ...jsonCell.row, [jsonCell.column]: text })
            : undefined
        }
      />

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selectedRows.size.toLocaleString()} {selectedRows.size === 1 ? 'row' : 'rows'}?
            </AlertDialogTitle>
            <AlertDialogDescription>They are removed from {tableName}. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className={cn('bg-destructive text-destructive-foreground hover:bg-destructive/90')} onClick={() => void handleDeleteRows()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default TableEditor;
