import React, { useId } from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";

const useSvgId = (prefix: string) => prefix + useId().replace(/[^a-zA-Z0-9_-]/g, "");

/** Fine film grain so gradients never band and the art reads as a photo. */
export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.07 }) => (
  <AbsoluteFill
    style={{
      backgroundImage: `url(${staticFile("launch/noise.png")})`,
      backgroundSize: "256px 256px",
      opacity,
      mixBlendMode: "overlay",
      pointerEvents: "none",
    }}
  />
);

const HILLS: { crest: string; top: string; bottom: string; rim: string }[] = [
  {
    crest: "M-40 600 C 180 556, 360 540, 560 556 S 900 600, 1100 572 S 1460 520, 1660 540 S 1880 580, 1960 572",
    top: "#a9b0d3",
    bottom: "#9ba1c4",
    rim: "rgba(255,255,255,0.35)",
  },
  {
    crest: "M-40 644 C 220 610, 420 600, 640 622 S 1000 668, 1220 640 S 1580 596, 1800 612 S 1920 632, 1960 628",
    top: "#c6a6c1",
    bottom: "#ab8dad",
    rim: "rgba(255,240,245,0.35)",
  },
  {
    crest: "M-40 704 C 160 682, 300 650, 480 664 S 820 724, 1040 708 S 1400 650, 1640 668 S 1880 706, 1960 700",
    top: "#e6aa92",
    bottom: "#c98c7f",
    rim: "rgba(255,226,210,0.45)",
  },
  {
    crest: "M-40 790 C 240 748, 460 736, 700 760 S 1120 820, 1360 790 S 1720 742, 1960 762",
    top: "#f2ad6e",
    bottom: "#d78858",
    rim: "rgba(255,226,180,0.5)",
  },
  {
    crest: "M-40 884 C 300 830, 560 824, 820 856 S 1240 920, 1520 884 S 1840 846, 1960 852",
    top: "#de8248",
    bottom: "#b45d37",
    rim: "rgba(255,200,150,0.45)",
  },
  {
    crest: "M-40 984 C 260 944, 520 940, 780 966 S 1260 1010, 1540 988 S 1860 958, 1960 966",
    top: "#9c512f",
    bottom: "#5e2f1f",
    rim: "rgba(255,180,130,0.35)",
  },
];

/** macOS desktop: layered hills at golden hour (original artwork). */
export const HillsWallpaper: React.FC<{ width?: number; height?: number }> = ({ width = 1920, height = 1080 }) => {
  const id = useSvgId("hills");
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width, height, overflow: "hidden" }}>
      <svg width={width} height={height} viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" style={{ display: "block" }}>
        <defs>
          <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#6f93d2" />
            <stop offset="0.3" stopColor="#a9b4de" />
            <stop offset="0.47" stopColor="#e6cdd2" />
            <stop offset="0.56" stopColor="#f8d8bd" />
            <stop offset="1" stopColor="#f8d8bd" />
          </linearGradient>
          <radialGradient id={`${id}sun`} cx="0.66" cy="0.5" r="0.45">
            <stop offset="0" stopColor="rgba(255,236,200,0.9)" />
            <stop offset="0.35" stopColor="rgba(255,214,170,0.35)" />
            <stop offset="1" stopColor="rgba(255,214,170,0)" />
          </radialGradient>
          <filter id={`${id}soft`} x="-20%" y="-50%" width="140%" height="200%">
            <feGaussianBlur stdDeviation="16" />
          </filter>
          {HILLS.map((h, i) => (
            <linearGradient key={i} id={`${id}h${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={h.top} />
              <stop offset="1" stopColor={h.bottom} />
            </linearGradient>
          ))}
        </defs>
        <rect width="1920" height="1080" fill={`url(#${id}sky)`} />
        <rect width="1920" height="1080" fill={`url(#${id}sun)`} />
        <g filter={`url(#${id}soft)`} fill="#ffffff">
          <ellipse cx="420" cy="230" rx="280" ry="30" opacity="0.34" />
          <ellipse cx="1290" cy="160" rx="360" ry="36" opacity="0.28" />
          <ellipse cx="1680" cy="300" rx="210" ry="24" opacity="0.26" />
          <ellipse cx="820" cy="350" rx="240" ry="18" opacity="0.2" />
        </g>
        {HILLS.map((h, i) => (
          <g key={i}>
            <path d={`${h.crest} L1960 1120 L-40 1120 Z`} fill={`url(#${id}h${i})`} />
            <path d={h.crest} fill="none" stroke={h.rim} strokeWidth={1.6} />
          </g>
        ))}
        <rect width="1920" height="1080" fill="rgba(255,190,140,0.06)" />
      </svg>
      <Grain opacity={0.08} />
    </div>
  );
};

const PETALS = [-62, -40, -18, 4, 26, 48, 70, 94, 118];

/** Windows desktop: an abstract blue bloom (original artwork). */
export const BloomWallpaper: React.FC = () => {
  const id = useSvgId("bloom");
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ display: "block" }}>
        <defs>
          <radialGradient id={`${id}bg`} cx="0.58" cy="0.58" r="0.75">
            <stop offset="0" stopColor="#2f78f2" />
            <stop offset="0.45" stopColor="#0d2f86" />
            <stop offset="1" stopColor="#030c2c" />
          </radialGradient>
          <linearGradient id={`${id}p`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="rgba(190,226,255,0.95)" />
            <stop offset="0.55" stopColor="rgba(90,160,255,0.5)" />
            <stop offset="1" stopColor="rgba(40,110,255,0.05)" />
          </linearGradient>
          <filter id={`${id}blur`}>
            <feGaussianBlur stdDeviation="2.2" />
          </filter>
          <filter id={`${id}glow`}>
            <feGaussianBlur stdDeviation="40" />
          </filter>
        </defs>
        <rect width="1920" height="1080" fill={`url(#${id}bg)`} />
        <circle cx="1120" cy="640" r="260" fill="rgba(120,190,255,0.35)" filter={`url(#${id}glow)`} />
        <g transform="translate(1120 640)" filter={`url(#${id}blur)`}>
          {PETALS.map((a, i) => (
            <g key={a} transform={`rotate(${a}) scale(${1 + (i % 3) * 0.12} ${0.9 + (i % 2) * 0.2})`}>
              <path
                d="M0 0 C 150 -78, 470 -96, 700 -10 C 470 70, 150 78, 0 0 Z"
                fill={`url(#${id}p)`}
                stroke="rgba(214,236,255,0.45)"
                strokeWidth={1.4}
                opacity={0.75}
              />
            </g>
          ))}
          {PETALS.map((a) => (
            <g key={`b${a}`} transform={`rotate(${a + 180}) scale(0.7 0.8)`}>
              <path d="M0 0 C 150 -78, 470 -96, 700 -10 C 470 70, 150 78, 0 0 Z" fill={`url(#${id}p)`} opacity={0.35} />
            </g>
          ))}
        </g>
      </svg>
      <Grain opacity={0.05} />
    </AbsoluteFill>
  );
};

/** Linux desktop: warm aubergine-to-orange waves (original artwork). */
export const WavesWallpaper: React.FC = () => {
  const id = useSvgId("waves");
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <svg width="1920" height="1080" viewBox="0 0 1920 1080" style={{ display: "block" }}>
        <defs>
          <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="0.6">
            <stop offset="0" stopColor="#2b0a1d" />
            <stop offset="0.4" stopColor="#62162a" />
            <stop offset="0.72" stopColor="#b33a26" />
            <stop offset="1" stopColor="#ec6a2d" />
          </linearGradient>
        </defs>
        <rect width="1920" height="1080" fill={`url(#${id}bg)`} />
        {[0, 1, 2, 3, 4].map((i) => (
          <path
            key={i}
            d={`M-200 ${1180 - i * 120} C 300 ${880 - i * 110}, 900 ${1060 - i * 140}, 2120 ${360 - i * 120} L2120 ${470 - i * 120} C 900 ${1150 - i * 140}, 300 ${980 - i * 110}, -200 ${1300 - i * 120} Z`}
            fill={`rgba(255,${120 + i * 12},${80 + i * 8},${0.07 + i * 0.025})`}
          />
        ))}
        {[0, 1, 2].map((i) => (
          <path
            key={`l${i}`}
            d={`M-200 ${1000 - i * 160} C 400 ${760 - i * 150}, 1000 ${960 - i * 170}, 2120 ${300 - i * 150}`}
            fill="none"
            stroke="rgba(255,190,150,0.16)"
            strokeWidth={1.5}
          />
        ))}
      </svg>
      <Grain opacity={0.05} />
    </AbsoluteFill>
  );
};

/** Bright DMG backdrop. */
export const DmgBackdrop: React.FC<{ glow?: number }> = ({ glow = 1 }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(ellipse 70% 65% at 46% 52%, rgba(255,255,255,${0.95 * glow}) 0%, rgba(246,246,248,1) 55%, #e6e6ea 100%)`,
    }}
  />
);

// keep Img import used for tree-shaking friendliness in some bundlers
export const _unused = Img;
