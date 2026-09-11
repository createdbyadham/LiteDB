import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "../theme";
import { mono, sans } from "../fonts";

export const Background: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const wordSize = 180;
  const lineHeight = 0.92;
  const linePx = wordSize * lineHeight;
  const copies = 12;
  const drift = interpolate(frame, [0, durationInFrames], [0, -linePx * 2], {
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ backgroundColor: colors.bg, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          opacity: 0.06,
          transform: `translateY(${drift}px)`,
          fontFamily: sans,
          fontWeight: 800,
          fontSize: wordSize,
          letterSpacing: -6,
          color: colors.text,
          lineHeight,
          padding: 24,
          userSelect: "none",
        }}
      >
        {Array.from({ length: copies }, (_, i) => (
          <React.Fragment key={i}>
            LITEDB
            <br />
          </React.Fragment>
        ))}
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(59,130,246,0.10) 0%, transparent 55%)",
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(rgba(148,163,184,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.08) 1px, transparent 1px)",
          backgroundSize: "54px 54px",
        }}
      />
    </AbsoluteFill>
  );
};

export const BrandMark: React.FC<{ opacity?: number }> = ({ opacity = 1 }) => {
  return (
    <div
      style={{
        position: "absolute",
        left: 56,
        top: 44,
        display: "flex",
        alignItems: "center",
        gap: 12,
        opacity,
        fontFamily: sans,
      }}
    >
      <Img
        src={staticFile("titlebaricon2.png")}
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
        }}
      />
      <span style={{ color: colors.text, fontWeight: 600, fontSize: 22, letterSpacing: 0.4 }}>
        LiteDB
      </span>
      <span style={{ color: colors.dim, fontFamily: mono, fontSize: 16 }}>eval</span>
    </div>
  );
};

export const Callout: React.FC<{
  text: string;
  color?: string;
  opacity: number;
  y?: number;
}> = ({ text, color = colors.text, opacity, y = 0 }) => {
  return (
    <div
      style={{
        position: "absolute",
        left: 56,
        right: 56,
        bottom: 56,
        opacity,
        transform: `translateY(${y}px)`,
        fontFamily: sans,
        fontSize: 28,
        fontWeight: 600,
        color,
        letterSpacing: -0.4,
        lineHeight: 1.25,
        textAlign: "center",
      }}
    >
      {text}
    </div>
  );
};
