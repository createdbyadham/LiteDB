import { cn } from '@/lib/utils';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Soft top and bottom edges, so a digit rolls in rather than appearing at a hard line. */
const REEL_MASK = 'linear-gradient(to bottom, transparent 0%, #000 14%, #000 86%, transparent 100%)';

/**
 * Text whose digits roll to their new value, like a mechanical counter.
 *
 * Every character sits on the text baseline. Each reel keeps an invisible "0"
 * in normal flow, which gives it its width and its baseline, and clips the
 * moving column with clip-path rather than overflow:hidden (overflow on an
 * inline-block moves its baseline to the bottom edge, which is what lifted
 * the digits above the "." and "K"). Reels are keyed from the right, settle
 * on a soft spring, and ripple from the last digit to the first.
 */
export function RollingNumber({ value, className }: { value: string; className?: string }) {
  const chars = value.split('');
  return (
    <span className={cn('inline-flex items-baseline tabular-nums', className)} aria-label={value} role="img">
      {chars.map((char, i) => {
        const fromRight = chars.length - 1 - i;
        const digit = DIGITS.indexOf(char);
        if (digit < 0) {
          return (
            <span key={`s${fromRight}`} aria-hidden className="inline-block animate-in fade-in-0 duration-300">
              {char}
            </span>
          );
        }
        return (
          <span
            key={`d${fromRight}`}
            aria-hidden
            className="relative inline-block leading-none animate-in fade-in-0 duration-300"
            style={{ clipPath: 'inset(-0.06em -0.04em)', WebkitMaskImage: REEL_MASK, maskImage: REEL_MASK }}
          >
            <span className="invisible">0</span>
            <span
              className="absolute inset-x-0 top-0 flex flex-col motion-reduce:transition-none"
              style={{
                transform: `translateY(${-digit}em)`,
                transition: 'transform 700ms cubic-bezier(0.3, 1.18, 0.5, 1)',
                transitionDelay: `${fromRight * 28}ms`,
              }}
            >
              {DIGITS.map(d => (
                <span key={d} className="block h-[1em] leading-none">
                  {d}
                </span>
              ))}
            </span>
          </span>
        );
      })}
    </span>
  );
}
