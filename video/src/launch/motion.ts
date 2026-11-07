import { Easing } from "remotion";

export const FPS = 60;
export const WIDTH = 1920;
export const HEIGHT = 1080;

/**
 * Every beat is authored against the reference cut's clock and stretched by
 * this factor, so the whole piece breathes a little slower than the original.
 */
export const SLOW = 1.25;

/** Reference seconds → frames in this composition (fractional on purpose). */
export const at = (refSeconds: number) => refSeconds * SLOW * FPS;

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Apple-flavoured curves: quick departure, long soft landing. */
export const EASE = {
  /** UIKit "smooth": most of the travel early, a long settle. */
  out: Easing.bezier(0.16, 1, 0.3, 1),
  /** LiteDB's own UI curve (sidebar, toasts). */
  ui: Easing.bezier(0.22, 1, 0.36, 1),
  /** Keynote-style camera move: gentle start, long glide in. */
  camera: Easing.bezier(0.45, 0, 0.12, 1),
  /** Symmetric move for pans that start and stop on screen. */
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  /** iOS sheet presentation curve. */
  sheet: Easing.bezier(0.32, 0.72, 0, 1),
  in: Easing.bezier(0.55, 0, 0.8, 0.2),
  linear: (t: number) => t,
};

/** 0→1 progress between two reference times. */
export const tween = (
  frame: number,
  r0: number,
  r1: number,
  ease: (t: number) => number = EASE.inOut,
) => {
  const a = at(r0);
  const b = at(r1);
  if (frame <= a) return 0;
  if (frame >= b) return 1;
  return ease((frame - a) / (b - a));
};

/** Fade/blur window: rises over [r0, r1], falls over [r2, r3]. */
export const window4 = (
  frame: number,
  r0: number,
  r1: number,
  r2: number,
  r3: number,
  easeIn: (t: number) => number = EASE.out,
  easeOut: (t: number) => number = EASE.inOut,
) => tween(frame, r0, r1, easeIn) * (1 - tween(frame, r2, r3, easeOut));

/**
 * SwiftUI-style spring step response, 0 → 1 (may overshoot when damping < 1).
 * `response` is the undamped period in reference seconds.
 */
export const spring = (frame: number, r0: number, response = 0.5, damping = 1) => {
  const t = (frame - at(r0)) / FPS;
  if (t <= 0) return 0;
  const w = (2 * Math.PI) / (response * SLOW);
  if (damping >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
  const wd = w * Math.sqrt(1 - damping * damping);
  return (
    1 -
    Math.exp(-damping * w * t) *
      (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t))
  );
};

export type Key = [refTime: number, value: number, ease?: (t: number) => number];

/** Piecewise keyframes on the reference clock. */
export const keys = (frame: number, ks: Key[], fallback = EASE.inOut) => {
  if (frame <= at(ks[0][0])) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    const [t1, v1, e] = ks[i];
    if (frame <= at(t1)) {
      const [t0, v0] = ks[i - 1];
      const p = (frame - at(t0)) / (at(t1) - at(t0));
      return lerp(v0, v1, (e ?? fallback)(clamp01(p)));
    }
  }
  return ks[ks.length - 1][1];
};

/** Zoom keyframes interpolate in log space so zooms feel even. */
export const zoomKeys = (frame: number, ks: Key[], fallback = EASE.camera) =>
  Math.exp(keys(frame, ks.map(([t, v, e]) => [t, Math.log(v), e] as Key), fallback));

/** Deterministic hash noise in [0, 1). */
export const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Human typing: characters arrive on an uneven cadence between r0 and r1.
 * Returns how many characters of `text` are visible.
 */
export const typedCount = (frame: number, text: string, r0: number, r1: number) => {
  const a = at(r0);
  const b = at(r1);
  if (frame <= a) return 0;
  if (frame >= b) return text.length;
  // cumulative weights: spaces and punctuation take a touch longer
  const weights = [...text].map((ch, i) => (ch === " " ? 1.5 : /[,.;'(]/.test(ch) ? 1.8 : 1) * (0.7 + hash(i) * 0.6));
  const total = weights.reduce((s, w) => s + w, 0);
  const target = ((frame - a) / (b - a)) * total;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (acc > target) return i;
  }
  return text.length;
};

/** Caret visibility: solid while typing, blinks (~1.06s) when idle. */
export const caretOn = (frame: number, lastTypeFrame: number) => {
  const idle = frame - lastTypeFrame;
  if (idle < 18) return true;
  return Math.floor((idle - 18) / 32) % 2 === 1;
};

export type Pt = { x: number; y: number };
export const mix = (a: Pt, b: Pt, t: number): Pt => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });

/** Quadratic bezier point. */
export const bez2 = (p0: Pt, p1: Pt, p2: Pt, t: number): Pt => ({
  x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
  y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
});
