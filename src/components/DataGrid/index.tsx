// A virtualized grid for the table editor and the SQL editor's results.
//
// Only the rows in view are in the DOM, so a 10,000-row result scrolls like a
// 10-row one. The SQL editor used to render every row as a <tr>, which is how
// `SELECT *` on a large table hung the window.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Checkbox } from '@/components/ui/checkbox';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { cellText } from '@/lib/db/sqlLiteral';

export interface GridColumn {
  key: string;
  title: string;
  /** Declared type, shown in the header tooltip and used for alignment. */
  type?: string;
}

export interface CellPosition {
  row: number;
  col: number;
}

export interface DataGridProps {
  columns: GridColumn[];
  rows: unknown[][];
  rowKey?: (index: number) => string;
  /** Default rendering when absent. */
  renderCell?: (value: unknown, row: number, col: number) => React.ReactNode;
  /** Extra controls after a header title (sort arrow, menu). */
  renderHeader?: (col: number) => React.ReactNode;
  onHeaderClick?: (col: number) => void;
  /** Checkbox column for picking rows. */
  checkboxes?: boolean;
  isRowChecked?: (row: number) => boolean;
  onToggleRow?: (row: number, checked: boolean) => void;
  allChecked?: boolean;
  onToggleAll?: (checked: boolean) => void;
  checkboxesDisabled?: boolean;
  /** Called on double-click, Enter or F2. */
  onEditRequest?: (cell: CellPosition) => void;
  /** Called on Ctrl/Cmd+C. Defaults to copying the cell's text. */
  onCopy?: (cell: CellPosition) => void;
  editingCell?: CellPosition | null;
  renderEditor?: (cell: CellPosition) => React.ReactNode;
  contextMenu?: (cell: CellPosition) => React.ReactNode;
  emptyMessage?: React.ReactNode;
  className?: string;
  /** Pixel height of a row. */
  rowHeight?: number;
}

const DEFAULT_ROW_HEIGHT = 32;
const CHECKBOX_WIDTH = 40;
const MIN_WIDTH = 64;
const MAX_WIDTH = 420;

function isNumericType(type?: string): boolean {
  return !!type && /int|real|floa|doub|numeric|decimal|money|serial/i.test(type) && !/interval|point/i.test(type);
}

export function defaultCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined) return <span className="text-muted-foreground/70 italic">NULL</span>;
  if (value instanceof Uint8Array) {
    return <span className="text-muted-foreground">{value.length.toLocaleString()} bytes</span>;
  }
  if (typeof value === 'boolean') return <span className="font-mono">{value ? 'true' : 'false'}</span>;
  const text = cellText(value);
  return text.length > 300 ? text.slice(0, 300) + '…' : text;
}

/** A starting width from the header and the first rows' text. */
function initialWidths(columns: GridColumn[], rows: unknown[][]): number[] {
  return columns.map((column, i) => {
    let longest = column.title.length + 3;
    for (let r = 0; r < Math.min(rows.length, 60); r++) {
      const value = rows[r]?.[i];
      const length = value === null || value === undefined ? 4 : Math.min(cellText(value).length, 60);
      if (length > longest) longest = length;
    }
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(longest * 7.4 + 28)));
  });
}

export function DataGrid({
  columns,
  rows,
  rowKey,
  renderCell,
  renderHeader,
  onHeaderClick,
  checkboxes = false,
  isRowChecked,
  onToggleRow,
  allChecked = false,
  onToggleAll,
  checkboxesDisabled = false,
  onEditRequest,
  onCopy,
  editingCell,
  renderEditor,
  contextMenu,
  emptyMessage = 'No rows',
  className,
  rowHeight = DEFAULT_ROW_HEIGHT,
}: DataGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rows));
  const [active, setActive] = useState<CellPosition | null>(null);
  const columnsKey = columns.map((c) => c.key).join('\u0000');

  // New columns (a different result) start from fresh widths.
  useLayoutEffect(() => {
    setWidths(initialWidths(columns, rows));
    setActive(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey]);

  const totalWidth = useMemo(
    () => widths.reduce((sum, w) => sum + w, 0) + (checkboxes ? CHECKBOX_WIDTH : 0),
    [widths, checkboxes],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    getItemKey: rowKey ? (index) => rowKey(index) : undefined,
  });

  const scrollToCell = useCallback(
    (cell: CellPosition) => {
      virtualizer.scrollToIndex(cell.row, { align: 'auto' });
      const el = scrollRef.current;
      if (!el) return;
      let left = checkboxes ? CHECKBOX_WIDTH : 0;
      for (let i = 0; i < cell.col; i++) left += widths[i] ?? 0;
      const right = left + (widths[cell.col] ?? 0);
      if (left < el.scrollLeft + (checkboxes ? CHECKBOX_WIDTH : 0)) el.scrollLeft = left - (checkboxes ? CHECKBOX_WIDTH : 0);
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    },
    [virtualizer, widths, checkboxes],
  );

  const move = (cell: CellPosition) => {
    const next = {
      row: Math.max(0, Math.min(rows.length - 1, cell.row)),
      col: Math.max(0, Math.min(columns.length - 1, cell.col)),
    };
    setActive(next);
    scrollToCell(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (editingCell) return;
    if (!active) {
      if (rows.length > 0 && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        move({ row: 0, col: 0 });
      }
      return;
    }
    const pageRows = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / rowHeight) - 1);
    const mod = event.ctrlKey || event.metaKey;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move({ ...active, row: mod ? rows.length - 1 : active.row + 1 });
        break;
      case 'ArrowUp':
        event.preventDefault();
        move({ ...active, row: mod ? 0 : active.row - 1 });
        break;
      case 'ArrowRight':
        event.preventDefault();
        move({ ...active, col: mod ? columns.length - 1 : active.col + 1 });
        break;
      case 'ArrowLeft':
        event.preventDefault();
        move({ ...active, col: mod ? 0 : active.col - 1 });
        break;
      case 'Tab':
        event.preventDefault();
        move({ ...active, col: active.col + (event.shiftKey ? -1 : 1) });
        break;
      case 'Home':
        event.preventDefault();
        move({ ...active, col: 0, row: mod ? 0 : active.row });
        break;
      case 'End':
        event.preventDefault();
        move({ ...active, col: columns.length - 1, row: mod ? rows.length - 1 : active.row });
        break;
      case 'PageDown':
        event.preventDefault();
        move({ ...active, row: active.row + pageRows });
        break;
      case 'PageUp':
        event.preventDefault();
        move({ ...active, row: active.row - pageRows });
        break;
      case 'Enter':
      case 'F2':
        if (onEditRequest) {
          event.preventDefault();
          onEditRequest(active);
        }
        break;
      case 'Escape':
        setActive(null);
        break;
      default:
        if (mod && (event.key === 'c' || event.key === 'C')) {
          event.preventDefault();
          if (onCopy) onCopy(active);
          else void navigator.clipboard.writeText(cellText(rows[active.row]?.[active.col]));
        }
    }
  };

  // Keep the active cell valid when rows change under it (a refresh after a write).
  useEffect(() => {
    if (active && (active.row >= rows.length || active.col >= columns.length)) setActive(null);
  }, [rows.length, columns.length, active]);

  // When an inline edit ends, give focus back to the grid so arrows keep working.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editingCell) scrollRef.current?.focus();
    wasEditing.current = !!editingCell;
  }, [editingCell]);

  const startResize = (col: number, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widths[col];
    const onMove = (e: MouseEvent) => {
      const next = Math.max(MIN_WIDTH, Math.min(1200, startWidth + e.clientX - startX));
      setWidths((w) => w.map((value, i) => (i === col ? next : value)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn('relative h-full overflow-auto outline-none text-xs', className)}
      role="grid"
      aria-rowcount={rows.length}
      aria-colcount={columns.length}
    >
      <div style={{ width: totalWidth, minWidth: '100%' }}>
        {/* Header */}
        <div className="sticky top-0 z-20 flex border-b bg-background" style={{ height: rowHeight + 4 }} role="row">
          {checkboxes && (
            <div className="sticky left-0 z-10 flex items-center justify-center bg-background border-r" style={{ width: CHECKBOX_WIDTH }}>
              <Checkbox
                disabled={checkboxesDisabled || rows.length === 0}
                checked={allChecked && rows.length > 0}
                onCheckedChange={(checked) => onToggleAll?.(checked === true)}
                aria-label="Select all rows on this page"
              />
            </div>
          )}
          {columns.map((column, col) => (
            <div
              key={column.key}
              role="columnheader"
              className="group/header relative flex items-center gap-1 border-r px-2 font-medium text-muted-foreground"
              style={{ width: widths[col] }}
              title={column.type ? `${column.title} · ${column.type}` : column.title}
            >
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left hover:text-foreground"
                onClick={() => onHeaderClick?.(col)}
                tabIndex={-1}
              >
                {column.title}
              </button>
              {renderHeader?.(col)}
              <span
                onMouseDown={(e) => startResize(col, e)}
                className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize opacity-0 group-hover/header:opacity-100 hover:bg-key/40"
                aria-hidden
              />
            </div>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground" style={{ width: '100%' }}>
            {emptyMessage}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((item) => {
              const row = rows[item.index];
              const checked = isRowChecked?.(item.index) ?? false;
              const rowEl = (
                <div
                  role="row"
                  aria-rowindex={item.index + 1}
                  className={cn(
                    'absolute left-0 flex border-b border-border/60 hover:bg-muted/40',
                    checked && 'bg-key/10 hover:bg-key/15',
                  )}
                  style={{ top: 0, transform: `translateY(${item.start}px)`, height: rowHeight, width: totalWidth, minWidth: '100%' }}
                >
                  {checkboxes && (
                    <div className="sticky left-0 z-10 flex items-center justify-center border-r bg-background" style={{ width: CHECKBOX_WIDTH }}>
                      <Checkbox
                        disabled={checkboxesDisabled}
                        checked={checked}
                        onCheckedChange={(value) => onToggleRow?.(item.index, value === true)}
                        aria-label={`Select row ${item.index + 1}`}
                      />
                    </div>
                  )}
                  {columns.map((column, col) => {
                    const isActive = active?.row === item.index && active.col === col;
                    const isEditing = editingCell?.row === item.index && editingCell.col === col;
                    return (
                      <div
                        key={column.key}
                        role="gridcell"
                        className={cn(
                          'relative flex items-center overflow-hidden whitespace-nowrap border-r border-border/60 px-2 tabular-nums',
                          isNumericType(column.type) && 'justify-end',
                          isActive && !isEditing && 'outline outline-2 -outline-offset-2 outline-key/80 bg-key/5',
                          isEditing && 'p-0',
                        )}
                        style={{ width: widths[col] }}
                        onMouseDown={() => setActive({ row: item.index, col })}
                        onDoubleClick={() => onEditRequest?.({ row: item.index, col })}
                      >
                        {isEditing && renderEditor ? (
                          renderEditor({ row: item.index, col })
                        ) : (
                          <span className="truncate">{renderCell ? renderCell(row[col], item.index, col) : defaultCell(row[col])}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
              if (!contextMenu) return <div key={item.key}>{rowEl}</div>;
              return (
                <ContextMenu key={item.key}>
                  <ContextMenuTrigger asChild>{rowEl}</ContextMenuTrigger>
                  <ContextMenuContent className="w-56">{contextMenu(active && active.row === item.index ? active : { row: item.index, col: 0 })}</ContextMenuContent>
                </ContextMenu>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
