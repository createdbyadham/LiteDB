// Camera, cursor and screen-switch motion copied from the second reference
// (the Claude Design launch film). Every curve here was measured from that
// video frame by frame (24 fps, phase correlation between frames) and is used
// as a lookup table, so the film moves the way the reference moves.
import { Easing } from "remotion";
import { Cam } from "./kit";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Progress 0..1 at u in 0..1 along a measured curve sampled at equal steps. */
const lut = (table: number[], u: number) => {
  const x = clamp01(u) * (table.length - 1);
  const i = Math.floor(x);
  if (i >= table.length - 1) return table[table.length - 1];
  return table[i] + (table[i + 1] - table[i]) * (x - i);
};
/** Cumulative, normalised curve from per-frame steps. */
const fromSteps = (steps: number[]) => {
  const out = [0];
  steps.forEach((s) => out.push(out[out.length - 1] + s));
  const total = out[out.length - 1];
  return out.map((v) => v / total);
};

/**
 * Zoom out from a screen to the wall of screens: log-scale steps per frame,
 * 46.0 s to 46.6 s of the reference. Peaks on the third frame, then decays.
 */
const ZOOM_OUT = fromSteps([0.054, 0.143, 0.252, 0.212, 0.163, 0.134, 0.103, 0.083, 0.074, 0.064, 0.054, 0.035, 0.035, 0.024, 0.015]);
/** Pan across the wall: horizontal px per frame, 46.66 s to 47.6 s. Builds for 0.3 s, glides for 0.65 s. */
const PAN = fromSteps([4, 6, 9, 13, 18, 24, 31, 35, 33, 28, 24, 19, 16, 13, 11, 9, 8, 7, 6, 5, 4, 3, 2]);
/** Zoom from the wall into a screen: log-scale steps, 29.45 s to 30.1 s. Symmetric in and out. */
const ZOOM_IN = fromSteps([0.018, 0.032, 0.032, 0.047, 0.061, 0.089, 0.103, 0.089, 0.061, 0.047, 0.032, 0.018, 0.018, 0.018, 0.018]);
export const WALL = {
  /** Scale of the wall when fully out: 0.234 of a screen. */
  out: 0.234,
  zoomOut: 0.625,
  pan: 0.958,
  zoomIn: 0.625,
  /** The pan starts as the zoom out lands; the zoom in starts just before the pan stops. */
  panAt: 0.6,
  inAt: 1.5,
  total: 2.125,
};
export const zoomOutK = (u: number) => lut(ZOOM_OUT, u);
export const panK = (u: number) => lut(PAN, u);
export const zoomInK = (u: number) => lut(ZOOM_IN, u);

/**
 * Punch-in cut: the close-up is 2.48x the shot before it, about the thing the
 * cursor is heading for. Shots otherwise hold still: no drift and no lean-in,
 * which read as constant zooming on every clip.
 */
export const PUNCH = 2.48;

/**
 * The move-down: the next screen slides up from below, in front of the last
 * one, and settles; the last one dips a few pixels just before (65.7 s and
 * 66.8 s of the reference). It starts 27% of the frame height down and covers
 * half of that on its first frame: upward px per frame, measured and averaged.
 */
// The reference's move-down start (27% of the frame below), but it never comes
// to rest: a quick ease covers most of the way, then the screen keeps drifting
// up at a steady pace and reaches its place exactly as the clip cuts away.
export const SLIDE = { from: 0.27, fast: 0.6, share: 0.88, dip: 12, dipDur: 1 / 24 };
/** Progress at t seconds into a slide that lasts len seconds. */
export const slideK = (t: number, len: number) => {
  const x = Math.min(1, Math.max(0, t / SLIDE.fast));
  return SLIDE.share * (1 - Math.pow(1 - x, 4)) + (1 - SLIDE.share) * Math.min(1, Math.max(0, t / len));
};

/** Zoom a camera by k about a point that stays put on screen. */
export const zoomAbout = (cam: Cam, f: { x: number; y: number }, k: number): Cam => ({
  x: f.x + (cam.x - f.x) / k,
  y: f.y + (cam.y - f.y) / k,
  s: cam.s * k,
});

/** The close-up a punch-in cuts to: the shot before it, zoomed 2.48x about the target, which stays put on screen. */
export const punchIn = (before: Cam, target: { x: number; y: number }, k = PUNCH) => zoomAbout(before, target, k);

/**
 * The cursor's glide: quick off the mark, then a long deceleration onto the
 * target (the reference's arrival slows by about 0.7x each frame).
 */
export const glideEase = Easing.bezier(0.3, 0, 0.1, 1);
export type Pt = { x: number; y: number };
export const glide = (t: number, t0: number, dur: number, a: Pt, b: Pt): Pt => {
  const k = glideEase(clamp01((t - t0) / dur));
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
};
/** After it lands on something it clicks: it rests 8 frames (0.33 s), clicks, and waits 0.3 s before moving on. */
export const CLICK = { dwell: 0.33, after: 0.3 };
