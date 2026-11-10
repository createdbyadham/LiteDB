// The launch film's kit: palette, clock, type and the pixel motifs.
// Timing is authored in seconds on the reference cut's own clock (SLOW = 1),
// so a beat here lands on the same frame as the beat it copies.
import React from "react";
import { Easing, useCurrentFrame } from "remotion";
import { mono, sans } from "../launch/tokens";
import { ASTERISK } from "../launch/art";

export { mono, sans };

export const FPS = 60;
export const W = 1920;
export const H = 1080;
export const sec = (s: number) => Math.round(s * FPS);

/** Reference brown/cream/lavender, swapped for LiteDB graphite/light/blue. */
export const P = {
  ink: "#050506", // opener and finale
  card: "#1f1f22", // title cards
  paper: "#0b0b0c", // the stage the app sits on (ref cream)
  stage: "#161618", // the second stage (ref olive)
  white: "#18181b", // surfaces (the app's dialog colour)
  fg: "#ededed", // headline line 1
  muted: "#a0a0a6", // headline line 2
  text: "#ededed",
  textSoft: "#a0a0a6",
  textFaint: "#6b6b72",
  line: "#2a2a2c",
  soft: "#232325",
  key: "#4f8cff", // caret and accent (electric blue)
  keyDeep: "#4f8cff",
  keyTint: "rgba(79,140,255,0.16)",
  red: "#e5484d",
  redTint: "rgba(229,72,77,0.18)",
  green: "#4cc38a",
  greenTint: "rgba(76,195,138,0.16)",
};

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const E = {
  out: Easing.bezier(0.16, 1, 0.3, 1),
  inOut: Easing.bezier(0.65, 0, 0.35, 1),
  in: Easing.bezier(0.55, 0, 0.8, 0.2),
  snap: Easing.bezier(0.2, 0.9, 0.1, 1),
};

/** Local seconds inside the current Sequence. */
export const useT = () => useCurrentFrame() / FPS;

/** 0→1 between a and b (seconds). */
export const p = (t: number, a: number, b: number, ease: (x: number) => number = E.out) =>
  ease(clamp01((t - a) / (b - a)));

/** Damped spring, 0→1, with a little overshoot like the reference's UI pops. */
export const spr = (t: number, start: number, period = 0.45, damping = 0.72) => {
  const x = t - start;
  if (x <= 0) return 0;
  const w = (2 * Math.PI) / period;
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * x) * (Math.cos(wd * x) + ((damping * w) / wd) * Math.sin(wd * x));
};

export const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Smooth 2D value noise in [0, 1). */
export const noise2 = (x: number, y: number) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const h = (i: number, j: number) => hash(i * 57.13 + j * 113.7);
  const s = (v: number) => v * v * (3 - 2 * v);
  const a = lerp(h(xi, yi), h(xi + 1, yi), s(xf));
  const b = lerp(h(xi, yi + 1), h(xi + 1, yi + 1), s(xf));
  return lerp(a, b, s(yf));
};

/** Typewriter: characters of `text` shown at `cps` from `start`. */
export const typed = (text: string, t: number, start: number, cps: number) =>
  text.slice(0, Math.max(0, Math.min(text.length, Math.floor((t - start) * cps))));

export const typedEnd = (text: string, start: number, cps: number) => start + text.length / cps;

/** The reference's caret: solid while typing, then a ~1 Hz blink. */
export const Caret: React.FC<{ t: number; idleFrom: number; h?: number; w?: number; color?: string; until?: number }> = ({
  t,
  idleFrom,
  h = 1.0,
  w = 0.075,
  color = P.key,
  until = Infinity,
}) => {
  const idle = t - idleFrom;
  const on = t < until && (idle < 0.08 || Math.floor((idle - 0.08) / 0.5) % 2 === 1);
  return (
    <span
      style={{
        display: "inline-block",
        width: `${w}em`,
        height: `${h}em`,
        background: color,
        marginLeft: "0.06em",
        verticalAlign: "-0.14em",
        opacity: on ? 1 : 0,
      }}
    />
  );
};

export const headline: React.CSSProperties = {
  fontFamily: sans,
  fontWeight: 500,
  letterSpacing: "-0.045em",
  lineHeight: 1.0,
  whiteSpace: "pre",
};

/** The reference's stair-stepped pixel arrow, black with a white rim. */
const ARROW = [
  "B",
  "BB",
  "BWB",
  "BWWB",
  "BWWWB",
  "BWWWWB",
  "BWWWWWB",
  "BWWWWWWB",
  "BWWWWWWWB",
  "BWWWWWWWWB",
  "BWWWWWBBBBB",
  "BWWBWWB",
  "BWB.BWWB",
  "BB..BWWB",
  "B....BWWB",
  ".....BWWB",
  "......BB",
];
export const PixelCursor: React.FC<{ x: number; y: number; size?: number; press?: number }> = ({ x, y, size = 4, press = 0 }) => {
  const rects: React.ReactNode[] = [];
  ARROW.forEach((row, r) =>
    [...row].forEach((c, col) => {
      if (c === "B") rects.push(<rect key={`${r}-${col}`} x={col} y={r} width={1.02} height={1.02} fill="#0b0b0c" />);
      if (c === "W") rects.push(<rect key={`${r}-${col}`} x={col} y={r} width={1.02} height={1.02} fill="#ffffff" />);
    }),
  );
  const s = 1 - press * 0.14;
  return (
    <svg
      width={12 * size}
      height={17 * size}
      viewBox="0 0 12 17"
      shapeRendering="crispEdges"
      style={{ position: "absolute", left: x, top: y, transform: `scale(${s})`, transformOrigin: "0 0", overflow: "visible", filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.18))" }}
    >
      {rects}
    </svg>
  );
};

/** Click squash: 1 at the click, back to 0 over 0.18s. */
export const pressAt = (t: number, at: number) => {
  const d = t - at;
  if (d < -0.06 || d > 0.2) return 0;
  return d < 0 ? (d + 0.06) / 0.06 : 1 - d / 0.2;
};

/** Pixel noise in the background, slowly flickering, like the reference's dark cards. */
export const DotField: React.FC<{ t: number; color: string; opacity?: number; cell?: number; density?: number; seed?: number; fadeIn?: [number, number] }> = ({
  t,
  color,
  opacity = 0.09,
  cell = 12,
  density = 0.62,
  seed = 1,
  fadeIn = [0, 0.01],
}) => {
  const cols = Math.ceil(W / cell);
  const rows = Math.ceil(H / cell);
  const flick = Math.floor(t * 8);
  const rects: React.ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const n = noise2(c / 9 + seed * 10, r / 9 + seed * 3);
      if (n < density) continue;
      const h = hash(r * 977 + c * 131 + seed);
      if (h < 0.35) continue;
      const tw = hash(r * 31 + c * 17 + flick * 7.3) < 0.08 ? 0.35 : 1;
      rects.push(<rect key={r * cols + c} x={c * cell} y={r * cell} width={cell * 0.5} height={cell * 0.5} fill={color} opacity={tw * (0.4 + h * 0.6)} />);
    }
  }
  return (
    <svg width={W} height={H} style={{ position: "absolute", inset: 0, opacity: opacity * p(t, fadeIn[0], fadeIn[1], E.inOut) }} shapeRendering="crispEdges">
      {rects}
    </svg>
  );
};

/** A pill with stair-stepped corners and a tail, as in the reference's agent tags. */
export const PixelPill: React.FC<{ label?: string; bg: string; fg?: string; w: number; h: number; tail?: boolean; fontSize?: number; font?: string }> = ({
  label,
  bg,
  fg = "#16161a",
  w,
  h,
  tail = true,
  fontSize,
  font = sans,
}) => {
  const s = Math.max(3, Math.round(h / 9));
  const clip = `polygon(${2 * s}px 0, calc(100% - ${2 * s}px) 0, calc(100% - ${2 * s}px) ${s}px, calc(100% - ${s}px) ${s}px, calc(100% - ${s}px) ${2 * s}px, 100% ${2 * s}px, 100% calc(100% - ${2 * s}px), calc(100% - ${s}px) calc(100% - ${2 * s}px), calc(100% - ${s}px) calc(100% - ${s}px), calc(100% - ${2 * s}px) calc(100% - ${s}px), calc(100% - ${2 * s}px) 100%, ${2 * s}px 100%, ${2 * s}px calc(100% - ${s}px), ${s}px calc(100% - ${s}px), ${s}px calc(100% - ${2 * s}px), 0 calc(100% - ${2 * s}px), 0 ${2 * s}px, ${s}px ${2 * s}px, ${s}px ${s}px, ${2 * s}px ${s}px)`;
  return (
    <div style={{ position: "relative", width: w, height: h }}>
      <div
        style={{
          width: w,
          height: h,
          background: bg,
          clipPath: clip,
          display: "grid",
          placeItems: "center",
          fontFamily: font,
          fontWeight: 500,
          fontSize: fontSize ?? h * 0.46,
          letterSpacing: "-0.02em",
          color: fg,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
      {tail ? (
        <svg width={h * 0.7} height={h * 0.7} viewBox="0 0 7 7" shapeRendering="crispEdges" style={{ position: "absolute", right: -h * 0.42, bottom: -h * 0.52 }}>
          <path d="M5 0h2v7h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h-1v-1h3z" fill={bg} />
        </svg>
      ) : null}
    </div>
  );
};

/** A database drawn as a dot-matrix icon (the reference's pixel tiles). */
export const PixelDb: React.FC<{ size: number; color: string; tone: string; variant?: number }> = ({ size, color, tone, variant = 0 }) => {
  const n = 13;
  const cells: React.ReactNode[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const x = (c - 6) / 5;
      const top = Math.abs(((r - 2.4) / 1.5) ** 2 + x * x - 1) < 0.42;
      const side = (c === 1 || c === 11) && r > 2 && r < 11;
      const band = r > 2 && Math.abs(((r - 2.4 - (variant % 2 ? 0 : 4)) / 1.5) ** 2 + x * x - 1) < 0.35 && r >= 6 && r <= 11 && c > 1 && c < 11;
      const bottom = r === 11 && c > 2 && c < 10;
      const on = top || side || band || bottom;
      cells.push(
        <rect key={r * n + c} x={c + 0.12} y={r + 0.12} width={0.76} height={0.76} rx={0.18} fill={on ? color : tone} opacity={on ? 1 : 0.55} />,
      );
    }
  }
  return (
    <svg width={size} height={size} viewBox="0 0 13 13">
      {cells}
    </svg>
  );
};

/** The LiteDB mark alone (no squircle), for the logo reveal. */
export const Mark: React.FC<{ size: number; color?: string }> = ({ size, color = P.text }) => (
  <svg width={size} height={size} viewBox="0 0 256 256" style={{ display: "block" }}>
    <polygon points={ASTERISK} fill={color} />
  </svg>
);

/** Dotted letters, the reference's "Chaos becomes context" treatment. */
export const dotted = (color: string, cell: number): React.CSSProperties => ({
  color: "transparent",
  backgroundImage: `radial-gradient(circle at 50% 50%, ${color} 0 34%, transparent 38%)`,
  backgroundSize: `${cell}px ${cell}px`,
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
});

/** A light-theme app window, LiteDB's own light tokens. */
export const LightWindow: React.FC<{ w: number; h: number; title?: string; children?: React.ReactNode; style?: React.CSSProperties; glow?: number }> = ({
  w,
  h,
  title = "shop · LiteDB",
  children,
  style,
  glow = 0,
}) => (
  <div
    style={{
      position: "absolute",
      width: w,
      height: h,
      background: P.white,
      borderRadius: 18,
      border: `1.5px solid ${P.line}`,
      boxShadow: `0 30px 80px rgba(24,24,27,0.10), 0 0 ${120 * glow}px ${40 * glow}px rgba(255,255,255,${0.9 * glow})`,
      overflow: "hidden",
      fontFamily: sans,
      color: P.text,
      ...style,
    }}
  >
    <div style={{ height: 46, display: "flex", alignItems: "center", gap: 9, padding: "0 18px", borderBottom: `1.5px solid ${P.line}`, background: "#fafafa" }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 13, height: 13, borderRadius: 7, background: "#dcdce0" }} />
      ))}
      <span style={{ marginLeft: 14, fontSize: 17, color: P.textSoft }}>{title}</span>
    </div>
    {children}
  </div>
);

/** A camera on the 1280x800 app: focus point (app px) and zoom. */
export type Cam = { x: number; y: number; s: number };
export const FULL: Cam = { x: 640, y: 400, s: 1.25 };
export const camKeys = (t: number, ks: [number, Cam][], ease: (x: number) => number = E.inOut): Cam => {
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    const [t1, c1] = ks[i];
    if (t <= t1) {
      const [t0, c0] = ks[i - 1];
      const k = ease(clamp01((t - t0) / (t1 - t0)));
      const s = Math.exp(lerp(Math.log(c0.s), Math.log(c1.s), k));
      return { x: lerp(c0.x, c1.x, k), y: lerp(c0.y, c1.y, k), s };
    }
  }
  return ks[ks.length - 1][1];
};
/** App px to screen px under a camera centred at (cx, cy) on screen. */
export const toScreen = (cam: Cam, x: number, y: number, cx = W / 2, cy = H / 2) => ({ x: cx + (x - cam.x) * cam.s, y: cy + (y - cam.y) * cam.s });
export const Stage: React.FC<{ cam: Cam; cx?: number; cy?: number; children: React.ReactNode }> = ({ cam, cx = W / 2, cy = H / 2, children }) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      top: 0,
      transformOrigin: "0 0",
      transform: `translate(${cx - cam.x * cam.s}px, ${cy - cam.y * cam.s}px) scale(${cam.s})`,
      borderRadius: 12,
      boxShadow: "0 0 0 1px rgba(255,255,255,0.07), 0 40px 120px rgba(0,0,0,0.7)",
    }}
  >
    {children}
  </div>
);

/**
 * Holds: [authored time, seconds] pairs. warp() turns real scene time into
 * authored time that stands still during each hold, so there is time to read.
 */
export type Holds = [number, number][];
export const warp = (rt: number, holds: Holds) => {
  let acc = 0;
  for (const [at, d] of holds) {
    const start = at + acc;
    if (rt <= start) break;
    if (rt < start + d) return at;
    acc += d;
  }
  return rt - acc;
};
/** Real scene time at which an authored moment happens (after any hold that starts before it). */
export const unwarp = (a: number, holds: Holds) => a + holds.filter(([at]) => at < a).reduce((s, [, d]) => s + d, 0);
export const holdTotal = (holds: Holds) => holds.reduce((s, [, d]) => s + d, 0);

// Star's gestures, after src/components/Mascot/motion.ts (nodYes, shakeNo, blinks).
export const starBlink = (rt: number) => {
  const c = (rt + 1.1) % 3.6;
  return c > 3.42 ? 1 - Math.abs(c - 3.51) / 0.09 : 0;
};
export const starNod = (rt: number, at: number) => {
  const d = rt - at;
  if (d < 0 || d > 1.1) return 0;
  return 7 * Math.max(0, Math.sin((d * Math.PI * 2) / 0.24)) * Math.exp(-d * 3.2);
};
export const starShake = (rt: number, at: number) => {
  const d = rt - at;
  if (d < 0 || d > 1.3) return 0;
  return 16 * Math.sin((d * Math.PI * 2) / 0.32) * Math.exp(-d * 3);
};
/** A hop between two perches: up and over, body fully out while in the air. */
export const starHop = (rt: number, a: number, b: number, from: { x: number; y: number }, to: { x: number; y: number }) => {
  const k = p(rt, a, b, E.inOut);
  const air = k > 0 && k < 1;
  return { x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k) - Math.sin(k * Math.PI) * 140, peek: air ? 64 : 44, spin: air ? k * 60 : 0, k };
};
