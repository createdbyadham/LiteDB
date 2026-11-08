import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { mascot } from '@/lib/mascot';
import { shortcutLabel } from '@/lib/commands';
import { ContextMeter } from './ContextMeter';

interface AiInlineBarProps {
  open: boolean;
  onClose: () => void;
  /** Resolves when the SQL is in the editor (or has run, in YOLO). */
  onGenerate: (prompt: string, compact: boolean) => Promise<void>;
  /** YOLO: the generated SQL runs the moment it arrives, and the button says so. */
  runsImmediately: boolean;
  /** Text is selected: the request edits it instead of writing new SQL. */
  editingSelection: boolean;
  /** How the prompt starts, e.g. a table dropped on Star. */
  seed?: string;
}

/**
 * Text to SQL inside the editor (Mod-K), rather than in a dialog over it. The
 * SQL lands at the cursor, or replaces the selection when one is made.
 */
export function AiInlineBar({ open, onClose, onGenerate, runsImmediately, editingSelection, seed }: AiInlineBarProps) {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [compact, setCompact] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Star hops onto the bar while it is open, and home again when it closes.
  useEffect(() => (open ? mascot.perchOn('dialog') : undefined), [open]);

  useEffect(() => {
    if (!open) return;
    if (seed) setPrompt(seed);
    setTimeout(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  }, [open, seed]);

  if (!open) return null;

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    try {
      await onGenerate(prompt.trim(), compact);
      setPrompt('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-mascot-perch="ai" className="relative z-[61] mx-3 mt-2 rounded-lg border bg-card shadow-sm">
      <div className="flex items-start gap-2 p-2">
        <Sparkles className="mt-2 h-4 w-4 shrink-0 text-key" />
        <Textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
          rows={1}
          placeholder={
            editingSelection
              ? 'How should the selected SQL change? e.g. "also group by month"'
              : 'Describe what you want, e.g. "customers who signed up in the last month"'
          }
          className="min-h-[36px] resize-none border-0 bg-transparent px-1 py-2 text-sm shadow-none focus-visible:ring-0"
        />
        <Button size="sm" onClick={() => void submit()} disabled={busy || !prompt.trim()} variant={runsImmediately ? 'destructive' : 'default'} className="mt-0.5 h-8 shrink-0 text-xs">
          {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : runsImmediately ? <Zap className="mr-1.5 h-3.5 w-3.5" /> : null}
          {runsImmediately ? 'Generate and run' : editingSelection ? 'Rewrite' : 'Generate'}
        </Button>
        <Button size="icon" variant="ghost" className="mt-0.5 h-8 w-8 shrink-0" onClick={onClose} aria-label="Close">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        <div className="min-w-0 flex-1">
          <ContextMeter prompt={prompt} compact={compact} onCompactChange={setCompact} />
        </div>
        <span className="shrink-0">
          Enter to send · Esc to close · {shortcutLabel('Mod+K')} to reopen
        </span>
      </div>
    </div>
  );
}
