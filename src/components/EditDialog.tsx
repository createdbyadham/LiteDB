import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ColumnInfo, RowData } from '@/lib/dbService';
import { toast } from '@/hooks/use-toast';

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
  const [editedValues, setEditedValues] = useState<RowData>({ ...row });

  // Update editedValues when row changes
  useEffect(() => {
    setEditedValues({ ...row });
  }, [row]);

  const handleInputChange = (column: string, value: string) => {
    const columnDef = columnInfo.find(col => col.name === column);
    if (!columnDef) return;

    let finalValue: unknown = value;

    // Handle empty values
    if (value === '') {
      if (columnDef.notnull) {
        // For NOT NULL columns, prevent clearing
        toast({
          title: "Error",
          description: `${column} cannot be null`,
          variant: "destructive"
        });
        return;
      }
      finalValue = null;
    } else {
      // Type conversion based on column type
      try {
        if (columnDef.type.toLowerCase().includes('int')) {
          finalValue = parseInt(value, 10);
          if (isNaN(finalValue as number)) throw new Error('Invalid integer');
        } else if (columnDef.type.toLowerCase().includes('float') || columnDef.type.toLowerCase().includes('real')) {
          finalValue = parseFloat(value);
          if (isNaN(finalValue as number)) throw new Error('Invalid number');
        } else if (columnDef.type.toLowerCase() === 'boolean') {
          finalValue = value.toLowerCase() === 'true';
        }
      } catch (error) {
        toast({
          title: "Error",
          description: `Invalid value for ${column}`,
          variant: "destructive"
        });
        return;
      }
    }

    setEditedValues(prev => ({
      ...prev,
      [column]: finalValue
    }));
  };

  const handleSave = () => {
    // Validate required fields
    const missingRequired = columnInfo
      .filter(col => col.notnull)
      .find(col => editedValues[col.name] === null || editedValues[col.name] === undefined);

    if (missingRequired) {
      toast({
        title: "Error",
        description: `${missingRequired.name} is required`,
        variant: "destructive"
      });
      return;
    }

    onSave(editedValues);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[80vh]">
        <DialogHeader className="border-b pb-6">
          <DialogTitle>Edit Row</DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto py-4 px-2" style={{ maxHeight: "calc(80vh - 140px)" }}>
          <div className="grid gap-3">
            {columns.map((column) => {
              const info = columnInfo.find(col => col.name === column);
              const isPK = info?.pk === 1;
              return (
                <div key={column} className="grid grid-cols-12 items-center gap-3">
                  <Label htmlFor={column} className="text-right col-span-3">
                    <div className="truncate">
                      {column}
                      {info?.notnull && <span className="text-destructive">*</span>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 truncate">
                      {info?.type || 'text'}
                    </div>
                  </Label>
                  <Input
                    id={column}
                    value={editedValues[column] === null ? '' : String(editedValues[column])}
                    onChange={(e) => handleInputChange(column, e.target.value)}
                    className="col-span-9"
                    disabled={isPK}
                    placeholder={info?.type || 'text'}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <DialogFooter className="border-t pt-6 mt-auto">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
} 