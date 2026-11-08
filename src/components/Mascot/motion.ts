// The mascot's motion: everything on springs, driven by one frame loop that
// sleeps as soon as every spring has settled. Springs carry their velocity
// into a new target, so motion that changes mid-flight (the dialog still
// zooming in, the cursor moving during a hop) stays continuous.
//
// The rig moves the whole body (hops, squash and stretch, tilt, the hands on
// the edge, the read-only padlock, puffs of air) and hands the character a
// state each frame; ./art.ts draws Star and animates its arms and eyes.

import { Spring } from '@/lib/spring';
import type { MascotMood, StarLook } from '@/lib/mascot';
import { makeStar, STAR, type StarArt, type StarState } from './art';

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
  /** The padlock shown in Read-only mode. */
  badge: SVGSVGElement;
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
  /** Eyelids: 1 open, 0 shut. */
  readonly lids = new Spring(1, { ...LID_OPEN, precision: 0.002 });
  readonly widen = new Spring(1, { response: 0.3, damping: 0.55, precision: 0.001 });
  readonly joy = new Spring(0, { response: 0.26, damping: 0.82, precision: 0.002 });
  readonly wince = new Spring(0, { response: 0.22, damping: 0.86, precision: 0.002 });
  readonly worry = new Spring(0, { response: 0.32, damping: 0.8, precision: 0.002 });
  /** How full the model's context window is, from the Text-to-SQL meter. */
  readonly strain = new Spring(0, { response: 0.5, damping: 0.72, precision: 0.002 });
  readonly grip = new Spring(1, { response: 0.32, damping: 0.6, precision: 0.002 });
  readonly latch = new Spring(0, { response: 0.3, damping: 0.5, precision: 0.002 });
  readonly wiggle = new Spring(0, { response: 0.2, damping: 0.2, precision: 0.05 });

  pointer: Point | null = null;
  gaze: Point | null = null;
  hover = false;
  /** Reaching for a dragged table: 0.5 while it is anywhere, 1 when it is over Star. */
  reach = 0;
  reduced = false;
  onLanded: (() => void) | null = null;

  private readonly body = [
    this.x, this.y, this.lift, this.rise, this.tilt, this.squash, this.press, this.shake,
    this.nod, this.wag, this.tall,
    this.eyeX, this.eyeY, this.lids, this.widen, this.joy, this.wince, this.worry, this.strain,
    this.grip, this.latch, this.wiggle,
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
  private lifeTimers = new Set<ReturnType<typeof setTimeout>>();

  attach(els: MotionElements, uid: string, look: StarLook) {
    this.els = els;
    this.uid = uid;
    this.setLook(look);
    this.scheduleBlink();
    this.scheduleGlance();
  }

  /** Redraws Star in another colour, eyes or mouth, keeping everything else in motion. */
  setLook(look: StarLook) {
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
    this.blurring = false;
    this.els = null;
    this.art = null;
    this.cancelHop();
    clearInterval(this.readingTimer);
    this.readingTimer = undefined;
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
    this.grip.target = 0;
    this.squash.velocity -= 0.9; // anticipation
    hop.timer = setTimeout(() => {
      hop.phase = 'air';
      hop.from = { x: this.x.value, y: this.y.value };
      hop.duration = flightTime(hop.from, hop.target);
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
    this.worry.target = v > 1 ? 1 : 0;
    this.kick();
  }

  /** Lets its breath out: puffs of air and a little sag. Compact in the meter. */
  exhale() {
    if (this.reduced || !this.els) return;
    this.squash.velocity -= 1.1;
    STAR.puffs.forEach(([x, y], i) => {
      const el = document.createElementNS(SVGNS, 'circle');
      el.setAttribute('fill', '#ededed');
      el.setAttribute('r', '0');
      this.els!.fx.append(el);
      this.puffs.push({ el, x, y, vx: (i - 1) * 5, born: this.clock + i * 0.07 });
    });
    this.kick();
  }

  /** Shows the padlock in Read-only mode: it clicks shut with a little wiggle. */
  setLatched(on: boolean) {
    if ((this.latch.target === 1) === on) return;
    if (this.reduced) {
      this.latch.snap(on ? 1 : 0);
    } else {
      this.latch.target = on ? 1 : 0;
      if (on) {
        this.squash.velocity -= 0.45;
        this.wiggle.velocity += 300;
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
    this.lids.target = drowsy ? 0.32 : 1;
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
      this.lids.target = this.drowsy ? 0.32 : 1;
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
      this.lids.target = this.drowsy ? 0.32 : 1;
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
    const reading = this.readingTimer !== undefined;
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

    // Eyes lead; the body turns after them. Keep the lean targets of the last
    // moment and steer by the one from TURN_DELAY ago.
    const line = this.leanLine;
    line.push({ t: this.clock, v: lean });
    while (line.length > 2 && line[1].t <= this.clock - TURN_DELAY) line.shift();
    // Travel is not delayed: it leans into a hop the moment it moves.
    this.tilt.target = line[0].v + clamp(this.x.velocity / 1500, -1, 1) * 9;
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

    const vx = this.x.velocity;
    const vy = this.lift.velocity + this.y.velocity;
    const stretch = this.reduced ? 0 : clamp(Math.abs(vy) / 2800, 0, 0.05);
    const s = this.squash.value;
    const tall = this.tall.value;
    const sy = (1 + stretch + s + this.strain.value * 0.012 + tall * 0.08) * this.press.value;
    const sx = (1 - stretch * 0.6 - s * 0.75 + this.strain.value * 0.02 - tall * 0.04) * this.press.value;
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

    const latch = clamp(this.latch.value, 0, 1.4);
    els.badge.style.transform = `scale(${latch.toFixed(3)}) rotate(${this.wiggle.value.toFixed(2)}deg)`;
    els.badge.style.opacity = clamp(this.latch.value, 0, 1).toFixed(3);

    const st: StarState = {
      t: this.clock, dt, ex: this.eyeX.value, ey: this.eyeY.value, open: this.lids.value, widen: this.widen.value,
      joy: this.joy.value, wince: this.wince.value, worry: this.worry.value, strain: this.strain.value,
      think: this.readingTimer !== undefined, hover: this.hover, reach: this.reach, rattle: rattling,
      vx, reduced: this.reduced,
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
