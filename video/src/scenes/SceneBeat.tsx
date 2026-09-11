import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { BrandMark } from "../components/Chrome";
import { mono, sans } from "../fonts";
import { colors } from "../theme";

export const SceneBeat: React.FC<{
  step: string;
  line: string;
  sub?: string;
}> = ({ step, line, sub }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame,
    fps,
    delay: 2,
    config: { damping: 200 },
  });

  return (
    <AbsoluteFill>
      <BrandMark />
      <div
        style={{
          position: "absolute",
          left: 72,
          right: 72,
          top: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          opacity: interpolate(enter, [0, 0.15], [0, 1], { extrapolateRight: "clamp" }),
          transform: `translateY(${interpolate(enter, [0, 1], [24, 0])}px)`,
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 20,
            color: colors.blue,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            marginBottom: 22,
          }}
        >
          {step}
        </div>
        <div
          style={{
            fontFamily: sans,
            fontSize: 52,
            fontWeight: 800,
            color: colors.text,
            letterSpacing: -1.6,
            lineHeight: 1.18,
          }}
        >
          {line}
        </div>
        {sub ? (
          <div
            style={{
              marginTop: 22,
              fontFamily: sans,
              fontSize: 28,
              color: colors.muted,
              lineHeight: 1.35,
              fontWeight: 500,
            }}
          >
            {sub}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
