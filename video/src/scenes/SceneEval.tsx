import React from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { BrandMark } from "../components/Chrome";
import { mono, sans } from "../fonts";
import { colors } from "../theme";

const CASES = [
  { id: "st-01", question: "List customers in Germany", pass: true },
  { id: "jn-04", question: "Products that have never been ordered", pass: true },
  { id: "ag-04", question: "Customers who spent more than 500", pass: true },
  { id: "wf-04", question: "Two most expensive products per category", pass: false },
  { id: "wf-06", question: "Each order and the previous order's total", pass: false },
  { id: "wf-14", question: "Each product and how many share its category", pass: false },
];

export const SceneEval: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const titleIn = spring({
    frame,
    fps,
    delay: 2,
    config: { damping: 200 },
  });

  const logIn = interpolate(frame, [28, 42], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const scoreIn = spring({
    frame,
    fps,
    delay: 148,
    config: { damping: 14, stiffness: 120 },
  });

  const revealed = CASES.filter((_, i) => frame > 48 + i * 14).length;
  const revealedPass = CASES.filter((c, i) => c.pass && frame > 48 + i * 14).length;

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
        109 cases
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 112,
          opacity: titleIn,
          transform: `translateY(${interpolate(titleIn, [0, 1], [18, 0])}px)`,
        }}
      >
        <div
          style={{
            fontFamily: sans,
            fontSize: 72,
            fontWeight: 800,
            color: colors.text,
            letterSpacing: -2,
            lineHeight: 1.1,
          }}
        >
          Evaluation
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 280,
          background: colors.bgElevated,
          border: `1px solid ${colors.border}`,
          borderRadius: 20,
          overflow: "hidden",
          opacity: logIn,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "14px 22px",
            borderBottom: `1px solid ${colors.border}`,
            fontFamily: mono,
            fontSize: 15,
            color: colors.dim,
            letterSpacing: 1,
            textTransform: "uppercase",
          }}
        >
          <span>eval runner</span>
          <span>
            {revealedPass}/{Math.max(revealed, 1)} passing
          </span>
        </div>
        {CASES.map((item, i) => {
          const appear = interpolate(frame, [48 + i * 14, 56 + i * 14], [0, 1], {
            easing: Easing.out(Easing.quad),
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={item.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "13px 22px",
                borderBottom: i === CASES.length - 1 ? "none" : `1px solid ${colors.border}`,
                opacity: appear,
                transform: `translateY(${interpolate(appear, [0, 1], [10, 0])}px)`,
                background: item.pass ? "transparent" : colors.redDim,
              }}
            >
              <div
                style={{
                  width: 72,
                  fontFamily: mono,
                  fontSize: 16,
                  color: colors.dim,
                }}
              >
                {item.id}
              </div>
              <div
                style={{
                  flex: 1,
                  fontFamily: sans,
                  fontSize: 22,
                  color: colors.text,
                  fontWeight: 500,
                }}
              >
                {item.question}
              </div>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 16,
                  fontWeight: 700,
                  color: item.pass ? colors.green : colors.red,
                  letterSpacing: 0.6,
                }}
              >
                {item.pass ? "PASS" : "FAIL"}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          bottom: 48,
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          opacity: interpolate(scoreIn, [0, 0.2], [0, 1], { extrapolateRight: "clamp" }),
          transform: `translateY(${interpolate(scoreIn, [0, 1], [16, 0])}px)`,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: sans,
              fontSize: 22,
              color: colors.muted,
              fontWeight: 500,
            }}
          >
            Overall on the 7B
          </div>
          <div
            style={{
              fontFamily: sans,
              fontSize: 72,
              fontWeight: 800,
              color: colors.text,
              letterSpacing: -3,
              lineHeight: 1,
            }}
          >
            77%
          </div>
        </div>
        <div
          style={{
            fontFamily: sans,
            fontSize: 26,
            color: colors.amber,
            fontWeight: 600,
            maxWidth: 520,
            textAlign: "right",
            lineHeight: 1.3,
          }}
        >
          Looks solid, until you see which questions failed.
        </div>
      </div>
    </AbsoluteFill>
  );
};
