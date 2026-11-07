import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import type { ColumnInfo, RowData } from '@/lib/types';
import { toast } from '@/hooks/use-toast';
import { KeyRound, Sparkles } from 'lucide-react';
import { editText, parseCellText, typeFamily } from '@/lib/db/cellParse';
import { OmittedBlob } from '@/lib/db/blob';

interface EditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The row being edited, or the starting values for an insert. */
  row: RowData;
  columns: string[];
  columnInfo: ColumnInfo[];
  /** Insert: empty fields take the column default instead of NULL. */
  mode?: 'edit' | 'insert';
  onSave: (updatedRow: RowData) => void | Promise<unknown>;
}

const LONG_TEXT = 80;

export function EditDialog({ open, onOpenChange, row, columns, columnInfo, mode = 'edit', onSave }: EditDialogProps) {
  /**
   * Text typed into each field, only for fields that were touched.
   *
   * Values are parsed on save, not on every keystroke, so "-" and "3." on the
   * way to "-3.5" are not refused and a required field can be cleared to
   * retype it. Untouched fields keep their original value, so blobs and exact
   * numbers are written back unchanged.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Insert: fields explicitly set to NULL rather than left to their default. */
  const [nulls, setNulls] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const inserting = mode === 'insert';

  useEffect(() => {
    if (!open) return;
    setDrafts({});
    setNulls(new Set());
  }, [row, open]);

  const displayValue = (column: string): string => {
    if (column in drafts) return drafts[column];
    return editText(row[column]);
  };

  const handleSave = async () => {
    const result: RowData = inserting ? {} : { ...row };
    for (const column of columns) {
      const info = columnInfo.find((c) => c.name === column);
      if (!info) continue;
      if (inserting) {
        if (nulls.has(column)) {
          result[column] = null;
          continue;
        }
        const text = column in drafts ? drafts[column] : editText(row[column]);
        // Empty means "let the database decide": the default, or NULL.
        if (text === '') continue;
        const parsed = parseCellText({ ...info, notnull: 0 }, text);
        if (!parsed.ok) {
          toast({ title: 'Row not saved', description: parsed.error, variant: 'destructive' });
          return;
        }
        result[column] = parsed.value;
        continue;
      }
      if (!(column in drafts)) continue;
      const parsed = parseCellText(info, drafts[column]);
      if (!parsed.ok) {
        toast({ title: 'Row not saved', description: parsed.error, variant: 'destructive' });
        return;
      }
      result[column] = parsed.value;
    }
    setSaving(true);
    try {
      const outcome = await onSave(result);
      if (outcome !== false) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>{inserting ? 'Insert row' : 'Edit row'}</DialogTitle>
          {inserting && (
            <DialogDescription>Empty fields take the column default, or NULL if there is none.</DialogDescription>
          )}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto border-y px-6 py-5">
          <div className="grid gap-4">
            {columns.map((column) => {
              const info = columnInfo.find((c) => c.name === column);
              const isPK = (info?.pk ?? 0) > 0;
              const value = row[column];
              // Binary cannot round-trip through a text box; leave it untouched.
              const isBlob = value instanceof Uint8Array || value instanceof OmittedBlob;
              const type = (info?.type || 'text').toLowerCase();
              const text = displayValue(column);
              const multiline = typeFamily(type) === 'json' || text.length > LONG_TEXT || text.includes('\n');
              const disabled = isBlob || (!inserting && isPK) || (inserting && info?.generated && !(column in drafts) && !text);
              const placeholder = inserting
                ? info?.generated
                  ? 'generated'
                  : info?.defaultValue
                    ? `default: ${info.defaultValue}`
                    : info?.notnull
                      ? 'required'
                      : 'NULL'
                : info?.notnull
                  ? ''
                  : 'NULL';
              return (
                <div key={column} className="grid gap-1.5">
                  <Label htmlFor={`field-${column}`} className="flex items-center gap-1.5 text-sm font-medium">
                    {isPK && <KeyRound className="h-3.5 w-3.5 text-key" aria-label="Primary key" />}
                    {inserting && info?.generated && <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-label="Filled in by the database" />}
                    <span className="truncate">{column}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs font-normal text-muted-foreground">
                      {type}
                      {info?.notnull ? ' · required' : ''}
                    </span>
                  </Label>
                  {isBlob ? (
                    <Input id={`field-${column}`} value={String(value instanceof Uint8Array ? `${value.length.toLocaleString()} bytes of binary data` : value)} disabled />
                  ) : multiline ? (
                    <Textarea
                      id={`field-${column}`}
                      value={nulls.has(column) ? '' : text}
                      onChange={(e) => {
                        const next = e.target.value;
                        setDrafts((prev) => ({ ...prev, [column]: next }));
                        setNulls((prev) => {
                          const copy = new Set(prev);
                          copy.delete(column);
                          return copy;
                        });
                      }}
                      className="min-h-[96px] font-mono text-xs"
                      disabled={!!disabled}
                      placeholder={placeholder}
                      spellCheck={false}
                    />
                  ) : (
                    <Input
                      id={`field-${column}`}
                      value={nulls.has(column) ? '' : text}
                      onChange={(e) => {
                        const next = e.target.value;
                        setDrafts((prev) => ({ ...prev, [column]: next }));
                        setNulls((prev) => {
                          const copy = new Set(prev);
                          copy.delete(column);
                          return copy;
                        });
                      }}
                      className="tabular-nums"
                      disabled={!!disabled}
                      placeholder={placeholder}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter className="px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            {inserting ? 'Insert' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
