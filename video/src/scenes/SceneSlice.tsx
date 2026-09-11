import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { BrandMark, Callout } from "../components/Chrome";
import { mono, sans } from "../fonts";
import { colors } from "../theme";

const SLICES = [
  { label: "Single-table", value: 100, color: colors.green },
  { label: "Joins", value: 100, color: colors.green },
  { label: "Aggregation", value: 100, color: colors.green },
  { label: "Ambiguous schema", value: 88, color: colors.green },
  { label: "Window functions", value: 51, color: colors.red, problem: true },
];

const SliceBar: React.FC<{
  item: (typeof SLICES)[number];
  index: number;
}> = ({ item, index }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    delay: 12 + index * 7,
    config: { damping: 16, stiffness: 180 },
  });

  const width = interpolate(enter, [0, 1], [0, item.value]);
  const pulse =
    item.problem && frame > 70
      ? interpolate(Math.sin(frame / 5), [-1, 1], [0.55, 1])
      : 1;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        opacity: interpolate(enter, [0, 0.2], [0, 1], {
          extrapolateRight: "clamp",
        }),
        transform: `translateX(${interpolate(enter, [0, 1], [40, 0])}px)`,
      }}
    >
      <div
        style={{
          width: 250,
          fontFamily: sans,
          fontSize: 26,
          fontWeight: item.problem ? 700 : 500,
          color: item.problem ? colors.red : colors.text,
          letterSpacing: -0.3,
        }}
      >
        {item.label}
      </div>
      <div
        style={{
          flex: 1,
          height: item.problem ? 28 : 18,
          borderRadius: 999,
          background: "rgba(148,163,184,0.12)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${width}%`,
            height: "100%",
            borderRadius: 999,
            background: item.color,
            boxShadow: item.problem ? `0 0 ${18 * pulse}px ${colors.red}` : undefined,
            opacity: item.problem ? pulse : 1,
          }}
        />
      </div>
      <div
        style={{
          width: 92,
          textAlign: "right",
          fontFamily: mono,
          fontSize: item.problem ? 32 : 24,
          fontWeight: 700,
          color: item.color,
        }}
      >
        {Math.round(width)}%
      </div>
    </div>
  );
};

export const SceneSlice: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const head = spring({ frame, fps, delay: 2, config: { damping: 200 } });
  const calloutOpacity = interpolate(frame, [95, 112], [0, 1], {
    easing: Easing.out(Easing.quad),
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
        same 77% · sliced
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 118,
          opacity: head,
          transform: `translateY(${interpolate(head, [0, 1], [14, 0])}px)`,
        }}
      >
        <div
          style={{
            fontFamily: sans,
            fontSize: 40,
            fontWeight: 800,
            color: colors.text,
            letterSpacing: -1,
            lineHeight: 1.15,
          }}
        >
          Four categories were basically solved.
        </div>
        <div
          style={{
            marginTop: 10,
            fontFamily: sans,
            fontSize: 26,
            color: colors.muted,
            fontWeight: 500,
          }}
        >
          The whole 23-point gap lived in one slice.
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 280,
          display: "flex",
          flexDirection: "column",
          gap: 22,
        }}
      >
        {SLICES.map((item, index) => (
          <SliceBar key={item.label} item={item} index={index} />
        ))}
      </div>

      <Callout
        text="Window functions: the model used GROUP BY and returned the wrong rows."
        opacity={calloutOpacity}
        y={interpolate(calloutOpacity, [0, 1], [16, 0])}
      />
    </AbsoluteFill>
  );
};
