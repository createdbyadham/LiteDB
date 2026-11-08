import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { aiService } from '@/lib/aiService';
import { mascot } from '@/lib/mascot';
import { Loader2, Zap } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useSafetyPolicy } from '@/hooks/useSafetyPolicy';
import { ContextMeter } from './ContextMeter';

interface AiQueryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Receives the generated SQL and the request it came from. The prompt is
   * passed through so the audit log can record what was asked for, not just
   * what was produced — an entry saying the model removed rows from `orders`
   * is far less useful than one that also says the user asked to "clear out
   * the old orders".
   */
  onQueryGenerated: (query: string, prompt: string) => void;
  /**
   * Compiles a generated statement and returns the engine's error, or null if
   * it is valid. Supplying this enables self-correction: SQL that does not
   * compile is sent back to the model once with the real error, before it
   * reaches the editor.
   *
   * It compiles rather than executes, so it checks writes as well as reads —
   * catching an unknown column in an UPDATE is the whole point, and that is
   * exactly what a read-only dry run could never do.
   */
  validate?: (sql: string) => Promise<string | null>;
  /** Text the prompt starts with when the dialog opens: a table dropped on Star. */
  seed?: string;
}

/** Roughly where the caret is, so Star can watch the words being typed. */
function caretPoint(textarea: HTMLTextAreaElement): { x: number; y: number } {
  const r = textarea.getBoundingClientRect();
  const before = textarea.value.slice(0, textarea.selectionEnd ?? textarea.value.length);
  const lines = before.split('\n');
  const charWidth = 7; // text-sm Inter, close enough for a glance
  const perLine = Math.max(1, Math.floor((r.width - 24) / charWidth));
  const wrapped = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const last = lines[lines.length - 1].length % perLine;
  return {
    x: r.left + 12 + Math.min(r.width - 24, last * charWidth),
    y: Math.min(r.bottom - 10, r.top + 10 + (wrapped - 1) * 20),
  };
}

export function AiQueryDialog({
  open,
  onOpenChange,
  onQueryGenerated,
  validate,
  seed = '',
}: AiQueryDialogProps) {
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [compact, setCompact] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  const { toast } = useToast();
  // In YOLO the generated SQL runs the moment it arrives, so the button has to
  // say so. "Generate SQL" on a control that also executes it is the kind of
  // small lie that makes the rest of the safety layer harder to believe.
  const { policy } = useSafetyPolicy();
  const runsImmediately = policy === 'yolo';

  // Star hops onto the dialog while it is open.
  useEffect(() => (open ? mascot.perchOn('dialog') : undefined), [open]);

  // A table dropped on Star: start the prompt with it, caret at the end, ready to type the question.
  useEffect(() => {
    if (!open || !seed) return;
    setPrompt(seed);
    const raf = requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(seed.length, seed.length);
    });
    return () => cancelAnimationFrame(raf);
  }, [open, seed]);

  // The Generate button coming alive is something that changed: Star glances at it.
  const canGenerate = open && !isLoading && prompt.trim().length > 0;
  const couldGenerate = useRef(false);
  useEffect(() => {
    if (canGenerate && !couldGenerate.current) mascot.glance(generateRef.current, 650);
    couldGenerate.current = canGenerate;
  }, [canGenerate]);

  const handleGenerate = async () => {
    if (!prompt.trim()) return;

    setIsLoading(true);
    const tables = aiService.getSchema()?.tables.length ?? 0;
    mascot.setMood('thinking');
    mascot.say(tables ? `Reading ${tables} ${tables === 1 ? 'table' : 'tables'}` : 'Thinking', 60_000);
    try {
      const query = await aiService.generateSqlQuery(prompt, validate, { compact });
      mascot.setMood('happy', 1600);
      mascot.say('Here is your SQL', 1800);
      onQueryGenerated(query, prompt);
      onOpenChange(false);
      setPrompt('');
    } catch (error) {
      console.error('Failed to generate query:', error);
      mascot.setMood('error', 1800);
      mascot.say('That did not work', 2200);
      toast({
        variant: "destructive",
        title: "SQL not generated",
        description: error instanceof Error
          ? error.message
          : "Check your AI provider in Settings and try again.",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Above Star's body (z-60), below its fingertips (z-62): it peeks over this edge. */}
      <DialogContent data-mascot-perch="ai" className="z-[61] sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Text to SQL</DialogTitle>
          <DialogDescription>
            {runsImmediately
              ? "Describe what you want. In YOLO mode the generated SQL runs straight away — you won't see it first."
              : "Describe what you want in plain words, and I'll write the SQL."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 pt-2">
          <Textarea
            ref={textareaRef}
            placeholder="e.g. customers who signed up in the last month"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              mascot.lookAt(caretPoint(e.target), 1500);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void handleGenerate();
              }
            }}
            className="min-h-[100px] text-sm resize-none"
          />
          <ContextMeter prompt={prompt} compact={compact} onCompactChange={setCompact} />
          <Button
            ref={generateRef}
            onClick={handleGenerate}
            disabled={isLoading || !prompt.trim()}
            className="w-full"
            variant={runsImmediately ? 'destructive' : 'default'}
          >
            {isLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : runsImmediately ? (
              <Zap className="mr-2 h-4 w-4" />
            ) : null}
            {runsImmediately ? 'Generate and run' : 'Generate SQL'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
