import { useLayoutEffect, useRef } from 'react';
import { useTheme } from 'next-themes';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { DEFAULT_LOOK, mascot, starColor, useMascot, type StarLook } from '@/lib/mascot';
import { cn } from '@/lib/utils';
import { AT_REST, makeStar } from './art';

const COLORS: [StarLook['color'], string][] = [
  ['auto', 'Auto'],
  ['white', 'White'],
  ['graphite', 'Graphite'],
];
const EYES: [StarLook['eyes'], string][] = [
  ['cutout', 'Cutout'],
  ['bubble', 'Glossy'],
  ['lines', 'Lines'],
  ['none', 'None'],
];
const MOUTH: [string, string][] = [
  ['on', 'On'],
  ['off', 'Off'],
];

/** Settings → Star: whether it shows and talks, and its colour, eyes and mouth, with a preview. Applies right away. */
export function StarSettings() {
  const { look, prefs } = useMascot();
  const { resolvedTheme } = useTheme();
  const preview = useRef<SVGSVGElement>(null);
  const color = starColor(look.color, resolvedTheme);

  useLayoutEffect(() => {
    if (preview.current) makeStar(preview.current, 'star-preview', { ...look, color }, () => {}).render(AT_REST);
  }, [look, color]);

  const isDefault =
    look.color === DEFAULT_LOOK.color && look.eyes === DEFAULT_LOOK.eyes && look.mouth === DEFAULT_LOOK.mouth;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 rounded-lg border bg-background/60 px-4 py-3">
        <svg ref={preview} width={64} height={64} viewBox="0 0 64 64" className="shrink-0 overflow-visible" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Star</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            The Text to SQL assistant that peeks over the status bar. Changes apply right away and stay on this device.
          </p>
        </div>
      </div>

      <div className="divide-y rounded-lg border">
        <Toggle
          id="star-visible"
          label="Show Star"
          hint="Peeks over the status bar while a database is open."
          checked={prefs.visible}
          onChange={visible => mascot.setPrefs({ visible })}
        />
        <Toggle
          id="star-bubbles"
          label="Speech bubbles"
          hint="Off keeps Star quiet: it still reacts, but says nothing."
          checked={prefs.bubbles}
          disabled={!prefs.visible}
          onChange={bubbles => mascot.setPrefs({ bubbles })}
        />
      </div>

      <Choice
        label="Colour"
        options={COLORS}
        value={look.color}
        hint={look.color === 'auto' ? 'White in dark mode, graphite in light mode' : undefined}
        onChange={color => mascot.setLook({ color })}
      />
      <Choice label="Eyes" options={EYES} value={look.eyes} onChange={eyes => mascot.setLook({ eyes })} />
      <Choice
        label="Mouth"
        options={MOUTH}
        value={look.mouth ? 'on' : 'off'}
        disabled={look.eyes === 'none'}
        hint={look.eyes === 'none' ? 'No face, so no mouth' : undefined}
        onChange={v => mascot.setLook({ mouth: v === 'on' })}
      />

      <div className="flex justify-end">
        <button
          type="button"
          disabled={isDefault}
          onClick={() => mascot.setLook(DEFAULT_LOOK)}
          className="h-8 rounded-md px-3 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          Reset to default
        </button>
      </div>
    </div>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className={cn('flex items-start gap-3 px-4 py-3', disabled && 'opacity-50')}>
      <Switch id={id} className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  hint,
}: {
  label: string;
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-3">
      <span className="text-sm">{label}</span>
      <div className="space-y-1">
        <div
          role="radiogroup"
          aria-label={label}
          className={cn('flex rounded-md border bg-secondary/40 p-0.5', disabled && 'pointer-events-none opacity-40')}
        >
          {options.map(([v, text]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={value === v}
              disabled={disabled}
              onClick={() => onChange(v)}
              className={cn(
                'h-7 flex-1 rounded-[5px] px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                value === v ? 'bg-secondary text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {text}
            </button>
          ))}
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}
