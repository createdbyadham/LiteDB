import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSafetyPolicy } from '@/hooks/useSafetyPolicy';
import { useToast } from '@/hooks/use-toast';
import { onAgentActivity } from '@/lib/agentActivity';
import { mascot, useMascot, type MascotPerch } from '@/lib/mascot';
import { registerDropTarget, useTableDrag } from '@/lib/tableDrag';
import { cn } from '@/lib/utils';
import { STAR, STAR_COLORS } from './art';
import { H, MascotMotion, PEEK, W, type Point } from './motion';
import { narrate } from './narrate';

/**
 * Star, the Text-to-SQL assistant: the asterisk from LiteDB's logo (and from
 * SELECT *), peeking over the edge of whatever it is perched on and holding
 * on with two arms.
 *
 * At rest it peeks over the status bar and follows the cursor with its eyes,
 * glances at things that change, and fills long quiet stretches with a look
 * around, a stretch or a yawn. When Text to SQL opens it hops onto the
 * dialog's top edge and watches you type; it does the same for the approval
 * dialog, and nods or shakes its head at your answer. It tells you when an
 * agent is in the database over MCP. Drag a table onto it to ask about that
 * table; after a query fails, click it to have the error explained or fixed.
 *
 * All motion is spring physics (./motion.ts); ./art.ts draws Star. The body
 * is clipped at the edge it peeks over and the fingertips are drawn in front
 * of that edge, which is what makes it look like it is holding on.
 */

const SPRING_IN = 'cubic-bezier(0.34, 1.36, 0.64, 1)';
const reducedMotionQuery = () => window.matchMedia?.('(prefers-reduced-motion: reduce)');

const PERCH_SELECTOR: Record<MascotPerch, string> = {
  home: '[data-mascot-home]',
  dialog: '[data-mascot-perch="ai"]',
  approval: '[data-mascot-perch="approval"]',
};

/** Quiet time before an idle moment, and the gap between them, ms. */
const IDLE_AFTER = 12_000;
const IDLE_GAP: [number, number] = [9_000, 16_000];

interface StarProps {
  /** Open Text to SQL. */
  onActivate: () => void;
  /** A table was dropped on Star: open Text to SQL about it. */
  onAsk: (table: string) => void;
}

export function Star({ onActivate, onAsk }: StarProps) {
  const { mood, perch, gaze, say, strain, look, prefs, help } = useMascot();
  const { policy } = useSafetyPolicy();
  const { toasts } = useToast();
  const drag = useTableDrag();
  const motionRef = useRef<MascotMotion | null>(null);
  if (!motionRef.current) motionRef.current = new MascotMotion();
  const motion = motionRef.current;
  // The eyes are cut out with a mask, and the mask needs an id unique in the document.
  const uid = `star${useId().replace(/[^\w-]/g, '')}`;

  const [ready, setReady] = useState(false);
  const [traveling, setTraveling] = useState(false);
  const [hover, setHover] = useState(false);
  const [drowsy, setDrowsy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const poseRef = useRef<HTMLDivElement>(null);
  const handsRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<SVGSVGElement>(null);
  const fxRef = useRef<SVGSVGElement>(null);
  const badgeRef = useRef<SVGSVGElement>(null);
  const blurRef = useRef<SVGFEGaussianBlurElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const lastMove = useRef(Date.now());

  // --- engine wiring ------------------------------------------------------------
  useLayoutEffect(() => {
    const body = bodyRef.current, pose = poseRef.current, hands = handsRef.current;
    const art = artRef.current, fx = fxRef.current, badge = badgeRef.current, blur = blurRef.current;
    if (!body || !pose || !hands || !art || !fx || !badge || !blur) return;
    const query = reducedMotionQuery();
    const syncReduced = () => {
      motion.reduced = !!query?.matches;
    };
    syncReduced();
    motion.attach({ body, pose, hands, art, fx, badge, blur, blurId: `${uid}-blur` }, uid, mascot.get().look);
    motion.onLanded = () => setTraveling(false);
    query?.addEventListener('change', syncReduced);
    return () => {
      query?.removeEventListener('change', syncReduced);
      motion.detach();
    };
  }, [motion, uid]);

  // --- where it perches -----------------------------------------------------------
  const placedPerch = useRef<MascotPerch | null>(null);
  useLayoutEffect(() => {
    const selector = PERCH_SELECTOR[perch];
    let element: Element | null = null;
    let observer: ResizeObserver | null = null;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    let tries = 0;

    const measure = (): Point | null => {
      if (!element?.isConnected) return null;
      const r = element.getBoundingClientRect();
      const x = perch === 'home' ? r.left + r.width / 2 - W / 2 : r.right - 72 - W;
      return { x: Math.round(x), y: Math.round(r.top - PEEK) };
    };
    const update = () => {
      const p = measure();
      if (!p) return;
      if (placedPerch.current === null) {
        motion.place(p);
        setReady(true);
      } else if (placedPerch.current !== perch) {
        setTraveling(true);
        motion.jumpTo(p);
      } else {
        motion.follow(p);
      }
      placedPerch.current = perch;
    };
    // A dialog mounts a frame or two after the perch changes; look for it briefly.
    const find = () => {
      element = document.querySelector(selector);
      if (!element) {
        if (tries++ < 30) timeouts.push(setTimeout(find, 16));
        return;
      }
      update();
      observer = new ResizeObserver(update);
      observer.observe(element);
      // The dialog's zoom-in moves its edge; follow it as it settles.
      timeouts.push(setTimeout(update, 90), setTimeout(update, 220));
    };
    find();
    window.addEventListener('resize', update);
    return () => {
      timeouts.forEach(clearTimeout);
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [perch, motion]);

  // Waves hello when it first appears.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => motion.hello(), 650);
    return () => clearTimeout(t);
  }, [ready, motion]);

  // --- what it pays attention to ------------------------------------------------------
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      motion.pointer = { x: e.clientX, y: e.clientY };
      lastMove.current = Date.now();
      setDrowsy(false);
      motion.kick();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [motion]);

  useEffect(() => {
    const hadGaze = motion.gaze !== null;
    motion.gaze = gaze;
    if (gaze && !hadGaze) motion.perk();
    else motion.kick();
  }, [gaze, motion]);

  // A new toast is something that changed: a glance its way.
  const lastToast = useRef<string | null>(null);
  useEffect(() => {
    const id = toasts.find(t => t.open !== false)?.id ?? null;
    if (!id || id === lastToast.current) return;
    lastToast.current = id;
    const raf = requestAnimationFrame(() => mascot.glance(document.querySelector(`[data-toast-id="${id}"]`), 900));
    return () => cancelAnimationFrame(raf);
  }, [toasts]);

  useEffect(() => motion.setMood(mood), [mood, motion]);
  useEffect(() => motion.setStrain(strain), [strain, motion]);
  useEffect(() => motion.setLatched(policy === 'read-only'), [policy, motion]);

  // Settings → Star changes its colour, eyes and mouth in place.
  const drawnLook = useRef(look);
  useEffect(() => {
    if (drawnLook.current === look) return;
    drawnLook.current = look;
    motion.setLook(look);
  }, [look, motion]);

  useEffect(
    () =>
      mascot.onGesture(gesture => {
        if (gesture === 'exhale') motion.exhale();
        if (gesture === 'nod') motion.nodYes();
        if (gesture === 'shake') motion.shakeNo();
        if (gesture === 'rattle') motion.rattle();
      }),
    [motion],
  );

  useEffect(() => {
    motion.rise.target = hover && perch === 'home' ? -6 : 0;
    motion.widen.target = hover ? 1.1 : 1;
    motion.hover = hover;
    motion.kick();
  }, [hover, perch, motion]);

  // Dozes off at its perch when nobody has moved the mouse for a while.
  useEffect(() => {
    const t = setInterval(() => {
      const { perch: p, mood: m } = mascot.get();
      setDrowsy(Date.now() - lastMove.current > 45_000 && p === 'home' && m === 'idle');
    }, 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => motion.setDrowsy(drowsy), [drowsy, motion]);

  // --- idle moments: a look around, a stretch, a yawn -----------------------------------
  const idleBlockers = useRef({ hover, traveling, drowsy, menuOpen, dragging: !!drag });
  idleBlockers.current = { hover, traveling, drowsy, menuOpen, dragging: !!drag };
  useEffect(() => {
    let next = Date.now() + IDLE_AFTER;
    const t = setInterval(() => {
      const b = idleBlockers.current;
      const { perch: p, mood: m } = mascot.get();
      const quiet = Date.now() - lastMove.current;
      if (p !== 'home' || m !== 'idle' || b.hover || b.traveling || b.drowsy || b.menuOpen || b.dragging || quiet < IDLE_AFTER) {
        next = Math.max(next, Date.now() + 2_000);
        return;
      }
      if (Date.now() < next) return;
      next = Date.now() + IDLE_GAP[0] + Math.random() * (IDLE_GAP[1] - IDLE_GAP[0]);
      const roll = Math.random();
      if (roll < 0.55) motion.lookAround();
      else if (roll < 0.8 || quiet < 25_000) motion.stretch();
      else motion.yawn();
    }, 1000);
    return () => clearInterval(t);
  }, [motion]);

  // --- agents in the database, over MCP --------------------------------------------------
  useEffect(() => {
    let recent: { table: string; at: number }[] = [];
    let lastGlance = 0;
    return onAgentActivity(entries => {
      const now = Date.now();
      recent = recent.filter(r => now - r.at < 5_000);
      const line = narrate(
        entries,
        recent.map(r => r.table),
      );
      for (const e of entries) {
        if (e.kind === 'read' && e.table && !recent.some(r => r.table === e.table)) recent.push({ table: e.table, at: now });
      }
      if (!line) return;
      // Turn toward the MCP indicator, where the agent comes in.
      if (now - lastGlance > 2_000) {
        lastGlance = now;
        mascot.glance(document.querySelector('[data-mascot-mcp]'), 1400);
      }
      mascot.say(line.text, line.react ? 3200 : 2600);
      if (line.react === 'nod') motion.nodYes();
      if (line.react === 'shake') motion.shakeNo();
      if (line.react === 'attend') motion.perk();
      if (line.react === 'wince') mascot.setMood('error', 1400);
    });
  }, [motion]);

  // --- a table dragged from the sidebar ---------------------------------------------------
  useEffect(() => {
    motion.reach = drag ? (drag.over ? 1 : 0.5) : 0;
    if (drag) motion.pointer = { x: drag.x, y: drag.y };
    motion.kick();
  }, [drag, motion]);

  useEffect(
    () =>
      registerDropTarget({
        hit: (x, y) => {
          const body = bodyRef.current;
          if (!body || mascot.get().perch !== 'home') return false;
          // The part that shows above the edge, with some room around it.
          const r = body.getBoundingClientRect();
          return x >= r.left - 16 && x <= r.right + 16 && y >= r.top - 16 && y <= r.top + PEEK + 8;
        },
        drop: table => onAsk(table),
      }),
    [onAsk],
  );

  // --- help with a failed query ------------------------------------------------------------
  useEffect(() => {
    if (!help || perch !== 'home') setMenuOpen(false);
  }, [help, perch]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [menuOpen]);

  const choose = (action: () => void) => {
    setMenuOpen(false);
    buttonRef.current?.focus();
    action();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setMenuOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(i + step + items.length) % items.length]?.focus();
    }
  };

  const activate = () => {
    if (perch === 'dialog') {
      document.querySelector<HTMLTextAreaElement>('[data-mascot-perch="ai"] textarea')?.focus();
    } else if (perch === 'approval') {
      motion.perk();
      mascot.say('Check the row counts before you approve', 2400);
    } else if (help) {
      setMenuOpen(open => !open);
    } else {
      onActivate();
    }
  };

  // --- speech bubble: springs in, fades out ---------------------------------------------
  const dragLine = drag && perch === 'home' ? (drag.over ? `Ask about ${drag.table}` : `Drop ${drag.table} on me to ask about it`) : null;
  const hoverLine =
    hover && perch === 'home' && !traveling ? (help ? 'Click for help with that error' : 'Ask me for SQL') : null;
  const text = prefs.bubbles && !menuOpen ? (dragLine ?? say ?? hoverLine) : null;
  const [bubble, setBubble] = useState<string | null>(null);
  const [bubbleVisible, setBubbleVisible] = useState(false);
  useEffect(() => {
    if (text) {
      setBubble(text);
      const raf = requestAnimationFrame(() => setBubbleVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setBubbleVisible(false);
    const t = setTimeout(() => setBubble(null), 180);
    return () => clearTimeout(t);
  }, [text]);

  // A box around wrapped text keeps the full max width, leaving a gap on the
  // right of the shorter lines. Shrink it to the widest line it actually has.
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bubbleTextRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const box = bubbleRef.current;
    const span = bubbleTextRef.current;
    if (!box || !span) return;
    box.style.width = '';
    const range = document.createRange();
    range.selectNodeContents(span);
    // The box may be mid-animation (scaled): measure in untransformed pixels.
    const scale = span.getBoundingClientRect().width / span.offsetWidth || 1;
    let widest = 0;
    for (const r of range.getClientRects()) widest = Math.max(widest, r.width / scale);
    const pad = box.offsetWidth - box.clientWidth + parseFloat(getComputedStyle(box).paddingLeft) * 2;
    if (widest && widest + pad < box.offsetWidth) box.style.width = `${Math.ceil(widest + pad)}px`;
  }, [bubble]);

  const z = perch !== 'home' || traveling ? 60 : 45;
  const breathing = ready && perch === 'home' && mood === 'idle' && !hover && !traveling && !drag;
  const anchor = perch === 'home' ? 'left-1/2 origin-bottom' : 'right-0 origin-bottom-right';
  const shift = perch === 'home' ? 'translateX(-50%) ' : '';

  return createPortal(
    <>
      {/* Body: clipped at the edge it peeks over. */}
      <div
        ref={bodyRef}
        className="pointer-events-none fixed left-0 top-0 will-change-transform"
        style={{ width: W, height: H, zIndex: z, visibility: ready ? 'visible' : 'hidden' }}
      >
        {bubble && (
          <div
            ref={bubbleRef}
            role="status"
            aria-live="polite"
            className={cn(
              'absolute bottom-full mb-2.5 w-max max-w-[280px] rounded-xl border bg-popover px-3 py-1.5 text-xs leading-relaxed text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.4)] [text-wrap:balance]',
              anchor,
            )}
            style={{
              opacity: bubbleVisible ? 1 : 0,
              transform: `${shift}translateY(${bubbleVisible ? 0 : 6}px) scale(${bubbleVisible ? 1 : 0.9})`,
              transition: bubbleVisible
                ? `transform 460ms ${SPRING_IN}, opacity 160ms ease-out`
                : 'transform 160ms ease-in, opacity 140ms ease-in',
            }}
          >
            <span ref={bubbleTextRef} key={bubble} className="block animate-in fade-in-0 duration-200">
              {bubble}
            </span>
          </div>
        )}

        {menuOpen && help && (
          // Positioned by the outer box, animated by the inner one, so the zoom-in does not fight the centring.
          <div className={cn('pointer-events-auto absolute bottom-full mb-2.5', anchor)} style={{ transform: shift || undefined }}>
            <div
              ref={menuRef}
              role="menu"
              aria-label="Help with the failed query"
              onKeyDown={onMenuKey}
              className="flex w-max min-w-[176px] origin-bottom flex-col rounded-xl border bg-popover p-1 text-xs text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.4)] animate-in fade-in-0 zoom-in-95 duration-150"
            >
              {(
                [
                  ['Explain this error', help.explain],
                  ['Fix it', help.fix],
                  ['Ask for SQL', onActivate],
                ] as const
              ).map(([label, action]) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  onClick={() => choose(action)}
                  className="h-8 rounded-lg px-3 text-left transition-colors hover:bg-secondary focus-visible:bg-secondary focus-visible:outline-none"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className={cn('star-breathe', breathing && 'is-breathing', drowsy && 'is-drowsy')}>
          <div ref={poseRef} className="will-change-transform" style={{ transformOrigin: '50% 100%' }}>
            <button
              ref={buttonRef}
              type="button"
              aria-label={
                help && perch === 'home'
                  ? 'Star, the Text to SQL assistant. Get help with the failed query'
                  : 'Star, the Text to SQL assistant. Ask for SQL'
              }
              aria-haspopup={help && perch === 'home' ? 'menu' : undefined}
              aria-expanded={help && perch === 'home' ? menuOpen : undefined}
              onClick={activate}
              onPointerDown={() => {
                motion.press.target = 0.9;
                motion.kick();
              }}
              onPointerUp={() => {
                motion.press.target = 1;
                motion.kick();
              }}
              onPointerLeave={() => {
                motion.press.target = 1;
                setHover(false);
                motion.kick();
              }}
              onPointerEnter={() => setHover(true)}
              onFocus={() => setHover(true)}
              onBlur={() => setHover(false)}
              className="pointer-events-auto absolute left-0 top-0 cursor-pointer rounded-[24px_24px_6px_6px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{ width: W, height: PEEK }}
            />
            {/* Drawn by ./art.ts, full height; everything below the edge is clipped away. */}
            <svg ref={artRef} width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="pointer-events-none block overflow-visible" aria-hidden />
          </div>
        </div>

        {/* Puffs of air when it exhales. */}
        <svg
          ref={fxRef}
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          aria-hidden
        />

        {/* Read-only mode: a padlock by its top-right arm. Scaled in by the spring loop. */}
        <svg
          ref={badgeRef}
          width={13}
          height={15}
          viewBox="0 0 13 15"
          className="pointer-events-none absolute origin-bottom"
          style={{ left: STAR.badge.x, top: STAR.badge.y }}
          aria-hidden
        >
          <path d="M3.6 6.4 V4.6 A2.9 2.9 0 0 1 9.4 4.6 V6.4" fill="none" stroke="#ededed" strokeWidth="1.6" />
          <rect x="1.4" y="6.2" width="10.2" height="8" rx="2.2" fill="#ededed" stroke="rgba(16,16,18,0.35)" strokeWidth="0.8" />
          <circle cx="6.5" cy="9.6" r="1.1" fill="#161618" />
          <rect x="6" y="9.8" width="1" height="2.4" rx="0.5" fill="#161618" />
        </svg>

        {/* Directional blur for the fastest part of a hop; set by the spring loop. */}
        <svg width={0} height={0} className="absolute" aria-hidden>
          <filter id={`${uid}-blur`} x="-25%" y="-25%" width="150%" height="150%">
            <feGaussianBlur ref={blurRef} stdDeviation="0 0" />
          </filter>
        </svg>
      </div>

      {/* Fingertips: in front of the edge, holding on, with a faint shadow where they touch. They let go to hop. */}
      <div
        ref={handsRef}
        aria-hidden
        className="pointer-events-none fixed left-0 top-0"
        style={{
          width: W,
          height: H,
          zIndex: z + 2,
          visibility: ready ? 'visible' : 'hidden',
          ['--star-body' as string]: STAR_COLORS[look.color].body,
          ['--star-line' as string]: STAR_COLORS[look.color].line,
        }}
      >
        {STAR.hands.map(x => (
          <span key={`shadow-${x}`} className="star-shadow" style={{ top: PEEK + 1, left: x - 7 }} />
        ))}
        {STAR.hands.map(x => (
          <span key={x} className="star-hand" style={{ top: PEEK - 4, left: x - 4.5 }} />
        ))}
      </div>
    </>,
    document.body,
  );
}
