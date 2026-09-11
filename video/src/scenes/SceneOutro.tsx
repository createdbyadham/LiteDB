import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { BrandMark } from "../components/Chrome";
import { mono, sans } from "../fonts";
import { colors } from "../theme";

export const SceneOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const left = spring({ frame, fps, delay: 2, config: { damping: 16, stiffness: 140 } });
  const right = spring({ frame, fps, delay: 10, config: { damping: 16, stiffness: 140 } });
  const drop = spring({
    frame,
    fps,
    delay: 28,
    durationInFrames: 22,
    config: { damping: 14, stiffness: 90 },
  });
  const heldOut = interpolate(drop, [0, 1], [86, 76.5]);
  const footnote = interpolate(frame, [52, 68], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill>
      <BrandMark />
      <div
        style={{
          position: "absolute",
          right: 56,
          top: 48,
          fontFamily: mono,
          fontSize: 18,
          color: colors.dim,
        }}
      >
        held-out split
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 112,
          fontFamily: sans,
          fontSize: 32,
          fontWeight: 700,
          color: colors.text,
          letterSpacing: -0.6,
          lineHeight: 1.25,
        }}
      >
        Same tuned prompt. Cases I wrote afterwards.
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 200,
          display: "flex",
          gap: 24,
        }}
      >
        <div
          style={{
            flex: 1,
            background: colors.bgElevated,
            border: `1px solid ${colors.border}`,
            borderRadius: 24,
            padding: 36,
            opacity: interpolate(left, [0, 0.15], [0, 1], { extrapolateRight: "clamp" }),
            transform: `translateY(${interpolate(left, [0, 1], [28, 0])}px)`,
          }}
        >
          <div style={{ fontFamily: sans, fontSize: 22, color: colors.muted, fontWeight: 500 }}>
            7B local
          </div>
          <div
            style={{
              fontFamily: sans,
              fontSize: 88,
              fontWeight: 800,
              color: colors.amber,
              letterSpacing: -4,
              marginTop: 8,
              lineHeight: 1,
            }}
          >
            {heldOut.toFixed(1)}%
          </div>
          <div
            style={{
              marginTop: 18,
              fontFamily: mono,
              fontSize: 20,
              color: colors.dim,
            }}
          >
            86% tuned → 76.5% held-out
          </div>
        </div>

        <div
          style={{
            flex: 1,
            background: colors.bgElevated,
            border: `1px solid ${colors.border}`,
            borderRadius: 24,
            padding: 36,
            opacity: interpolate(right, [0, 0.15], [0, 1], { extrapolateRight: "clamp" }),
            transform: `translateY(${interpolate(right, [0, 1], [28, 0])}px)`,
          }}
        >
          <div style={{ fontFamily: sans, fontSize: 22, color: colors.muted, fontWeight: 500 }}>
            Frontier
          </div>
          <div
            style={{
              fontFamily: sans,
              fontSize: 88,
              fontWeight: 800,
              color: colors.green,
              letterSpacing: -4,
              marginTop: 8,
              lineHeight: 1,
            }}
          >
            99%
          </div>
          <div
            style={{
              marginTop: 18,
              fontFamily: mono,
              fontSize: 20,
              color: colors.dim,
            }}
          >
            same accuracy with or without few-shot
          </div>
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 500,
          textAlign: "center",
          fontFamily: sans,
          fontSize: 38,
          fontWeight: 700,
          color: colors.text,
          letterSpacing: -0.6,
          lineHeight: 1.3,
          opacity: footnote,
          transform: `translateY(${interpolate(footnote, [0, 1], [16, 0])}px)`,
        }}
      >
        Prompts overfit like weights.
        <br />
        Build the held-out split first.
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 56,
          textAlign: "center",
          fontFamily: mono,
          fontSize: 20,
          color: colors.dim,
          opacity: interpolate(frame, [70, 84], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        github.com/createdbyadham/LiteDB
      </div>
    </AbsoluteFill>
  );
};
