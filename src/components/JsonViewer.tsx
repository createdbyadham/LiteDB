import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { copyText } from '@/lib/clipboard';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

function Node({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isObject = value !== null && typeof value === 'object';
  const entries = isObject ? Object.entries(value as Record<string, unknown>) : [];
  const isArray = Array.isArray(value);
  const label = name !== null && <span className="text-key">{isArray ? '' : `"${name}"`}</span>;

  if (!isObject) {
    const literal =
      typeof value === 'string' ? (
        <span className="text-positive break-all">"{value}"</span>
      ) : value === null ? (
        <span className="text-muted-foreground italic">null</span>
      ) : (
        <span className="text-[hsl(210_80%_60%)]">{String(value)}</span>
      );
    return (
      <div className="pl-4">
        {label}
        {name !== null && <span className="text-muted-foreground">{isArray ? '' : ': '}</span>}
        {literal}
      </div>
    );
  }

  return (
    <div className={cn(depth > 0 && 'pl-4')}>
      <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-0.5 hover:text-foreground">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {label}
        {name !== null && !isArray && <span className="text-muted-foreground">: </span>}
        <span className="text-muted-foreground">
          {isArray ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </button>
      {open && entries.map(([key, child]) => <Node key={key} name={isArray ? null : key} value={child} depth={depth + 1} />)}
    </div>
  );
}

export interface JsonViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  value: unknown;
  /** When set, the document can be edited and saved back. */
  onSave?: (text: string) => Promise<boolean> | boolean;
}

export function JsonViewer({ open, onOpenChange, title, value, onSave }: JsonViewerProps) {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pretty);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEditing(false);
      setDraft(pretty);
      setError(null);
    }
  }, [open, pretty]);

  const save = async () => {
    try {
      JSON.parse(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    const ok = await onSave?.(JSON.stringify(JSON.parse(draft)));
    if (ok) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle className="font-mono text-sm">{title}</DialogTitle>
          <DialogDescription>JSON document</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto border-y px-6 py-4 font-mono text-xs leading-relaxed">
          {editing ? (
            <Textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              className="min-h-[360px] font-mono text-xs"
              spellCheck={false}
            />
          ) : (
            <Node name={null} value={value} depth={0} />
          )}
          {error && <p className="mt-2 text-destructive">{error}</p>}
        </div>
        <DialogFooter className="px-6 py-4 gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await copyText(pretty);
              toast({ title: 'Copied', description: 'JSON copied to the clipboard.' });
            }}
          >
            <Copy className="mr-1.5 h-3.5 w-3.5" /> Copy
          </Button>
          {onSave &&
            (editing ? (
              <Button size="sm" onClick={() => void save()}>
                Save
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                Edit
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
