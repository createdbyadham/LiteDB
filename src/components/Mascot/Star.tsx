import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSafetyPolicy } from '@/hooks/useSafetyPolicy';
import { mascot, useMascot, type MascotPerch } from '@/lib/mascot';
import { cn } from '@/lib/utils';
import { STAR, STAR_COLORS } from './art';
import { H, MascotMotion, PEEK, W, type Point } from './motion';

/**
 * Star, the Text-to-SQL assistant: the asterisk from LiteDB's logo (and from
 * SELECT *), peeking over the edge of whatever it is perched on and holding
 * on with two arms.
 *
 * At rest it peeks over the status bar and follows the cursor with its eyes.
 * When Text to SQL opens it hops onto the dialog's top edge and watches you
 * type. It strains as the prompt fills the model's context window and lets
 * its breath out when you compact it; it spins while the model works, cheers
 * when SQL comes back and winces when it does not. In Read-only mode it wears
 * a padlock. Click it to ask for SQL.
 *
 * All motion is spring physics (./motion.ts); ./art.ts draws Star. The body
 * is clipped at the edge it peeks over and the fingertips are drawn in front
 * of that edge, which is what makes it look like it is holding on.
 */

const SPRING_IN = 'cubic-bezier(0.34, 1.36, 0.64, 1)';
const reducedMotionQuery = () => window.matchMedia?.('(prefers-reduced-motion: reduce)');

export function Star({ onActivate }: { onActivate: () => void }) {
  const { mood, perch, gaze, say, strain, look } = useMascot();
  const { policy } = useSafetyPolicy();
  const motionRef = useRef<MascotMotion | null>(null);
  if (!motionRef.current) motionRef.current = new MascotMotion();
  const motion = motionRef.current;
  // The eyes are cut out with a mask, and the mask needs an id unique in the document.
  const uid = `star${useId().replace(/[^\w-]/g, '')}`;

  const [ready, setReady] = useState(false);
  const [traveling, setTraveling] = useState(false);
  const [hover, setHover] = useState(false);
  const [drowsy, setDrowsy] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const poseRef = useRef<HTMLDivElement>(null);
  const handsRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<SVGSVGElement>(null);
  const fxRef = useRef<SVGSVGElement>(null);
  const badgeRef = useRef<SVGSVGElement>(null);
  const lastMove = useRef(Date.now());

  // --- engine wiring ------------------------------------------------------------
  useLayoutEffect(() => {
    const body = bodyRef.current, pose = poseRef.current, hands = handsRef.current;
    const art = artRef.current, fx = fxRef.current, badge = badgeRef.current;
    if (!body || !pose || !hands || !art || !fx || !badge) return;
    const query = reducedMotionQuery();
    const syncReduced = () => {
      motion.reduced = !!query?.matches;
    };
    syncReduced();
    motion.attach({ body, pose, hands, art, fx, badge }, uid, mascot.get().look);
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
    const selector = perch === 'dialog' ? '[data-mascot-perch]' : '[data-mascot-home]';
    let element: Element | null = null;
    let observer: ResizeObserver | null = null;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    let tries = 0;

    const measure = (): Point | null => {
      if (!element?.isConnected) return null;
      const r = element.getBoundingClientRect();
      const x = perch === 'dialog' ? r.right - 72 - W : r.left + r.width / 2 - W / 2;
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
    // The dialog mounts a frame or two after the perch changes; look for it briefly.
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

  // Settings → Star changes its colour, eyes and mouth in place.
  const drawnLook = useRef(look);
  useEffect(() => {
    if (drawnLook.current === look) return;
    drawnLook.current = look;
    motion.setLook(look);
  }, [look, motion]);

  useEffect(() => motion.setMood(mood), [mood, motion]);
  useEffect(() => motion.setStrain(strain), [strain, motion]);
  useEffect(() => motion.setLatched(policy === 'read-only'), [policy, motion]);
  useEffect(
    () =>
      mascot.onGesture(gesture => {
        if (gesture === 'exhale') motion.exhale();
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

  // --- speech bubble: springs in, fades out ---------------------------------------------
  const text = say ?? (hover && perch === 'home' && !traveling ? 'Ask me for SQL' : null);
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

  const z = perch === 'dialog' || traveling ? 60 : 45;
  const breathing = ready && perch === 'home' && mood === 'idle' && !hover && !traveling;

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
            role="status"
            aria-live="polite"
            className={cn(
              'absolute bottom-full mb-2.5 whitespace-nowrap rounded-xl border bg-popover px-3 py-1.5 text-xs text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.4)]',
              perch === 'dialog' ? 'right-0 origin-bottom-right' : 'left-1/2 origin-bottom',
            )}
            style={{
              opacity: bubbleVisible ? 1 : 0,
              transform: `${perch === 'dialog' ? '' : 'translateX(-50%) '}translateY(${bubbleVisible ? 0 : 6}px) scale(${bubbleVisible ? 1 : 0.9})`,
              transition: bubbleVisible
                ? `transform 460ms ${SPRING_IN}, opacity 160ms ease-out`
                : 'transform 160ms ease-in, opacity 140ms ease-in',
            }}
          >
            <span key={bubble} className="block animate-in fade-in-0 duration-200">
              {bubble}
            </span>
          </div>
        )}

        <div className={cn('star-breathe', breathing && 'is-breathing', drowsy && 'is-drowsy')}>
          <div ref={poseRef} className="will-change-transform" style={{ transformOrigin: '50% 100%' }}>
            <button
              type="button"
              aria-label="Star, the Text to SQL assistant. Ask for SQL"
              onClick={() => {
                if (perch === 'home') onActivate();
                else document.querySelector<HTMLTextAreaElement>('[data-mascot-perch] textarea')?.focus();
              }}
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
      </div>

      {/* Fingertips: in front of the edge, holding on. They let go to hop. */}
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
          <span key={x} className="star-hand" style={{ top: PEEK - 4, left: x - 4.5 }} />
        ))}
      </div>
    </>,
    document.body,
  );
}
