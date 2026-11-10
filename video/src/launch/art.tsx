import React, { useId } from "react";
import { C, CURSOR_LABEL, sans } from "./tokens";

const useSvgId = (prefix: string) => prefix + useId().replace(/[^a-zA-Z0-9_-]/g, "");

/** Superellipse (n≈5): the continuous-corner icon shape. */
export const squircle = (w: number, h: number, n = 5, steps = 144) => {
  const pts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const y = Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    pts.push(`${((w / 2) * (1 + x)).toFixed(2)},${((h / 2) * (1 + y)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
};

/** LiteDB's asterisk, traced from public/mtfr.png (256×256 space). */
export const ASTERISK =
  "100,22 153,22 153,96 218,77 233,120 167,143 210,203 171,232 127,175 84,232 43,204 86,143 21,120 35,77 100,96";

const SQ256 = squircle(256, 256);
const SQ100 = squircle(100, 100);

/** The app icon: white squircle, black asterisk (src-tauri/icons/icon.png). */
export const AppIcon: React.FC<{ size: number; dim?: number; style?: React.CSSProperties }> = ({
  size,
  dim = 0,
  style,
}) => {
  const id = useSvgId("ai");
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" style={{ display: "block", overflow: "visible", ...style }}>
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#e9e9ed" />
        </linearGradient>
      </defs>
      <path d={SQ256} fill={`url(#${id}g)`} />
      <path d={SQ256} fill="none" stroke="rgba(0,0,0,0.12)" strokeWidth={1.4} />
      <g transform="translate(128 129) scale(0.55) translate(-127 -127)">
        <polygon points={ASTERISK} fill="#0d0d0e" />
      </g>
      {dim > 0 ? <path d={SQ256} fill={`rgba(0,0,0,${dim})`} /> : null}
    </svg>
  );
};

/** The icon squeezed into a glossy sphere while it flies to the dock. */
export const AppBall: React.FC<{ size: number }> = ({ size }) => {
  const id = useSvgId("ball");
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", overflow: "visible" }}>
      <defs>
        <radialGradient id={`${id}r`} cx="38%" cy="30%" r="78%">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.5" stopColor="#f2f2f5" />
          <stop offset="1" stopColor="#b9b9c0" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="49" fill={`url(#${id}r)`} />
      <g transform="translate(50 52) scale(0.21) translate(-127 -127)">
        <polygon points={ASTERISK} fill="#111113" />
      </g>
      <ellipse cx="37" cy="24" rx="17" ry="8.5" fill="rgba(255,255,255,0.8)" />
    </svg>
  );
};

/** macOS-style arrow pointer (tip at the top-left of the box). */
export const MacArrow: React.FC<{ height: number }> = ({ height }) => (
  <svg width={(height * 24) / 32} height={height} viewBox="0 0 24 32" style={{ display: "block", overflow: "visible" }}>
    <path
      d="M2.2 2 L2.2 25.6 L7.9 20.2 L11.9 29.3 L15.9 27.5 L12 18.6 L19.9 18.6 Z"
      fill="#050505"
      stroke="#ffffff"
      strokeWidth={1.9}
      strokeLinejoin="round"
      style={{ filter: "drop-shadow(0 1.2px 1.6px rgba(0,0,0,0.35))" }}
    />
  </svg>
);

/** Closed hand (dragging). */
export const MacHand: React.FC<{ height: number }> = ({ height }) => (
  <svg width={height} height={height} viewBox="0 0 32 32" style={{ display: "block", overflow: "visible" }}>
    <g style={{ filter: "drop-shadow(0 1.2px 1.6px rgba(0,0,0,0.35))" }}>
      <path
        d="M8.5 15.5 C7.2 15.1 6.2 16.3 6.8 17.6 L8.6 21.4 C9.8 24.6 12.2 27 15.8 27 L17.6 27 C21.4 27 24.2 24.2 24.2 20.2 L24.2 12.4 C24.2 11 23 10.2 21.9 10.6 C21.6 9.4 20.3 8.8 19.2 9.3 C18.8 8.1 17.4 7.6 16.3 8.2 C15.8 7.2 14.4 6.9 13.4 7.6 C12.6 8.1 12.4 9 12.4 9.8 L12.4 14.6 C11.4 13.8 9.8 14.2 9.3 15.4 Z"
        fill="#ffffff"
        stroke="#050505"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <path d="M16.3 8.6 V13.4 M19.2 9.6 V13.8 M21.9 10.9 V14.2" stroke="#050505" strokeWidth={1.3} strokeLinecap="round" />
    </g>
  </svg>
);

/** Green "+" copy badge shown while dropping onto a folder. */
export const CopyBadge: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" style={{ display: "block" }}>
    <circle cx="10" cy="10" r="9" fill="#2fbf4f" stroke="#ffffff" strokeWidth="1.8" />
    <path d="M10 5.6 V14.4 M5.6 10 H14.4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

const Sq: React.FC<{ size: number; children: React.ReactNode; defs?: React.ReactNode; fill: string }> = ({
  size,
  children,
  defs,
  fill,
}) => (
  <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", overflow: "visible" }}>
    <defs>{defs}</defs>
    <path d={SQ100} fill={fill} />
    {children}
    <path d={SQ100} fill="none" stroke="rgba(0,0,0,0.10)" strokeWidth={0.6} />
  </svg>
);

/** Dock icons: original, generic glyphs in macOS proportions. */
export const DockIcon: React.FC<{ kind: string; size: number }> = ({ kind, size }) => {
  const id = useSvgId("dk");
  const grad = (a: string, b: string) => (
    <linearGradient id={`${id}g`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={a} />
      <stop offset="1" stopColor={b} />
    </linearGradient>
  );
  const g = `url(#${id}g)`;
  switch (kind) {
    case "files":
      return (
        <Sq size={size} fill={g} defs={grad("#62b8ff", "#1c6fe6")}>
          <path d="M22 34 a4 4 0 0 1 4 -4 h15 l6 6 h27 a4 4 0 0 1 4 4 v28 a4 4 0 0 1 -4 4 h-48 a4 4 0 0 1 -4 -4 z" fill="#ffffff" opacity={0.95} />
          <path d="M22 44 h56 v24 a4 4 0 0 1 -4 4 h-48 a4 4 0 0 1 -4 -4 z" fill="#d9ecff" />
        </Sq>
      );
    case "browser":
      return (
        <Sq size={size} fill={g} defs={grad("#ffffff", "#e6ebf2")}>
          <g fill="none" stroke="#1f73ea" strokeWidth={4.2}>
            <circle cx="50" cy="50" r="27" />
            <ellipse cx="50" cy="50" rx="11.5" ry="27" />
            <path d="M23 50 H77 M27 37 H73 M27 63 H73" strokeWidth={3.4} />
          </g>
        </Sq>
      );
    case "messages":
      return (
        <Sq size={size} fill={g} defs={grad("#72f392", "#22c149")}>
          <ellipse cx="50" cy="47" rx="28" ry="22.5" fill="#ffffff" />
          <path d="M31 60 q-1 9 -9 13 q12 1 19 -7 z" fill="#ffffff" />
        </Sq>
      );
    case "calendar":
      return (
        <Sq size={size} fill={g} defs={grad("#ffffff", "#f1f1f3")}>
          <text x="50" y="30" textAnchor="middle" fontFamily={sans} fontWeight={600} fontSize={15} fill="#f03e3e" letterSpacing={0.5}>
            NOV
          </text>
          <text x="50" y="79" textAnchor="middle" fontFamily={sans} fontWeight={400} fontSize={50} fill="#1d1d1f">
            8
          </text>
        </Sq>
      );
    case "notes":
      return (
        <Sq size={size} fill={g} defs={grad("#ffffff", "#f3f3f1")}>
          <clipPath id={`${id}c`}>
            <path d={SQ100} />
          </clipPath>
          <rect x="0" y="0" width="100" height="27" fill="#fbc93a" clipPath={`url(#${id}c)`} />
          <g stroke="#d6d6da" strokeWidth={1.6}>
            <path d="M16 45 H84 M16 56 H84 M16 67 H84 M16 78 H84" />
          </g>
        </Sq>
      );
    case "music":
      return (
        <Sq size={size} fill={g} defs={grad("#ff6a86", "#ef2a4d")}>
          <path d="M41 30 L71 24 V62" fill="none" stroke="#fff" strokeWidth={5.5} strokeLinejoin="round" />
          <path d="M41 30 V68" fill="none" stroke="#fff" strokeWidth={5.5} />
          <ellipse cx="34" cy="69" rx="8.5" ry="6.8" fill="#fff" transform="rotate(-18 34 69)" />
          <ellipse cx="64" cy="63" rx="8.5" ry="6.8" fill="#fff" transform="rotate(-18 64 63)" />
        </Sq>
      );
    case "trash":
      return (
        <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", overflow: "visible" }}>
          <defs>
            <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor="rgba(225,229,236,0.85)" />
              <stop offset="0.5" stopColor="rgba(250,251,253,0.95)" />
              <stop offset="1" stopColor="rgba(210,215,224,0.85)" />
            </linearGradient>
          </defs>
          <path d="M24 26 H76 L71 90 a4 4 0 0 1 -4 4 H33 a4 4 0 0 1 -4 -4 Z" fill={`url(#${id}t)`} stroke="rgba(110,116,128,0.55)" strokeWidth={1.2} />
          <g stroke="rgba(120,126,138,0.5)" strokeWidth={1.3}>
            <path d="M38 34 L40 86 M50 34 V86 M62 34 L60 86" />
          </g>
          <rect x="20" y="18" width="60" height="9" rx="4" fill="rgba(236,239,244,0.95)" stroke="rgba(110,116,128,0.55)" strokeWidth={1.2} />
        </svg>
      );
    default:
      return null;
  }
};

/** macOS Applications folder (blue folder, engraved "A"). */
export const AppsFolder: React.FC<{ size: number }> = ({ size }) => {
  const id = useSvgId("af");
  return (
    <svg width={size} height={size} viewBox="0 0 120 100" style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5fb1f7" />
          <stop offset="1" stopColor="#3a95ee" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9bd4ff" />
          <stop offset="1" stopColor="#5db3fb" />
        </linearGradient>
      </defs>
      <path d="M8 18 a5 5 0 0 1 5 -5 h30 l8 8 h56 a5 5 0 0 1 5 5 v56 a5 5 0 0 1 -5 5 h-94 a5 5 0 0 1 -5 -5 z" fill={`url(#${id}b)`} />
      <path d="M6 33 a5 5 0 0 1 5 -5 h98 a5 5 0 0 1 5 5 v51 a6 6 0 0 1 -6 6 h-96 a6 6 0 0 1 -6 -6 z" fill={`url(#${id}f)`} />
      <g fill="none" stroke="#3f8fdc" strokeWidth={4.2} strokeLinecap="round" opacity={0.85}>
        <path d="M49 78 L60 42 L71 78 M53.5 66 H66.5" />
      </g>
    </svg>
  );
};

/** Windows-style manila folder. */
export const WinFolder: React.FC<{ size: number }> = ({ size }) => {
  const id = useSvgId("wf");
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffdc73" />
          <stop offset="1" stopColor="#f7b52c" />
        </linearGradient>
      </defs>
      <path d="M6 24 a4 4 0 0 1 4 -4 h24 l6 6 h50 a4 4 0 0 1 4 4 v48 a4 4 0 0 1 -4 4 h-80 a4 4 0 0 1 -4 -4 z" fill="#e9a422" />
      <rect x="13" y="30" width="74" height="40" rx="2" fill="#ffffff" />
      <path d="M4 40 a4 4 0 0 1 4 -4 h84 a4 4 0 0 1 4 4 v38 a4 4 0 0 1 -4 4 h-84 a4 4 0 0 1 -4 -4 z" fill={`url(#${id}f)`} />
    </svg>
  );
};

export const ShortcutBadge: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: "block" }}>
    <rect x="1" y="1" width="22" height="22" rx="4" fill="#ffffff" stroke="rgba(0,0,0,0.15)" />
    <path d="M7 18 C7 11.5 10 9 15.5 9 L15.5 6 L20 10.5 L15.5 15 L15.5 12 C12 12 9.8 13.6 7 18 Z" fill="#1f6fe0" />
  </svg>
);

export const LinuxFiles: React.FC<{ size: number }> = ({ size }) => (
  <Sq size={size} fill="#5b5b60">
    <path d="M24 34 a4 4 0 0 1 4 -4 h14 l5 5 h25 a4 4 0 0 1 4 4 v28 a4 4 0 0 1 -4 4 h-44 a4 4 0 0 1 -4 -4 z" fill="#e2552c" />
    <path d="M24 42 h52 v26 a4 4 0 0 1 -4 4 h-44 a4 4 0 0 1 -4 -4 z" fill="#f4f4f5" />
  </Sq>
);

/**
 * Star, LiteDB's Text to SQL mascot, drawn from src/components/Mascot/art.ts:
 * six round arms around a large core, white body, eyes cut out of it.
 * `peek` clips everything below that height (its own 64px units).
 */
export const StarMascot: React.FC<{
  size: number;
  peek?: number;
  gazeX?: number;
  gazeY?: number;
  blink?: number;
  joy?: number;
  spin?: number;
  hands?: boolean;
  /** Eye offset in its own 64px units, as the app's rig sets it (overrides gaze). */
  eyes?: [number, number];
}> = ({ size, peek = 64, gazeX = 0, gazeY = 0, blink = 0, joy = 0, spin = 0, hands = false, eyes }) => {
  const id = useSvgId("star");
  const ARMS = [90, 30, -30, -90, -150, 150];
  const L = 23;
  const ends = ARMS.map((a) => {
    const r = ((a + spin) * Math.PI) / 180;
    return [32 + L * Math.cos(r), 32 - L * Math.sin(r)];
  });
  const open = Math.max(0.12, 1 - blink);
  const ex = eyes ? eyes[0] : gazeX * 0.55;
  const ey = eyes ? eyes[1] : gazeY * 0.5;
  const line = "rgba(16,16,18,0.3)";
  const body = C.fg;
  const k = size / 64;
  return (
    <div style={{ position: "relative", width: size, height: size * (peek / 64) }}>
      <svg width={size} height={size} viewBox="0 0 64 64" style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
        <defs>
          <clipPath id={`${id}c`}>
            <rect x="-20" y="-20" width="104" height={peek + 20} />
          </clipPath>
          <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="-40" y="-40" width="144" height="144">
            <rect x="-40" y="-40" width="144" height="144" fill="#fff" />
            <g opacity={1 - joy}>
              <ellipse cx={27.6 + ex} cy={31 + ey} rx="2.3" ry={3.2 * open} fill="#000" />
              <ellipse cx={36.4 + ex} cy={31 + ey} rx="2.3" ry={3.2 * open} fill="#000" />
            </g>
            <g opacity={joy} fill="none" stroke="#000" strokeWidth={1.6} strokeLinecap="round">
              <path d={`M${25.2 + ex} ${31.9 + ey} Q${27.6 + ex} ${28.3 + ey} ${30 + ex} ${31.9 + ey}`} />
              <path d={`M${34 + ex} ${31.9 + ey} Q${36.4 + ex} ${28.3 + ey} ${38.8 + ex} ${31.9 + ey}`} />
            </g>
          </mask>
        </defs>
        <g clipPath={`url(#${id}c)`}>
          <g mask={`url(#${id}m)`}>
            {ends.map(([x, y], i) => (
              <line key={`o${i}`} x1="32" y1="32" x2={x} y2={y} stroke={line} strokeWidth={10.8} strokeLinecap="round" />
            ))}
            <circle cx="32" cy="32" r={15.7} fill={line} />
            {ends.map(([x, y], i) => (
              <line key={`i${i}`} x1="32" y1="32" x2={x} y2={y} stroke={body} strokeWidth={8.6} strokeLinecap="round" />
            ))}
            <circle cx="32" cy="32" r={14.6} fill={body} />
          </g>
        </g>
      </svg>
      {hands
        ? [12.1, 51.9].map((x) => (
            <div
              key={x}
              style={{
                position: "absolute",
                left: (x - 4.5) * k,
                top: (peek - 4) * k,
                width: 9 * k,
                height: 5.5 * k,
                borderRadius: 3 * k,
                background: body,
                boxShadow: `0 ${1 * k}px ${1.5 * k}px rgba(0,0,0,0.45)`,
              }}
            />
          ))
        : null}
    </div>
  );
};

/** The demo cursor: a neutral pointer wearing Star's name tag. */
export const AgentCursor: React.FC<{ press?: number; ring?: number; label?: string; scale?: number }> = ({
  press = 0,
  ring = -1,
  label = CURSOR_LABEL,
  scale = 1,
}) => {
  const s = scale * (1 - press * 0.12);
  return (
    <div style={{ position: "absolute", left: 0, top: 0, transform: `scale(${s})`, transformOrigin: "0 0" }}>
      {ring >= 0 && ring < 1 ? (
        <div
          style={{
            position: "absolute",
            left: -(10 + ring * 22),
            top: -(10 + ring * 22),
            width: 2 * (10 + ring * 22),
            height: 2 * (10 + ring * 22),
            borderRadius: "50%",
            border: "2px solid rgba(237,237,237,0.9)",
            opacity: 1 - ring,
            boxShadow: "0 0 12px rgba(0,0,0,0.25)",
          }}
        />
      ) : null}
      <svg width="22" height="28" viewBox="0 0 22 28" style={{ position: "absolute", left: -2, top: -2, overflow: "visible" }}>
        <path
          d="M2.5 2.5 L2.5 21.5 L7.4 17 L10.8 24.6 L14.3 23.1 L11 15.6 L17.6 15.6 Z"
          fill="#f4f4f5"
          stroke="#161618"
          strokeWidth={1.6}
          strokeLinejoin="round"
          style={{ filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.45))" }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          left: 15,
          top: 21,
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "3px 9px 3px 6px",
          borderRadius: 999,
          background: "#ededed",
          color: "#161618",
          fontFamily: sans,
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: -0.1,
          whiteSpace: "nowrap",
          boxShadow: "0 4px 14px rgba(0,0,0,0.35), 0 0 0 0.5px rgba(0,0,0,0.25)",
        }}
      >
        <svg width="13" height="13" viewBox="0 0 64 64">
          {[90, 30, -30, -90, -150, 150].map((a) => {
            const r = (a * Math.PI) / 180;
            return (
              <line key={a} x1="32" y1="32" x2={32 + 23 * Math.cos(r)} y2={32 - 23 * Math.sin(r)} stroke="#161618" strokeWidth={10} strokeLinecap="round" />
            );
          })}
          <circle cx="32" cy="32" r="15" fill="#161618" />
        </svg>
        {label}
      </div>
    </div>
  );
};
