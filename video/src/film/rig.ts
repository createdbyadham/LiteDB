// Star's motion for the film, replayed frame by frame from the app's own rig:
// src/lib/spring.ts and src/components/Mascot/motion.ts, with the same springs,
// constants, hop arc, edge clipping and landing. A scene scripts what happens
// to Star (perch, hop, nod, mood, where it looks) in scene seconds; the whole
// scene is simulated once at the film's frame rate and each frame reads its state.

const FPS = 60;
export const STAR_W = 64;
export const STAR_H = 64;
export const PEEK = 44;
const EYE = { x: 32, y: 31 };

export type Pt = { x: number; y: number };

/** Top-left of Star's body on a perch, as Star.tsx measures it. */
export const perchHome = (centerX: number, top: number): Pt => ({ x: Math.round(centerX - STAR_W / 2), y: top - PEEK });
export const perchDialog = (right: number, top: number): Pt => ({ x: Math.round(right - 72 - STAR_W), y: top - PEEK });

class Spring {
  value: number;
  target: number;
  velocity = 0;
  precision: number;
  private stiffness = 0;
  private friction = 0;
  constructor(value: number, o: { response: number; damping: number; precision?: number }) {
    this.value = value;
    this.target = value;
    this.precision = o.precision ?? 0.01;
    this.configure(o);
  }
  configure({ response, damping }: { response: number; damping: number }) {
    const omega = (2 * Math.PI) / response;
    this.stiffness = omega * omega;
    this.friction = 2 * damping * omega;
  }
  step(dt: number) {
    let remaining = dt;
    while (remaining > 1e-6) {
      const h = Math.min(remaining, 1 / 240);
      const a = -this.stiffness * (this.value - this.target) - this.friction * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    if (Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 12) {
      this.value = this.target;
      this.velocity = 0;
    }
  }
  snap(v: number) {
    this.value = v;
    this.target = v;
    this.velocity = 0;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const READING: [number, number][] = [
  [-2.6, -1.4], [-0.9, -1.4], [0.8, -1.4], [2.5, -1.4],
  [-2.6, 0.8], [-0.9, 0.8], [0.8, 0.8], [2.5, 0.8],
];
const EYE_TRACKING = { response: 0.2, damping: 0.74 };
const EYE_READING = { response: 0.1, damping: 0.86 };
const TURN_DELAY = 0.12;
const GRAVITY = 4200;

function arcControl(from: Pt, to: Pt): Pt {
  const top = Math.min(from.y, to.y);
  const rise = clamp(36 + Math.hypot(to.x - from.x, to.y - from.y) * 0.05, 40, 80);
  const apex = Math.min(Math.max(top - rise, 2), top - 12);
  const h0 = from.y - apex;
  const h2 = to.y - apex;
  return { x: (from.x + to.x) / 2, y: from.y - (h0 + Math.sqrt(h0 * h2)) };
}
function flightTime(from: Pt, to: Pt) {
  const c = arcControl(from, to);
  return clamp(Math.sqrt((2 * (from.y - 2 * c.y + to.y)) / GRAVITY), 0.36, 0.75);
}

export type StarEvent =
  | { at: number; place: Pt }
  | { at: number; jump: Pt }
  | { at: number; gesture: "nod" | "shake" }
  | { at: number; mood: "idle" | "happy" | "thinking"; forS?: number }
  /** Where it looks (app px), until the next look; null goes back to the pointer. */
  | { at: number; look: Pt | null };

export type StarFrame = {
  /** Body top-left, app px, with lift and nod. */
  x: number;
  y: number;
  /** Pixels of the body hidden below the edge it peeks over. */
  hidden: number;
  handsX: number;
  handsY: number;
  grip: number;
  angle: number;
  sx: number;
  sy: number;
  /** Eye offset in Star's own 64px units, as art.ts takes it. */
  ex: number;
  ey: number;
  joy: number;
  /** On its home perch and not travelling: drawn under dialogs' overlays (z-45), else above them (z-60). */
  home: boolean;
};

type Hop = { phase: "crouch" | "air"; from: Pt; target: Pt; t: number; duration: number; leaveEdge: number; arriveEdge: number; cleared: boolean; aboveArrival: boolean; airAt: number; started: number };

function simulate(events: StarEvent[], seconds: number, pointer?: (t: number) => Pt | null): StarFrame[] {
  const x = new Spring(0, { response: 0.6, damping: 0.8, precision: 0.05 });
  const y = new Spring(0, { response: 0.6, damping: 0.8, precision: 0.05 });
  const lift = new Spring(0, { response: 0.8, damping: 0.72, precision: 0.05 });
  const tilt = new Spring(0, { response: 0.5, damping: 0.66, precision: 0.01 });
  const squash = new Spring(0, { response: 0.3, damping: 0.5, precision: 0.0005 });
  const nod = new Spring(0, { response: 0.24, damping: 0.4, precision: 0.02 });
  const wag = new Spring(0, { response: 0.3, damping: 0.24, precision: 0.05 });
  const eyeX = new Spring(0, { ...EYE_TRACKING, precision: 0.005 });
  const eyeY = new Spring(0, { ...EYE_TRACKING, precision: 0.005 });
  const joy = new Spring(0, { response: 0.26, damping: 0.82, precision: 0.002 });
  const grip = new Spring(1, { response: 0.32, damping: 0.6, precision: 0.002 });
  const springs = [x, y, lift, tilt, squash, nod, wag, eyeX, eyeY, joy, grip];

  const queue = [...events].sort((a, b) => a.at - b.at);
  const timers: { at: number; fn: () => void }[] = [];
  let edge = Infinity;
  let hop: Hop | null = null;
  let gaze: Pt | null = null;
  let reading = false;
  let readStep = 0;
  let nextRead = 0;
  let homeEdge = Infinity;
  let homePerch = true;
  let happyFlip = 1;
  const leanLine: { t: number; v: number }[] = [];
  const out: StarFrame[] = [];

  const setMood = (now: number, mood: "idle" | "happy" | "thinking", forS?: number) => {
    joy.target = mood === "happy" ? 1 : 0;
    if (mood === "happy") {
      lift.velocity -= 300;
      tilt.velocity += happyFlip * 70;
      happyFlip = -happyFlip;
    }
    const wasReading = reading;
    reading = mood === "thinking";
    const eyes = reading ? EYE_READING : EYE_TRACKING;
    eyeX.configure(eyes);
    eyeY.configure(eyes);
    if (reading && !wasReading) {
      readStep = 0;
      nextRead = now;
    }
    if (forS) timers.push({ at: now + forS, fn: () => setMood(now + forS, "idle") });
  };

  const frames = Math.ceil(seconds * FPS) + 1;
  for (let f = 0; f < frames; f++) {
    const now = f / FPS;
    const dt = f === 0 ? 0 : 1 / FPS;

    while (queue.length && queue[0].at <= now + 1e-9) {
      const e = queue.shift()!;
      if ("place" in e) {
        x.snap(e.place.x);
        y.snap(e.place.y);
        edge = e.place.y + PEEK;
        homeEdge = edge;
        homePerch = true;
        hop = null;
      } else if ("jump" in e) {
        hop = { phase: "crouch", from: { x: x.value, y: y.value }, target: e.jump, t: 0, duration: 0.5, leaveEdge: edge, arriveEdge: e.jump.y + PEEK, cleared: false, aboveArrival: false, airAt: now + 0.12, started: now };
        homePerch = e.jump.y + PEEK === homeEdge;
        grip.target = 0;
        squash.velocity -= 0.9;
      } else if ("gesture" in e) {
        if (e.gesture === "nod") {
          nod.velocity += 140;
          squash.velocity -= 0.4;
          timers.push({
            at: now + 0.22,
            fn: () => {
              if (hop) return;
              nod.velocity += 110;
              squash.velocity -= 0.3;
            },
          });
        } else {
          wag.velocity += 170;
        }
      } else if ("mood" in e) {
        setMood(now, e.mood, e.forS);
      } else if ("look" in e) {
        gaze = e.look;
      }
    }
    for (let i = timers.length - 1; i >= 0; i--) {
      if (timers[i].at <= now + 1e-9) {
        const { fn } = timers[i];
        timers.splice(i, 1);
        fn();
      }
    }
    if (hop && hop.phase === "crouch" && now >= hop.airAt - 1e-9) {
      hop.phase = "air";
      hop.from = { x: x.value, y: y.value };
      hop.duration = flightTime(hop.from, hop.target);
      squash.velocity += 0.9;
    }
    if (reading && now >= nextRead - 1e-9) {
      const [ex, ey] = READING[readStep % READING.length];
      eyeX.target = ex;
      eyeY.target = ey;
      readStep++;
      nextRead += 0.19;
    }

    // aim: the eyes lead, the body turns a beat later
    const target = gaze ?? pointer?.(now) ?? null;
    let lean = 0;
    if (target) {
      const dx = target.x - (x.value + EYE.x);
      const dy = target.y - (y.value + lift.value + EYE.y);
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, d / 140);
      if (!reading) {
        eyeX.target = (dx / d) * 3.2 * reach;
        eyeY.target = (dy / d) * 2.6 * reach;
      }
      lean = clamp(dx / 700, -1, 1) * 4;
    } else if (!reading) {
      eyeX.target = 0;
      eyeY.target = 0;
    }
    leanLine.push({ t: now, v: lean });
    while (leanLine.length > 2 && leanLine[1].t <= now - TURN_DELAY) leanLine.shift();
    tilt.target = leanLine[0].v + clamp(x.velocity / 1500, -1, 1) * 9;

    const liftBefore = lift.value;
    for (const s of springs) s.step(dt);

    // fly along the arc
    if (hop && hop.phase === "air") {
      hop.t = Math.min(1, hop.t + dt / hop.duration);
      const { from, target: to } = hop;
      const c = arcControl(from, to);
      const t = hop.t;
      const u = 1 - t;
      x.value = x.target = u * u * from.x + 2 * u * t * c.x + t * t * to.x;
      y.value = y.target = u * u * from.y + 2 * u * t * c.y + t * t * to.y;
      x.velocity = (2 * u * (c.x - from.x) + 2 * t * (to.x - c.x)) / hop.duration;
      y.velocity = (2 * u * (c.y - from.y) + 2 * t * (to.y - c.y)) / hop.duration;
    }
    if (liftBefore < 0 && lift.value >= 0 && lift.velocity > 120) squash.velocity -= Math.min(1.4, lift.velocity * 0.0016);

    // the edge it is clipped at, and touchdown
    if (hop && hop.phase === "air") {
      const bottom = y.value + lift.value + STAR_H;
      if (!hop.cleared) {
        edge = hop.leaveEdge;
        if (bottom < hop.leaveEdge - 0.5 || now - hop.started > 0.7) {
          hop.cleared = true;
          edge = Infinity;
        }
      }
      if (hop.cleared) {
        if (bottom <= hop.arriveEdge + 0.5) hop.aboveArrival = true;
        if (hop.aboveArrival && lift.velocity + y.velocity > 0) edge = hop.arriveEdge;
      }
      if (hop.t >= 1) {
        const vx = x.velocity;
        const impact = clamp(y.velocity / 2400, 0, 1);
        x.value = x.target = hop.target.x;
        y.value = y.target = hop.target.y;
        x.velocity = vx * 0.05;
        y.velocity = 40 + 70 * impact;
        squash.velocity -= 0.25 + 0.45 * impact;
        edge = hop.arriveEdge;
        hop = null;
        grip.target = 1;
      }
    }

    const by = y.value + lift.value + nod.value;
    const vy = lift.velocity + y.velocity;
    const stretch = clamp(Math.abs(vy) / 2800, 0, 0.05);
    const s = squash.value;
    out.push({
      x: x.value,
      y: by,
      hidden: edge === Infinity ? 0 : clamp(by + STAR_H - edge, 0, STAR_H),
      handsX: x.value,
      handsY: edge === Infinity ? y.value : Math.min(y.value, edge - PEEK),
      grip: clamp(grip.value, 0, 1),
      angle: tilt.value + wag.value,
      sx: 1 - stretch * 0.6 - s * 0.75,
      sy: 1 + stretch + s,
      ex: eyeX.value,
      ey: eyeY.value,
      joy: clamp(joy.value, 0, 1),
      home: homePerch && !hop,
    });
  }
  return out;
}

const cache = new Map<string, StarFrame[]>();
/**
 * Star's state at scene time `rt`, simulated once per script. The cache is keyed
 * by the script itself, not just its name: Studio hot-reloads a scene without
 * reloading this module, and a name alone kept serving the old timing.
 */
export const starAt = (name: string, rt: number, seconds: number, events: StarEvent[], pointer?: (t: number) => Pt | null): StarFrame => {
  const key = `${name}|${seconds.toFixed(3)}|${JSON.stringify(events)}`;
  let frames = cache.get(key);
  if (!frames) {
    frames = simulate(events, seconds, pointer);
    cache.set(key, frames);
  }
  return frames[Math.max(0, Math.min(frames.length - 1, Math.round(rt * FPS)))];
};

/** The speech bubble's spring-in (460 ms, overshooting) and quick fade-out, from Star.tsx. */
export type Line = [text: string, from: number, until: number];
export const speech = (rt: number, lines: Line[]): { text: string; o: number; s: number; dy: number } | null => {
  const ease = (a: number, b: number, k: number) => {
    // cubic-bezier(0.34, 1.36, 0.64, 1), solved numerically
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      const bx = 3 * (1 - m) * (1 - m) * m * a + 3 * (1 - m) * m * m * 0.64 + m * m * m;
      if (bx < k) lo = m;
      else hi = m;
    }
    const m = (lo + hi) / 2;
    return 3 * (1 - m) * (1 - m) * m * b + 3 * (1 - m) * m * m * 1 + m * m * m;
  };
  for (const [text, from, until] of lines) {
    if (rt < from || rt > until + 0.18) continue;
    if (rt <= until) {
      const k = clamp((rt - from) / 0.46, 0, 1);
      const sp = ease(0.34, 1.36, k);
      return { text, o: clamp((rt - from) / 0.16, 0, 1), s: 0.9 + 0.1 * sp, dy: 6 * (1 - sp) };
    }
    const k = clamp((rt - until) / 0.16, 0, 1);
    return { text, o: 1 - clamp((rt - until) / 0.14, 0, 1), s: 1 - 0.1 * k * k, dy: 6 * k * k };
  }
  return null;
};
