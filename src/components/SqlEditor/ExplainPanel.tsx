import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ExplainState {
  sql: string;
  plan: string | null;
  text: string | null;
  error: string | null;
  loading: boolean;
}

/** Inline `code` and **bold** in a line of model output. */
function inline(text: string): React.ReactNode[] {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return (
        <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

/** Paragraphs and "- " bullets: as much markdown as the prompt asks for. */
function renderText(text: string): React.ReactNode {
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      blocks.push(
        <ul key={blocks.length} className="ml-4 list-disc space-y-1">
          {bullets.map((b, i) => (
            <li key={i}>{inline(b)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (/^[-*•]\s+/.test(line)) {
      bullets.push(line.replace(/^[-*•]\s+/, ''));
      continue;
    }
    flush();
    if (!line) continue;
    blocks.push(
      <p key={blocks.length} className="leading-relaxed">
        {inline(line.replace(/^#+\s*/, ''))}
      </p>,
    );
  }
  flush();
  return blocks;
}

export function ExplainPanel({ state, onClose }: { state: ExplainState; onClose: () => void }) {
  const [planOpen, setPlanOpen] = useState(false);
  return (
    <aside className="flex h-full w-[340px] shrink-0 flex-col border-l bg-background">
      <div className="flex h-9 items-center justify-between border-b px-3">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <Sparkles className="h-3.5 w-3.5 text-key" /> Explanation
        </span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose} aria-label="Close explanation">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">{state.sql}</pre>
        {state.loading && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the query{state.plan ? ' and its plan' : ''}…
          </div>
        )}
        {state.error && <p className="text-destructive">{state.error}</p>}
        {state.text && <div className="space-y-2 text-foreground/90">{renderText(state.text)}</div>}
        {state.plan && (
          <div>
            <button type="button" onClick={() => setPlanOpen(!planOpen)} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
              {planOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Query plan
            </button>
            {planOpen && <pre className="mt-1.5 overflow-auto whitespace-pre rounded-md bg-muted/60 p-2 font-mono text-[11px]">{state.plan}</pre>}
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">The plan comes from EXPLAIN without ANALYZE, so nothing was run.</p>
      </div>
    </aside>
  );
}
