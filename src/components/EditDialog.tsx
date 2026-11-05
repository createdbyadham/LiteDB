import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ColumnInfo, RowData } from '@/lib/sqliteService';
import { toast } from '@/hooks/use-toast';
import { KeyRound } from 'lucide-react';

interface EditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: RowData;
  columns: string[];
  columnInfo: ColumnInfo[];
  onSave: (updatedRow: RowData) => void;
}

export function EditDialog({
  open,
  onOpenChange,
  row,
  columns,
  columnInfo,
  onSave,
}: EditDialogProps) {
  /**
   * Text typed into each field, only for fields that were touched.
   *
   * Values used to be parsed on every keystroke, which refused "-" and "3."
   * on the way to "-3.5" and refused clearing a required field to retype it.
   * Untouched fields keep their original value, so BLOBs and exact numbers
   * are written back unchanged rather than round-tripped through text.
   */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setDrafts({});
  }, [row]);

  const displayValue = (column: string): string => {
    if (column in drafts) return drafts[column];
    const value = row[column];
    return value === null || value === undefined ? '' : String(value);
  };

  /** Turn a field's text into the value to store, or explain why it can't be. */
  const parseDraft = (info: ColumnInfo | undefined, column: string, text: string): { ok: true; value: unknown } | { ok: false; error: string } => {
    if (text === '') {
      if (info?.notnull) return { ok: false, error: `${column} is required` };
      return { ok: true, value: null };
    }
    const type = (info?.type ?? '').toLowerCase();
    if (/int/.test(type)) {
      if (!/^[+-]?\d+$/.test(text.trim())) return { ok: false, error: `${column} needs a whole number` };
      const n = Number(text);
      return Number.isSafeInteger(n) ? { ok: true, value: n } : { ok: true, value: text.trim() };
    }
    if (/real|floa|doub|numeric|decimal/.test(type)) {
      const n = Number(text);
      if (text.trim() === '' || !Number.isFinite(n)) return { ok: false, error: `${column} needs a number` };
      return { ok: true, value: n };
    }
    if (type === 'boolean' || type === 'bool') {
      const t = text.trim().toLowerCase();
      if (['true', '1', 't', 'yes'].includes(t)) return { ok: true, value: true };
      if (['false', '0', 'f', 'no'].includes(t)) return { ok: true, value: false };
      return { ok: false, error: `${column} needs true or false` };
    }
    return { ok: true, value: text };
  };

  const handleSave = () => {
    const updated: RowData = { ...row };
    for (const [column, text] of Object.entries(drafts)) {
      const info = columnInfo.find(col => col.name === column);
      const parsed = parseDraft(info, column, text);
      if (!parsed.ok) {
        toast({ title: "Row not saved", description: parsed.error, variant: "destructive" });
        return;
      }
      updated[column] = parsed.value;
    }

    onSave(updated);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>Edit row</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto border-y px-6 py-5">
          <div className="grid gap-4">
            {columns.map((column) => {
              const info = columnInfo.find(col => col.name === column);
              const isPK = (info?.pk ?? 0) > 0;
              // Binary can't round-trip through a text box; leave it untouched.
              const isBlob = row[column] instanceof Uint8Array;
              const type = (info?.type || 'text').toLowerCase();
              return (
                <div key={column} className="grid gap-1.5">
                  <Label htmlFor={column} className="flex items-center gap-1.5 text-sm font-medium">
                    {(info?.pk ?? 0) > 0 && <KeyRound className="h-3.5 w-3.5 text-key" aria-label="Primary key" />}
                    <span className="truncate">{column}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs font-normal text-muted-foreground">
                      {type}{info?.notnull ? ' · required' : ''}
                    </span>
                  </Label>
                  <Input
                    id={column}
                    value={isBlob ? `${(row[column] as Uint8Array).length.toLocaleString()} bytes of binary data` : displayValue(column)}
                    onChange={(e) => setDrafts(prev => ({ ...prev, [column]: e.target.value }))}
                    className="tabular-nums"
                    disabled={isPK || isBlob}
                    placeholder={info?.notnull ? '' : 'null'}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter className="px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
} 