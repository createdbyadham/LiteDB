// The mascot's motion: everything on springs, driven by one frame loop that
// sleeps as soon as every spring has settled. Springs carry their velocity
// into a new target, so motion that changes mid-flight (the dialog still
// zooming in, the cursor moving during a hop) stays continuous.
//
// The rig moves the whole body (hops, squash and stretch, tilt, the hands on
// the edge, puffs of air, Zs when it dozes), decides what it wears and when, and hands the
// character a state each frame; ./art.ts draws Star and animates its arms,
// eyes and glasses.

import { Spring } from '@/lib/spring';
import type { DrawnLook, MascotMood } from '@/lib/mascot';
import { makeStar, STAR, WEAR, type StarArt, type StarState } from './art';

/** What it wears for the connection's mode: reading glasses in Read-only, sunglasses in YOLO. */
export type Wear = 'reading' | 'shades' | null;

export const { W, H, PEEK } = STAR;

export interface Point {
  x: number;
  y: number;
}

export interface MotionElements {
  /** Fixed; positioned, and clipped at the edge it peeks over. */
  body: HTMLElement;
  /** Tilt, squash and stretch, press. Pivots at the hidden bottom of the body. */
  pose: HTMLElement;
  /** Fixed; the fingertips, on the edge. */
  hands: HTMLElement;
  /** Where the character draws itself. */
  art: SVGSVGElement;
  /** Puffs of air. */
  fx: SVGSVGElement;
  /** Directional blur for the fastest part of a hop, and the id of its filter. */
  blur: SVGFEGaussianBlurElement;
  blurId: string;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Reading: quick saccades along a line, then a sweep back to the start of the next. */
const READING: [number, number][] = [
  [-2.6, -1.4], [-0.9, -1.4], [0.8, -1.4], [2.5, -1.4],
  [-2.6, 0.8], [-0.9, 0.8], [0.8, 0.8], [2.5, 0.8],
];

const EYE_TRACKING = { response: 0.2, damping: 0.74 };
const EYE_READING = { response: 0.1, damping: 0.86 };
const LID_CLOSE = { response: 0.06, damping: 1 };
const LID_OPEN = { response: 0.14, damping: 0.88 };
const LID_DROWSY = { response: 1.2, damping: 1 };
const LID_YAWN = { response: 0.45, damping: 1 };
/** Opening by degrees after squinting at a light window. */
const LID_ADJUST = { response: 0.35, damping: 1 };

/** How near the cursor must be to the middle of its eyes, px, and for how long, ms, before it goes cross-eyed. */
const CROSS_RADIUS = 12;
const CROSS_AFTER = 600;
/** A Z every this many ms while it dozes. */
const SNORE_EVERY = 1700;
/** Petting: rubbing within this many px of its middle, turning direction three times within this many ms. */
const PET_RADIUS = 22;
const PET_WINDOW = 1200;

/** Reading glasses drop on with a little bounce on its nose: about 2 px past where they sit, from 34 px up. */
const SPECS_ON = { response: 0.42, damping: 0.66 };
const SPECS_OFF = { response: 0.4, damping: 0.9 };
/** Sliding down its nose to peer over them: no bounce. */
const SPECS_SLIDE = { response: 0.55, damping: 0.85 };
const SPECS_PUSH = { response: 0.3, damping: 0.62 };

/** How far behind the eyes the body turns, seconds. Real creatures look first, then turn. */
const TURN_DELAY = 0.12;
/** Gravity for hops, px/s². Higher than real for a UI: a hop is a gesture, not a fall. */
const GRAVITY = 4200;

interface Hop {
  phase: 'crouch' | 'air';
  from: Point;
  target: Point;
  /** Progress along the arc, 0..1. */
  t: number;
  /** Seconds the flight takes. */
  duration: number;
  leaveEdge: number;
  arriveEdge: number;
  /** Its body has risen clear of the edge it left. */
  cleared: boolean;
  /** It has been fully above the edge it is landing on. */
  aboveArrival: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  started: number;
}

interface Puff {
  el: SVGCircleElement;
  x: number;
  y: number;
  vx: number;
  born: number;
}

/**
 * The control point of a hop: a quadratic Bézier whose highest point sits a
 * little above the higher end. With progress linear in time, a quadratic
 * Bézier is exactly a thrown object's path: constant horizontal speed,
 * constant downward acceleration.
 */
function arcControl(from: Point, to: Point): Point {
  const top = Math.min(from.y, to.y);
  const rise = clamp(36 + Math.hypot(to.x - from.x, to.y - from.y) * 0.05, 40, 80);
  // Keep the peak on screen, but always above both ends.
  const apex = Math.min(Math.max(top - rise, 2), top - 12);
  const h0 = from.y - apex;
  const h2 = to.y - apex;
  return { x: (from.x + to.x) / 2, y: from.y - (h0 + Math.sqrt(h0 * h2)) };
}

function flightTime(from: Point, to: Point): number {
  const c = arcControl(from, to);
  return clamp(Math.sqrt((2 * (from.y - 2 * c.y + to.y)) / GRAVITY), 0.36, 0.75);
}

export class MascotMotion {
  // Damping 0.8: about 1.5% overshoot, so a hop settles onto its perch rather than stopping dead.
  readonly x = new Spring(0, { response: 0.6, damping: 0.8, precision: 0.05 });
  readonly y = new Spring(0, { response: 0.6, damping: 0.8, precision: 0.05 });
  /** Height of a hop in place, px; negative is up. */
  readonly lift = new Spring(0, { response: 0.8, damping: 0.72, precision: 0.05 });
  /** Peeking a little higher on hover, px. */
  readonly rise = new Spring(0, { response: 0.36, damping: 0.62, precision: 0.02 });
  readonly tilt = new Spring(0, { response: 0.5, damping: 0.66, precision: 0.01 });
  /** Positive stretches, negative squashes. */
  readonly squash = new Spring(0, { response: 0.3, damping: 0.5, precision: 0.0005 });
  readonly press = new Spring(1, { response: 0.22, damping: 0.6, precision: 0.0005 });
  /** The macOS "wrong password" shake, px. */
  readonly shake = new Spring(0, { response: 0.15, damping: 0.2, precision: 0.02 });
  /** A nod, px down. */
  readonly nod = new Spring(0, { response: 0.24, damping: 0.4, precision: 0.02 });
  /** Shaking its head no, degrees. */
  readonly wag = new Spring(0, { response: 0.3, damping: 0.24, precision: 0.05 });
  /** A slow stretch upward, 0..1. */
  readonly tall = new Spring(0, { response: 0.6, damping: 0.85, precision: 0.002 });
  readonly eyeX = new Spring(0, { ...EYE_TRACKING, precision: 0.005 });
  readonly eyeY = new Spring(0, { ...EYE_TRACKING, precision: 0.005 });
  /** Cross-eyed, 0..1. */
  readonly cross = new Spring(0, { response: 0.35, damping: 0.68, precision: 0.002 });
  /** Eyelids: 1 open, 0 shut. */
  readonly lids = new Spring(1, { ...LID_OPEN, precision: 0.002 });
  readonly widen = new Spring(1, { response: 0.3, damping: 0.55, precision: 0.001 });
  readonly joy = new Spring(0, { response: 0.26, damping: 0.82, precision: 0.002 });
  readonly wince = new Spring(0, { response: 0.22, damping: 0.86, precision: 0.002 });
  readonly worry = new Spring(0, { response: 0.32, damping: 0.8, precision: 0.002 });
  /** How full the model's context window is, from the Text-to-SQL meter. */
  readonly strain = new Spring(0, { response: 0.5, damping: 0.72, precision: 0.002 });
  readonly grip = new Spring(1, { response: 0.32, damping: 0.6, precision: 0.002 });
  /** Reading glasses, px from where they sit (see WEAR). */
  readonly specs = new Spring(WEAR.specsOff, { ...SPECS_ON, precision: 0.02 });
  /** Sunglasses, flipped up (WEAR.shadesOff) to down (1). Damped low so the flip snaps past and settles. */
  readonly shades = new Spring(WEAR.shadesOff, { response: 0.36, damping: 0.56, precision: 0.002 });
  /** The glint across the sunglasses, 0..1. */
  readonly shine = new Spring(0, { response: 0.5, damping: 1, precision: 0.002 });
  /** The lower right arm and its hand lifted off the edge, 0..1. Quick, for taps. */
  readonly tap = new Spring(0, { response: 0.11, damping: 0.7, precision: 0.002 });
  /** Paws over its eyes, 0..1. */
  readonly cover = new Spring(0, { response: 0.32, damping: 0.72, precision: 0.002 });
  /** How far apart the paws are: 0 shut, 1 parted to peek. */
  readonly part = new Spring(1, { response: 0.16, damping: 0.75, precision: 0.002 });
  /** Holding its breath through an open transaction, 0..1. */
  readonly hold = new Spring(0, { response: 0.6, damping: 0.8, precision: 0.002 });
  /** The fedora, px from where it sits (see WEAR). Drops on with a little bounce. */
  readonly hat = new Spring(WEAR.hatOff, { response: 0.4, damping: 0.6, precision: 0.02 });

  pointer: Point | null = null;
  gaze: Point | null = null;
  hover = false;
  /** Reaching for a dragged table: 0.5 while it is anywhere, 1 when it is over Star. */
  reach = 0;
  reduced = false;
  onLanded: (() => void) | null = null;
  /** Being petted starts or stops. */
  onPetted: ((petted: boolean) => void) | null = null;

  private readonly body = [
    this.x, this.y, this.lift, this.rise, this.tilt, this.squash, this.press, this.shake,
    this.nod, this.wag, this.tall,
    this.eyeX, this.eyeY, this.cross, this.lids, this.widen, this.joy, this.wince, this.worry, this.strain,
    this.grip, this.specs, this.shades, this.shine, this.tap, this.cover, this.part, this.hold, this.hat,
  ];
  private springs: Spring[] = this.body;
  private els: MotionElements | null = null;
  private art: StarArt | null = null;
  private uid = 'star';
  private frame = 0;
  private last = 0;
  private clock = 0;
  /** The edge it peeks over; its body below this line is clipped away. */
  private edge = Infinity;
  private hop: Hop | null = null;
  private mood: MascotMood = 'idle';
  private drowsy = false;
  private jitter: Point = { x: 0, y: 0 };
  /** Looking around while idle: a direction for the eyes, -1..1. */
  private scan: Point | null = null;
  /** Recent lean targets, so the body can turn a beat after the eyes. */
  private leanLine: { t: number; v: number }[] = [];
  private rattleUntil = 0;
  /** Blinks wait while the face is busy (a yawn). performance.now() ms. */
  private faceHeldUntil = 0;
  private blurring = false;
  private puffs: Puff[] = [];
  private readingTimer: ReturnType<typeof setInterval> | undefined;
  /** Skimming the table in reading glasses: the reading saccades, without the work. */
  private skimTimer: ReturnType<typeof setInterval> | undefined;
  private wear: Wear = null;
  /** Peering over its reading glasses at you. */
  private peering = false;
  /** Waiting to go cross-eyed: the cursor has just come to rest on its face. */
  private parkTimer: ReturnType<typeof setTimeout> | undefined;
  private snoreTimer: ReturnType<typeof setInterval> | undefined;
  /** Taps while a slow query runs. */
  private waiting = false;
  private tapTimer: ReturnType<typeof setInterval> | undefined;
  /** Covering its eyes for a destructive approval, and the nervous peeks while it does. */
  private bracing = false;
  private peekTimer: ReturnType<typeof setInterval> | undefined;
  /** A held tilt of the head, degrees, on top of where it is looking: a shrug. */
  private cocked = 0;
  /** The statement being written would change every row. */
  private sweating = false;
  /** On a production connection: fedora on, no dozing or yawning. */
  private hatOn = false;
  /** Rubbing the cursor back and forth over it: when the direction last turned, and which way it is going. */
  private rub = { dir: 0, x: 0, turns: [] as number[] };
  private petted = false;
  private petTimer: ReturnType<typeof setTimeout> | undefined;
  private lifeTimers = new Set<ReturnType<typeof setTimeout>>();

  attach(els: MotionElements, uid: string, look: DrawnLook) {
    this.els = els;
    this.uid = uid;
    this.setLook(look);
    this.scheduleBlink();
    this.scheduleGlance();
  }

  /** Redraws Star in another colour, eyes or mouth, keeping everything else in motion. */
  setLook(look: DrawnLook) {
    if (!this.els) return;
    this.art = makeStar(this.els.art, this.uid, look, (fn, ms) =>
      this.after(ms, () => {
        fn();
        this.kick();
      }),
    );
    this.springs = [...this.body, ...this.art.springs];
    this.render(0);
    this.kick();
  }

  detach() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.els) this.els.pose.style.filter = '';
    this.els?.fx.querySelectorAll('.star-z-at').forEach(z => z.remove());
    this.blurring = false;
    this.els = null;
    this.art = null;
    this.cancelHop();
    clearInterval(this.readingTimer);
    this.readingTimer = undefined;
    clearInterval(this.skimTimer);
    this.skimTimer = undefined;
    clearTimeout(this.parkTimer);
    this.parkTimer = undefined;
    clearInterval(this.snoreTimer);
    this.snoreTimer = undefined;
    clearInterval(this.tapTimer);
    this.tapTimer = undefined;
    clearInterval(this.peekTimer);
    this.peekTimer = undefined;
    clearTimeout(this.petTimer);
    this.petTimer = undefined;
    this.petted = false;
    this.peering = false;
    this.lifeTimers.forEach(clearTimeout);
    this.lifeTimers.clear();
    this.puffs.forEach(p => p.el.remove());
    this.puffs = [];
    this.scan = null;
  }

  kick() {
    if (this.frame || !this.els) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Put it on a perch with no motion (first appearance). */
  place(p: Point) {
    this.x.snap(p.x);
    this.y.snap(p.y);
    this.edge = p.y + PEEK;
    this.render(0);
  }

  /** The perch moved (window resized, the dialog finished zooming in): glide with it. */
  follow(p: Point) {
    if (this.hop) {
      // The arc bends toward the new spot on the next frame.
      this.hop.target = p;
      this.hop.arriveEdge = p.y + PEEK;
    } else if (this.reduced) {
      this.place(p);
    } else {
      this.x.target = p.x;
      this.y.target = p.y;
      this.edge = p.y + PEEK;
    }
    this.kick();
  }

  /**
   * Hop to a new perch: let go and crouch, spring off, fly a real arc, sink
   * behind the new edge, squash on landing, take hold.
   */
  jumpTo(p: Point) {
    if (this.reduced) {
      this.cancelHop();
      this.place(p);
      this.onLanded?.();
      return;
    }
    const leaveEdge = this.edge;
    this.cancelHop();
    const hop: Hop = {
      phase: 'crouch',
      from: { x: this.x.value, y: this.y.value },
      target: p,
      t: 0,
      duration: 0.5,
      leaveEdge,
      arriveEdge: p.y + PEEK,
      cleared: false,
      aboveArrival: false,
      timer: undefined,
      started: performance.now(),
    };
    this.hop = hop;
    this.scan = null;
    clearTimeout(this.parkTimer);
    this.parkTimer = undefined;
    this.cross.target = 0;
    this.grip.target = 0;
    // Paws down behind the edge while it crouches.
    this.cover.target = 0;
    this.squash.velocity -= 0.9; // anticipation
    hop.timer = setTimeout(() => {
      hop.phase = 'air';
      hop.from = { x: this.x.value, y: this.y.value };
      hop.duration = flightTime(hop.from, hop.target);
      // Nothing hides them below the edge in the air.
      this.cover.snap(0);
      this.squash.velocity += 0.9; // springs off
      this.kick();
    }, 120);
    this.kick();
  }

  setMood(mood: MascotMood) {
    const was = this.mood;
    this.mood = mood;
    this.joy.target = mood === 'happy' ? 1 : 0;
    this.wince.target = mood === 'error' ? 1 : 0;
    if (!this.reduced) {
      if (mood === 'happy' && was !== 'happy') {
        this.lift.velocity -= 300;
        this.tilt.velocity += (Math.random() < 0.5 ? -1 : 1) * 70;
        this.art?.gesture('happy');
      }
      if (mood === 'error' && was !== 'error') this.shake.velocity += 280;
    }
    this.setReading(mood === 'thinking');
    this.kick();
  }

  /** How full the model's context window is: it strains near the limit and worries past it. */
  setStrain(v: number) {
    this.strain.target = clamp(v, 0, 1.25);
    this.worry.target = this.restingWorry();
    this.kick();
  }

  /** Lets its breath out: puffs of air and a little sag. Compact in the meter. */
  exhale() {
    if (this.reduced || !this.els) return;
    this.squash.velocity -= 1.1;
    STAR.puffs.forEach(([x, y], i) => {
      const el = document.createElementNS(SVGNS, 'circle');
      // Theme ink, like the Zs: near-white puffs vanish on a light window.
      el.style.fill = 'hsl(var(--muted-foreground))';
      el.setAttribute('r', '0');
      this.els!.fx.append(el);
      this.puffs.push({ el, x, y, vx: (i - 1) * 5, born: this.clock + i * 0.07 });
    });
    this.kick();
  }

  get wearing(): Wear {
    return this.wear;
  }

  /**
   * Puts on what the connection's mode calls for: reading glasses in
   * Read-only, sunglasses in YOLO, nothing otherwise. Whatever it had on
   * comes off first.
   */
  setWear(wear: Wear) {
    if (wear === this.wear) return;
    const was = this.wear;
    this.wear = wear;
    if (this.peering) this.endPeer();
    if (this.reduced) {
      this.specs.snap(wear === 'reading' ? 0 : WEAR.specsOff);
      this.shades.snap(wear === 'shades' ? 1 : WEAR.shadesOff);
      this.kick();
      return;
    }
    if (was === 'reading') {
      this.specs.configure(SPECS_OFF);
      this.specs.target = WEAR.specsOff;
      this.specs.velocity -= 40;
    }
    if (was === 'shades') this.shades.target = WEAR.shadesOff;
    const putOn = () => {
      if (this.wear !== wear) return;
      if (wear === 'reading') this.putOnSpecs();
      if (wear === 'shades') this.putOnShades();
    };
    if (was) this.after(260, putOn);
    else putOn();
    this.kick();
  }

  /** The reading glasses drop onto its nose; it blinks, then pushes them up. */
  private putOnSpecs() {
    this.specs.configure(SPECS_ON);
    this.specs.target = 0;
    this.after(280, () => {
      this.blink(false);
      this.squash.velocity -= 0.25;
    });
    this.after(520, () => this.pushUpSpecs());
  }

  private pushUpSpecs() {
    if (this.wear !== 'reading' || this.peering) return;
    this.specs.configure(SPECS_PUSH);
    this.specs.target = 0;
    this.specs.velocity -= 48;
    this.art?.gesture('nudge');
  }

  /** The sunglasses flip down; a little tilt of the head, and a glint across the lenses. */
  private putOnShades() {
    this.shine.snap(0);
    this.shades.target = 1;
    this.after(240, () => {
      if (this.wear !== 'shades') return;
      this.tilt.velocity += (Math.random() < 0.5 ? -1 : 1) * 45;
      this.squash.velocity -= 0.3;
      this.shine.target = 1;
    });
  }

  /**
   * The connection's mode refused something. In reading glasses it peers
   * over them at you: they slide down its nose, its eyes look up over the
   * rims, half-lidded, and after a beat it pushes them back up. Without them
   * it shakes its head.
   */
  refuse() {
    if (this.reduced) return;
    if (this.wear !== 'reading' || this.hop) {
      this.shakeNo();
      return;
    }
    if (this.peering) return;
    this.peering = true;
    this.scan = null;
    this.stopSkim();
    this.faceHeldUntil = performance.now() + 1650;
    this.specs.configure(SPECS_SLIDE);
    this.specs.target = WEAR.peer;
    // Lowered lids, but not so far that cut-out eyes squash into dots.
    this.lids.configure(LID_OPEN);
    this.lids.target = 0.85;
    this.nod.target = 1.2;
    this.after(1500, () => {
      if (!this.peering) return;
      this.endPeer();
      this.after(140, () => this.pushUpSpecs());
    });
    this.kick();
  }

  private endPeer() {
    this.peering = false;
    this.nod.target = 0;
    this.lids.configure(this.drowsy ? LID_DROWSY : LID_OPEN);
    this.lids.target = this.restingLids();
  }

  /**
   * The cursor moved. Left on its face for a moment, it goes cross-eyed
   * trying to look at it; when the cursor leaves, it blinks and shakes it off.
   */
  movePointer(p: Point) {
    this.pointer = p;
    this.trackRub(p);
    const near = this.nearFace(p);
    if (near && this.parkTimer === undefined && this.cross.target === 0) {
      this.parkTimer = setTimeout(() => {
        this.parkTimer = undefined;
        // Not while it reaches for a dragged table, when the cursor has moved
        // on, or when the cursor is rubbing rather than resting.
        const rubbing = this.petted || this.rub.turns.some(t => performance.now() - t < CROSS_AFTER);
        if (this.reduced || this.reach > 0 || rubbing || !this.pointer || !this.nearFace(this.pointer)) return;
        this.cross.target = 1;
        this.kick();
      }, CROSS_AFTER);
    } else if (!near) {
      clearTimeout(this.parkTimer);
      this.parkTimer = undefined;
      if (this.cross.target === 1) {
        this.cross.target = 0;
        this.blink(false);
        this.wag.velocity += 60;
      }
    }
    this.kick();
  }

  /** Whether a point is on its face, near the middle of its eyes. */
  private nearFace(p: Point) {
    const ex = this.x.value + STAR.eye.x;
    const ey = this.y.value + this.lift.value + this.rise.value + STAR.eye.y;
    return Math.hypot(p.x - ex, p.y - ey) < CROSS_RADIUS;
  }

  // --- being petted ------------------------------------------------------------------

  /**
   * Rubbing the cursor back and forth over it is petting: three turns of
   * direction over its body within a moment.
   */
  private trackRub(p: Point) {
    const cx = this.x.value + 32;
    const cy = this.y.value + this.lift.value + this.rise.value + 32;
    const over = Math.hypot(p.x - cx, p.y - cy) < PET_RADIUS && p.y < this.edge;
    if (!over || this.hop) {
      this.rub.dir = 0;
      this.rub.turns = [];
      this.rub.x = p.x;
      if (this.petted) this.endPetSoon(250);
      return;
    }
    const dx = p.x - this.rub.x;
    if (Math.abs(dx) < 1.5) return;
    const dir = Math.sign(dx);
    this.rub.x = p.x;
    if (this.rub.dir && dir !== this.rub.dir) {
      const now = performance.now();
      this.rub.turns = this.rub.turns.filter(t => now - t < PET_WINDOW).concat(now);
      if (this.rub.turns.length >= 3) this.pet(dir);
    }
    this.rub.dir = dir;
  }

  /** Petted: a happy squint and rosy cheeks, leaning into each stroke. */
  private pet(dir: number) {
    if (this.reduced) return;
    if (!this.petted) {
      this.petted = true;
      clearTimeout(this.parkTimer);
      this.parkTimer = undefined;
      this.cross.target = 0;
      this.joy.target = 1;
      this.lift.velocity -= 80;
      this.onPetted?.(true);
    }
    this.cocked = dir * 5;
    this.tilt.velocity += dir * 25;
    this.endPetSoon(700);
    this.kick();
  }

  private endPetSoon(ms: number) {
    clearTimeout(this.petTimer);
    this.petTimer = setTimeout(() => this.endPet(), ms);
  }

  private endPet() {
    clearTimeout(this.petTimer);
    this.petTimer = undefined;
    if (!this.petted) return;
    this.petted = false;
    this.cocked = 0;
    this.rub.turns = [];
    this.joy.target = this.mood === 'happy' ? 1 : 0;
    this.onPetted?.(false);
    // A contented blink once its eyes are open again.
    this.after(300, () => this.blink(false));
    this.kick();
  }

  /**
   * The window went light: it squints against the glare, then its eyes
   * adjust by degrees. `whileShut` runs once they are narrowed: the moment
   * to change its colour without anyone seeing it happen.
   */
  squint(whileShut?: () => void) {
    if (this.reduced) {
      whileShut?.();
      return;
    }
    this.faceHeldUntil = performance.now() + 1500;
    this.lids.configure(LID_CLOSE);
    this.lids.target = 0.2;
    this.squash.velocity -= 0.5;
    if (whileShut) this.after(90, whileShut);
    this.after(650, () => {
      this.lids.configure(LID_ADJUST);
      this.lids.target = 0.6;
    });
    this.after(1100, () => {
      this.lids.configure(this.drowsy ? LID_DROWSY : LID_OPEN);
      this.lids.target = this.restingLids();
    });
    this.kick();
  }

  /**
   * The window went dark: its eyes open wide to take it in, then a blink.
   * With `whileShut` it blinks first and that runs with its eyes closed.
   */
  widenInDark(whileShut?: () => void) {
    if (this.reduced) {
      whileShut?.();
      return;
    }
    const widen = () => {
      this.widen.target = 1.25;
      this.widen.velocity += 1.2;
      this.after(750, () => {
        this.widen.target = this.hover ? 1.1 : 1;
        this.blink(false);
      });
    };
    if (whileShut) {
      this.faceHeldUntil = performance.now() + 300;
      this.lids.configure(LID_CLOSE);
      this.lids.target = 0.04;
      this.after(80, () => {
        whileShut();
        this.lids.configure(LID_OPEN);
        this.lids.target = this.restingLids();
        widen();
      });
    } else {
      widen();
    }
    this.kick();
  }

  // --- reacting to results ----------------------------------------------------------

  /** A query found nothing: the upper side arms lift, the head tilts, the eyes go up to one side. */
  shrug() {
    if (this.reduced || this.hop) return;
    const side = Math.random() < 0.5 ? -1 : 1;
    this.cocked = side * 6;
    this.scan = { x: side * 0.5, y: -0.7 };
    // Shoulders up: the body bobs up with the arms.
    this.lift.velocity -= 130;
    this.art?.gesture('shrug');
    this.after(700, () => {
      this.cocked = 0;
      this.scan = null;
    });
    this.kick();
  }

  /** A query found more rows than the editor shows: eyes wide, a little round mouth, and it rears back. */
  whoa() {
    if (this.reduced || this.hop) return;
    this.widen.target = 1.32;
    this.widen.velocity += 2;
    this.worry.target = 1;
    this.lift.velocity -= 150;
    this.tall.target = 0.35;
    this.after(900, () => {
      this.widen.target = this.hover ? 1.1 : 1;
      this.worry.target = this.restingWorry();
      this.tall.target = 0;
    });
    this.kick();
  }

  /** An agent's write undone: the happy spin played backwards, with a hop and a pleased face. */
  rewind() {
    if (this.reduced) return;
    this.art?.gesture('rewind');
    this.lift.velocity -= 240;
    this.tilt.velocity -= (Math.random() < 0.5 ? -1 : 1) * 70;
    this.joy.target = 1;
    this.after(1000, () => {
      this.joy.target = this.mood === 'happy' ? 1 : 0;
    });
    this.kick();
  }

  /**
   * A query is taking its time: the arm that holds the edge on its right
   * taps, three at a time, until it finishes. Then it lets its breath out.
   */
  setWaiting(on: boolean) {
    if (on === this.waiting) return;
    this.waiting = on;
    clearInterval(this.tapTimer);
    this.tapTimer = undefined;
    this.tap.target = 0;
    if (on) {
      if (this.reduced) return;
      const burst = () => [0, 170, 340].forEach(ms => this.after(ms, () => this.tapOnce()));
      this.tapTimer = setInterval(burst, 1300);
      burst();
    } else {
      this.exhale();
    }
    this.kick();
  }

  private tapOnce() {
    if (!this.waiting || this.hop) return;
    this.tap.target = 1;
    this.after(70, () => {
      this.tap.target = 0;
    });
  }

  /**
   * An approval for a statement that destroys data is up: it lets go of the
   * edge and covers its eyes, then peeks between its paws, hiding again now
   * and then. If it is still hopping onto the dialog, it does this on landing.
   */
  setBracing(on: boolean) {
    if (on === this.bracing) return;
    this.bracing = on;
    if (on) this.raisePaws();
    else this.lowerPaws();
    this.kick();
  }

  private raisePaws() {
    if (!this.bracing || this.hop) return;
    clearInterval(this.peekTimer);
    if (this.reduced) {
      this.cover.snap(1);
      this.part.snap(1);
      this.grip.snap(0);
      return;
    }
    this.part.snap(0);
    this.cover.target = 1;
    this.grip.target = 0;
    this.after(650, () => {
      if (this.bracing) this.part.target = 1;
    });
    this.peekTimer = setInterval(() => {
      if (!this.bracing || this.hop) return;
      this.part.target = 0;
      this.after(420, () => {
        if (this.bracing) this.part.target = 1;
      });
      this.kick();
    }, 2600);
    this.kick();
  }

  private lowerPaws() {
    clearInterval(this.peekTimer);
    this.peekTimer = undefined;
    if (this.reduced) {
      this.cover.snap(0);
      if (!this.hop) this.grip.snap(1);
      return;
    }
    this.cover.target = 0;
    // Hopping home: it takes hold again when it lands.
    if (!this.hop) this.grip.target = 1;
  }

  // --- what the editor and the connection are up to ------------------------------------

  /**
   * The statement being written would change every row (no WHERE): a bead
   * of sweat and a worried brow. When it gets its WHERE, it wipes its brow.
   */
  setSweating(on: boolean) {
    if (on === this.sweating) return;
    this.sweating = on;
    this.worry.target = this.restingWorry();
    if (!this.reduced) {
      if (on) this.widen.velocity += 1.4;
      else {
        this.art?.gesture('wipe');
        this.squash.velocity -= 0.3;
      }
    }
    this.kick();
  }

  /** Worried while it sweats over a statement, or while the prompt will not fit. */
  private restingWorry() {
    return this.sweating || this.strain.target > 1 ? 1 : 0;
  }

  /** A transaction is open: it holds its breath, puffed up and mouth pressed shut, until COMMIT or ROLLBACK. */
  setHolding(on: boolean) {
    if (on === (this.hold.target === 1)) return;
    if (this.reduced) {
      this.hold.snap(on ? 1 : 0);
    } else {
      this.hold.target = on ? 1 : 0;
      // A breath in.
      if (on) {
        this.squash.velocity += 0.5;
        this.lift.velocity -= 90;
      }
    }
    // Eyes scrunched a little while it holds it; a face without a mouth still shows the effort.
    this.lids.configure(this.drowsy ? LID_DROWSY : LID_ADJUST);
    this.lids.target = this.restingLids();
    this.kick();
  }

  /** Where its eyelids rest between blinks: heavy when drowsy, scrunched while it holds its breath. */
  private restingLids() {
    return this.drowsy ? 0.32 : this.hold.target === 1 ? 0.72 : 1;
  }

  /** COMMIT: the breath it held comes out in one big exhale. */
  commit() {
    this.hold.target = 0;
    this.lids.target = this.restingLids();
    this.exhale();
    this.after(140, () => this.exhale());
    this.kick();
  }

  /** ROLLBACK: relief. It sags and shuts its eyes for a moment; nothing to blow out. */
  rollback() {
    this.hold.target = 0;
    if (this.reduced) {
      this.hold.snap(0);
      this.lids.target = this.restingLids();
      this.kick();
      return;
    }
    this.squash.velocity -= 1.3;
    this.nod.velocity += 120;
    this.faceHeldUntil = performance.now() + 700;
    this.lids.configure(LID_ADJUST);
    this.lids.target = 0.15;
    this.after(550, () => {
      this.lids.configure(this.drowsy ? LID_DROWSY : LID_OPEN);
      this.lids.target = this.restingLids();
    });
    this.kick();
  }

  get onProduction(): boolean {
    return this.hatOn;
  }

  /** On a production connection it wears a detective's fedora, which drops onto its head with a little bounce, the top arm tucking away under it. */
  setHat(on: boolean) {
    if (on === this.hatOn) return;
    this.hatOn = on;
    if (this.reduced) {
      this.hat.snap(on ? 0 : WEAR.hatOff);
    } else {
      this.hat.target = on ? 0 : WEAR.hatOff;
      if (on) {
        this.after(250, () => {
          if (!this.hatOn) return;
          this.squash.velocity -= 0.45;
          this.blink(false);
        });
      } else {
        this.hat.velocity -= 60;
      }
    }
    this.kick();
  }

  /** Waves one arm. */
  hello() {
    if (!this.reduced) this.art?.gesture('hello');
    this.kick();
  }

  /** Yes: two quick dips. Just the one if it is hopping by then, so the arc stays clean. */
  nodYes() {
    if (this.reduced) return;
    this.nod.velocity += 140;
    this.squash.velocity -= 0.4;
    this.after(220, () => {
      if (this.hop) return;
      this.nod.velocity += 110;
      this.squash.velocity -= 0.3;
    });
    this.kick();
  }

  /** No: a shake of the head. */
  shakeNo() {
    if (this.reduced) return;
    this.wag.velocity += 170;
    this.kick();
  }

  /** Its arms rattle: generated SQL is running with nobody reviewing it. */
  rattle(ms = 800) {
    if (this.reduced) return;
    this.rattleUntil = this.clock + ms / 1000;
    this.kick();
  }

  setDrowsy(drowsy: boolean) {
    if (drowsy === this.drowsy) return;
    this.drowsy = drowsy;
    this.lids.configure(drowsy ? LID_DROWSY : LID_OPEN);
    this.lids.target = this.restingLids();
    clearInterval(this.snoreTimer);
    this.snoreTimer = undefined;
    if (drowsy) {
      // The first Z once its eyes are mostly shut.
      this.after(900, () => this.snore());
      this.snoreTimer = setInterval(() => this.snore(), SNORE_EVERY);
    } else {
      this.hushSnores();
    }
    if (!drowsy) {
      this.widen.velocity += 1.2; // wakes with a little start
      // ...then a yawn and a stretch.
      this.after(380, () => {
        this.yawn();
        this.after(1000, () => this.stretch());
      });
    }
    this.kick();
  }

  /**
   * A Z floats up from above its head. The float is a CSS animation
   * (.star-z in index.css), not the spring loop, so a long nap does not keep
   * the frame loop awake.
   */
  private snore() {
    const fx = this.els?.fx;
    if (this.reduced || !fx || !this.drowsy) return;
    // A nap in a hidden window stacks them up while animations are paused: keep the last few.
    const waiting = fx.querySelectorAll('.star-z-at');
    if (waiting.length >= 3) waiting[0].remove();
    const at = document.createElementNS(SVGNS, 'g');
    at.setAttribute('class', 'star-z-at');
    at.setAttribute('transform', `translate(${STAR.snore.x} ${STAR.snore.y})`);
    const z = document.createElementNS(SVGNS, 'path');
    z.setAttribute('class', 'star-z');
    z.setAttribute('d', 'M-2 -2.1 H2 L-2 2.1 H2');
    z.addEventListener('animationend', () => at.remove());
    at.append(z);
    fx.append(at);
  }

  /** Woken: the Zs in the air vanish. */
  private hushSnores() {
    this.els?.fx.querySelectorAll('.star-z-at').forEach(at => {
      at.classList.add('is-hushed');
      setTimeout(() => at.remove(), 200);
    });
  }

  /** Something new to look at: the eyes perk up and an arm lifts. */
  perk() {
    if (!this.reduced) {
      this.widen.velocity += 1.3;
      this.art?.gesture('attend');
    }
    this.kick();
  }

  // --- idle moments -----------------------------------------------------------------

  /** Looks left, then right, then back, with the body turning after the eyes. */
  lookAround() {
    if (this.reduced || this.hop || this.scan) return;
    const steps: [number, number, number][] = [
      [-1, -0.25, 700],
      [1, -0.35, 900],
      [0.25, 0.45, 600],
    ];
    let at = 0;
    for (const [x, y, ms] of steps) {
      this.after(at, () => {
        this.scan = { x, y };
        this.kick();
      });
      at += ms;
    }
    this.after(at, () => {
      this.scan = null;
      this.kick();
    });
  }

  /**
   * Skims the table above it like a page: the saccades it reads with while
   * it works, without the spinning. Its idle moment in reading glasses.
   */
  skim(ms = 2600) {
    if (this.reduced || this.hop || this.scan || this.peering) return;
    if (this.skimTimer !== undefined || this.readingTimer !== undefined) return;
    this.eyeX.configure(EYE_READING);
    this.eyeY.configure(EYE_READING);
    let step = 0;
    const next = () => {
      const [ex, ey] = READING[step++ % READING.length];
      this.eyeX.target = ex;
      this.eyeY.target = ey - 0.8;
      this.kick();
    };
    next();
    this.skimTimer = setInterval(next, 210);
    this.after(ms, () => this.stopSkim());
  }

  private stopSkim() {
    if (this.skimTimer === undefined) return;
    clearInterval(this.skimTimer);
    this.skimTimer = undefined;
    if (this.readingTimer === undefined) {
      this.eyeX.configure(EYE_TRACKING);
      this.eyeY.configure(EYE_TRACKING);
    }
  }

  /** Stretches up tall, arms raised. */
  stretch() {
    if (this.reduced || this.hop) return;
    this.tall.target = 1;
    this.art?.gesture('stretch');
    this.after(800, () => {
      this.tall.target = 0;
    });
    this.kick();
  }

  /** Eyes squeeze shut, it stretches a little, the mouth (if it has one) opens wide. */
  yawn() {
    if (this.reduced || this.hop) return;
    this.faceHeldUntil = performance.now() + 1300;
    this.lids.configure(LID_YAWN);
    this.lids.target = 0.1;
    this.tall.target = 0.55;
    this.art?.gesture('yawn');
    this.after(1150, () => {
      this.lids.configure(this.drowsy ? LID_DROWSY : LID_OPEN);
      this.lids.target = this.restingLids();
      this.tall.target = 0;
    });
    this.kick();
  }

  // --- life -----------------------------------------------------------------

  /** A timeout that detach() cancels. Kicks the frame loop when it fires. */
  private after(ms: number, fn: () => void) {
    const id = setTimeout(() => {
      this.lifeTimers.delete(id);
      fn();
      this.kick();
    }, ms);
    this.lifeTimers.add(id);
  }

  private scheduleBlink() {
    this.after(2200 + Math.random() * 3800, () => {
      this.blink(Math.random() < 0.18);
      this.scheduleBlink();
    });
  }

  private blink(twice: boolean) {
    if (!this.els || this.drowsy || this.mood === 'happy' || this.mood === 'error') return;
    if (performance.now() < this.faceHeldUntil) return;
    this.lids.configure(LID_CLOSE);
    this.lids.target = 0.04;
    this.after(85, () => {
      // It may have dozed off mid-blink.
      this.lids.configure(this.drowsy ? LID_DROWSY : LID_OPEN);
      this.lids.target = this.restingLids();
      if (twice) this.after(170, () => this.blink(false));
    });
  }

  /** Small involuntary glances, so it never stares like a picture. */
  private scheduleGlance() {
    this.after(1600 + Math.random() * 2600, () => {
      this.jitter = { x: (Math.random() - 0.5) * 1.4, y: (Math.random() - 0.5) * 0.9 };
      this.scheduleGlance();
    });
  }

  private setReading(on: boolean) {
    // A change of mood means something happened: whatever it was skimming can wait.
    this.stopSkim();
    clearInterval(this.readingTimer);
    this.readingTimer = undefined;
    const eyes = on ? EYE_READING : EYE_TRACKING;
    this.eyeX.configure(eyes);
    this.eyeY.configure(eyes);
    if (!on) return;
    let step = 0;
    const next = () => {
      const [ex, ey] = READING[step % READING.length];
      this.eyeX.target = ex;
      this.eyeY.target = ey;
      step++;
      this.kick();
    };
    next();
    this.readingTimer = setInterval(next, 190);
  }

  private cancelHop() {
    clearTimeout(this.hop?.timer);
    this.hop = null;
  }

  // --- frame loop -----------------------------------------------------------------

  private tick = (now: number) => {
    this.frame = 0;
    if (!this.els) return;
    const dt = clamp((now - this.last) / 1000, 0, 1 / 20);
    this.last = now;
    this.clock += dt;

    this.aim();
    const liftBefore = this.lift.value;
    for (const spring of this.springs) spring.step(dt);
    this.fly(dt);

    // Squash on touchdown from a hop in place, in proportion to how hard it came down.
    if (!this.reduced && liftBefore < 0 && this.lift.value >= 0 && this.lift.velocity > 120) {
      this.squash.velocity -= Math.min(1.4, this.lift.velocity * 0.0016);
    }

    this.trackHop(now);
    const st = this.render(dt);

    const trembling = this.strain.value > 0.85 || this.strain.target > 0.85;
    const line = this.leanLine;
    const turning = line.length > 1 && Math.abs(line[line.length - 1].v - line[0].v) > 0.01;
    if (
      this.hop ||
      this.puffs.length ||
      trembling ||
      turning ||
      this.scan ||
      (st && this.art?.busy(st)) ||
      this.springs.some(s => !s.resting)
    ) {
      this.frame = requestAnimationFrame(this.tick);
    }
  };

  /** Point the eyes at what it is attending to; the body turns toward it a beat later. */
  private aim() {
    const reading = this.readingTimer !== undefined || this.skimTimer !== undefined;
    const target = this.gaze ?? (this.scan ? null : this.pointer);
    let lean = 0;
    if (target) {
      const dx = target.x - (this.x.value + STAR.eye.x);
      const dy = target.y - (this.y.value + this.lift.value + this.rise.value + STAR.eye.y);
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, d / 140);
      if (!reading) {
        this.eyeX.target = (dx / d) * 3.2 * reach + this.jitter.x * (1 - reach * 0.6);
        this.eyeY.target = (dy / d) * 2.6 * reach + this.jitter.y * (1 - reach * 0.6);
      }
      lean = clamp(dx / 700, -1, 1) * 4;
    } else if (this.scan && !reading) {
      this.eyeX.target = this.scan.x * 3.2;
      this.eyeY.target = this.scan.y * 2.6;
      lean = this.scan.x * 5;
    } else if (!reading) {
      this.eyeX.target = this.jitter.x;
      this.eyeY.target = this.jitter.y;
    }
    if (this.peering) {
      // Up over the rims, straight at you.
      this.eyeX.target = 0;
      this.eyeY.target = -2.6;
    }

    // Eyes lead; the body turns after them. Keep the lean targets of the last
    // moment and steer by the one from TURN_DELAY ago.
    const line = this.leanLine;
    line.push({ t: this.clock, v: lean });
    while (line.length > 2 && line[1].t <= this.clock - TURN_DELAY) line.shift();
    // Travel is not delayed: it leans into a hop the moment it moves.
    this.tilt.target = line[0].v + clamp(this.x.velocity / 1500, -1, 1) * 9 + this.cocked;
  }

  /** Move along the arc. Runs after the springs, so the arc has the last word on position. */
  private fly(dt: number) {
    const hop = this.hop;
    if (!hop || hop.phase !== 'air') return;
    hop.t = Math.min(1, hop.t + dt / hop.duration);
    const { from, target: to } = hop;
    const c = arcControl(from, to);
    const t = hop.t;
    const u = 1 - t;
    const x = u * u * from.x + 2 * u * t * c.x + t * t * to.x;
    const y = u * u * from.y + 2 * u * t * c.y + t * t * to.y;
    // Derivative of the curve, per second.
    const vx = (2 * u * (c.x - from.x) + 2 * t * (to.x - c.x)) / hop.duration;
    const vy = (2 * u * (c.y - from.y) + 2 * t * (to.y - c.y)) / hop.duration;
    this.x.value = this.x.target = x;
    this.y.value = this.y.target = y;
    this.x.velocity = vx;
    this.y.velocity = vy;
  }

  private trackHop(now: number) {
    const hop = this.hop;
    if (!hop || hop.phase === 'crouch') return;
    const bottom = this.y.value + this.lift.value + this.rise.value + H;

    if (!hop.cleared) {
      this.edge = hop.leaveEdge;
      if (bottom < hop.leaveEdge - 0.5 || now - hop.started > 700) {
        hop.cleared = true;
        this.edge = Infinity;
      }
    }
    if (hop.cleared) {
      if (bottom <= hop.arriveEdge + 0.5) hop.aboveArrival = true;
      // Over the new perch and coming down: from here it sinks behind the new edge.
      const descending = this.lift.velocity + this.y.velocity > 0;
      if (hop.aboveArrival && descending) this.edge = hop.arriveEdge;
    }

    if (hop.t < 1) return;
    // Touchdown: the fingertips catch the edge and the body gives a little,
    // then settles. Deliberately soft. The drop from a dialog to the status
    // bar lands at around 2,500 px/s, and handing a fixed share of that back
    // to the springs read as a slam: the body sank about 11 px. So the impact
    // is scaled down and capped, whatever the distance.
    const vx = this.x.velocity;
    const impact = clamp(this.y.velocity / 2400, 0, 1);
    this.x.value = this.x.target = hop.target.x;
    this.y.value = this.y.target = hop.target.y;
    this.x.velocity = vx * 0.05;
    this.y.velocity = 40 + 70 * impact; // a 2 to 4 px give
    this.squash.velocity -= 0.25 + 0.45 * impact;
    this.edge = hop.arriveEdge;
    this.cancelHop();
    this.grip.target = 1;
    this.art?.gesture('land', 0.2 + 0.5 * impact);
    // Landed on a destructive approval: it takes hold, then covers its eyes.
    if (this.bracing) this.after(220, () => this.raisePaws());
    this.onLanded?.();
  }

  private render(dt: number): StarState | null {
    const els = this.els;
    if (!els || !this.art) return null;
    const rattling = !this.reduced && this.clock < this.rattleUntil;
    // Trembles when the prompt is about to overflow; jitters while it rattles.
    const tremble = this.reduced ? 0 : clamp((this.strain.value - 0.85) * 2.4, 0, 0.8);
    const jolt = (tremble ? (Math.random() * 2 - 1) * tremble * 0.45 : 0) + (rattling ? (Math.random() * 2 - 1) * 1.1 : 0);
    const x = this.x.value + this.shake.value + jolt;
    const y = this.y.value + this.lift.value + this.rise.value + this.nod.value;
    els.body.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
    // Clip at the edge, not at the body: as it rises, more of it shows.
    const hidden = this.edge === Infinity ? 0 : clamp(y + H - this.edge, 0, H);
    els.body.style.clipPath = `inset(-200px -320px ${hidden.toFixed(2)}px -320px)`;

    const grip = clamp(this.grip.value, 0, 1.15);
    // The fingertips hold the edge. They follow the body up, but never below
    // the edge it peeks over: when the body gives on landing or overshoots
    // gliding to a new perch, they stay on the bar instead of sinking into it.
    const handsY = this.edge === Infinity ? this.y.value : Math.min(this.y.value, this.edge - PEEK);
    els.hands.style.transform = `translate3d(${(this.x.value + this.shake.value * 0.3).toFixed(2)}px, ${handsY.toFixed(2)}px, 0)`;
    els.hands.style.opacity = clamp(grip, 0, 1).toFixed(3);
    els.hands.style.setProperty('--grip', grip.toFixed(3));
    els.hands.style.setProperty('--tap', clamp(this.tap.value, 0, 1.2).toFixed(3));

    const vx = this.x.velocity;
    const vy = this.lift.velocity + this.y.velocity;
    const stretch = this.reduced ? 0 : clamp(Math.abs(vy) / 2800, 0, 0.05);
    const s = this.squash.value;
    const tall = this.tall.value;
    // A held breath puffs it up, wider more than taller.
    const held = this.hold.value;
    const sy = (1 + stretch + s + this.strain.value * 0.012 + tall * 0.08 + held * 0.025) * this.press.value;
    const sx = (1 - stretch * 0.6 - s * 0.75 + this.strain.value * 0.02 - tall * 0.04 + held * 0.045) * this.press.value;
    const angle = this.tilt.value + this.wag.value;
    els.pose.style.transform = `rotate(${angle.toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;

    // A hint of motion blur at the fastest part of a hop, along the direction of travel.
    const speed = Math.hypot(vx, vy);
    const smear = this.reduced || !this.hop ? 0 : clamp((speed - 900) / 1500, 0, 1) * 1.6;
    if (smear > 0.05) {
      els.blur.setAttribute('stdDeviation', `${((smear * Math.abs(vx)) / speed).toFixed(2)} ${((smear * Math.abs(vy)) / speed).toFixed(2)}`);
      if (!this.blurring) {
        els.pose.style.filter = `url(#${els.blurId})`;
        this.blurring = true;
      }
    } else if (this.blurring) {
      els.pose.style.filter = '';
      this.blurring = false;
    }

    const st: StarState = {
      t: this.clock, dt, ex: this.eyeX.value, ey: this.eyeY.value, cross: this.cross.value, open: this.lids.value, widen: this.widen.value,
      joy: this.joy.value, wince: this.wince.value, worry: this.worry.value, strain: this.strain.value,
      think: this.readingTimer !== undefined, hover: this.hover, reach: this.reach, rattle: rattling,
      vx, specs: this.specs.value, shades: this.shades.value, shine: this.shine.value,
      tap: this.tap.value, cover: this.cover.value, part: this.part.value,
      sweat: this.sweating, hold: this.hold.value, hat: this.hat.value, reduced: this.reduced,
    };
    this.art.render(st);

    // Puffs of air rise and fade.
    this.puffs = this.puffs.filter(p => {
      const age = this.clock - p.born;
      if (age < 0) return true;
      const t = age / 0.9;
      if (t >= 1) { p.el.remove(); return false; }
      p.x += p.vx * dt;
      p.y -= 22 * dt;
      p.el.setAttribute('cx', p.x.toFixed(2));
      p.el.setAttribute('cy', p.y.toFixed(2));
      p.el.setAttribute('r', (1.2 + 2.4 * t).toFixed(2));
      p.el.setAttribute('opacity', (0.65 * (1 - t)).toFixed(3));
      return true;
    });
    return st;
  }
}
