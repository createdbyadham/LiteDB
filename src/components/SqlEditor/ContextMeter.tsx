import { useEffect, useMemo, useRef, useState } from 'react';
import { RollingNumber } from '@/components/ui/rolling-number';
import { aiService, type ContextWindow } from '@/lib/aiService';
import { formatTokens, measureContext, type BudgetKind } from '@/lib/contextBudget';
import { mascot } from '@/lib/mascot';
import { cn } from '@/lib/utils';

/**
 * Neutral steps of the graphite ramp, one per kind, so adjacent segments stay
 * distinguishable without colour. The schema, the part the user's database
 * controls, is the brightest.
 */
const SWATCH: Record<BudgetKind, string> = {
  instructions: 'hsl(240 3% 38%)',
  schema: 'hsl(0 0% 93%)',
  samples: 'hsl(240 3% 64%)',
  examples: 'hsl(240 3% 48%)',
  question: 'hsl(240 3% 80%)',
  reply: 'repeating-linear-gradient(135deg, hsl(0 0% 93% / 0.35) 0 2px, transparent 2px 5px)',
};

interface ContextMeterProps {
  prompt: string;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
}

/**
 * How much of the model's context window this request uses, by part.
 *
 * Small local models are where Text-to-SQL fails quietly: Ollama cuts an
 * oversized prompt from the start, which drops the schema, and the model then
 * guesses table names. The meter makes that visible before sending, and
 * Compact is the lever that fixes it.
 */
export function ContextMeter({ prompt, compact, onCompactChange }: ContextMeterProps) {
  const [ctxWindow, setCtxWindow] = useState<ContextWindow | null>(null);
  const [lit, setLit] = useState<BudgetKind | null>(null);
  const { model } = aiService.activeModel();

  useEffect(() => {
    let live = true;
    void aiService.contextWindow().then(w => live && setCtxWindow(w));
    return () => {
      live = false;
    };
  }, [model]);

  const budget = useMemo(
    () => measureContext(prompt, aiService.getSchema(), { compact }),
    [prompt, compact],
  );

  const limit = ctxWindow?.tokens ?? null;
  const scale = Math.max(limit ?? budget.total, budget.total, 1);
  const over = limit !== null && budget.total > limit;
  const near = limit !== null && !over && budget.total > limit * 0.85;
  const percent = limit ? Math.round((budget.total / limit) * 100) : null;
  const canCompact = budget.segments.some(s => (s.kind === 'samples' || s.kind === 'examples') && s.tokens > 0);

  // Star feels the prompt: it strains as the window fills and worries past it.
  useEffect(() => {
    mascot.setStrain(limit ? budget.total / limit : 0);
  }, [budget.total, limit]);
  useEffect(() => () => mascot.setStrain(0), []);
  const wasOver = useRef(false);
  useEffect(() => {
    if (over && !wasOver.current && limit !== null) mascot.say(`That won't fit in ${formatTokens(limit)}`, 2000);
    wasOver.current = over;
  }, [over, limit]);

  const toggleCompact = () => {
    const next = !compact;
    onCompactChange(next);
    if (next) {
      mascot.gesture('exhale');
      if (over || near) mascot.say('Phew', 1300);
    }
  };

  return (
    <section className="rounded-xl border bg-background/60 p-4" aria-label="Context window usage">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Context</span>
        <button
          type="button"
          aria-pressed={compact}
          disabled={!compact && !canCompact}
          onClick={toggleCompact}
          className={cn(
            'h-7 rounded-md border px-3 text-xs transition-colors disabled:pointer-events-none disabled:opacity-40',
            compact ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          {compact ? 'Use full prompt' : 'Compact'}
        </button>
      </div>

      <div className="mt-3 flex items-baseline gap-1.5">
        <RollingNumber
          value={formatTokens(budget.total)}
          className={cn('text-2xl font-medium', over ? 'text-destructive' : near ? 'text-warning' : 'text-foreground')}
        />
        <span className="text-sm text-muted-foreground">
          {limit !== null ? `of ${formatTokens(limit)} tokens` : ctxWindow ? 'tokens' : 'tokens · checking window'}
        </span>
        {percent !== null && (
          <span className={cn('ml-auto font-mono text-xs tabular-nums', over ? 'text-destructive' : 'text-muted-foreground')}>
            {percent}%
          </span>
        )}
      </div>

      {/* One stacked bar. Space the request does not use stays as the track. */}
      <div className="relative mt-3 flex h-2.5 overflow-hidden rounded-[4px] bg-secondary" onMouseLeave={() => setLit(null)}>
        {budget.segments.map((segment, i) => (
          <div
            key={segment.kind}
            onMouseEnter={() => setLit(segment.kind)}
            className={cn(
              'h-full shrink-0 transition-[width,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              segment.tokens > 0 && i > 0 && 'border-l-2 border-card',
              lit && lit !== segment.kind && 'opacity-25',
            )}
            style={{ width: `${(segment.tokens / scale) * 100}%`, background: SWATCH[segment.kind] }}
          />
        ))}
        {over && limit !== null && (
          <div
            className="absolute inset-y-0 w-0.5 bg-destructive"
            style={{ left: `${(limit / scale) * 100}%` }}
            aria-hidden
          />
        )}
      </div>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {budget.segments.map(segment => (
          <li key={segment.kind}>
            <button
              type="button"
              onMouseEnter={() => setLit(segment.kind)}
              onMouseLeave={() => setLit(null)}
              onFocus={() => setLit(segment.kind)}
              onBlur={() => setLit(null)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md bg-secondary/60 px-2 text-xs transition-[color,opacity]',
                segment.tokens === 0 && 'opacity-40',
                lit === segment.kind ? 'text-foreground' : 'text-muted-foreground',
              )}
            >
              <span className="h-2 w-2 rounded-[2px]" style={{ background: SWATCH[segment.kind] }} aria-hidden />
              {segment.label}
              <span className="font-mono tabular-nums text-muted-foreground">{formatTokens(segment.tokens)}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className={cn('mt-3 text-xs leading-relaxed', over ? 'text-destructive' : near ? 'text-warning' : 'text-muted-foreground')}>
        {over
          ? overMessage(model, ctxWindow, compact)
          : near
            ? `Close to the limit. Long answers may be cut off.`
            : compact
              ? 'Sample values and examples left out. Answers on coded values may be less exact'
              : `${model} · ${ctxWindow ? (limit !== null ? `${formatTokens(limit)} window, ${ctxWindow.source}` : ctxWindow.source) : 'checking window'}`}
      </p>
    </section>
  );
}

function overMessage(model: string, win: ContextWindow | null, compact: boolean): string {
  const fix = compact ? '' : ' Compact may make it fit.';
  if (win?.source.includes('Ollama') || win?.source.includes('num_ctx')) {
    const raise =
      win.modelMax && win.tokens && win.modelMax > win.tokens
        ? ` ${model} supports ${formatTokens(win.modelMax)}; raise num_ctx in Ollama to use it.`
        : '';
    return `Too long for ${model}. Ollama cuts the start of the prompt, which drops the schema.${fix}${raise}`;
  }
  return `Too long for ${model}, so the provider will reject it.${fix}`;
}
