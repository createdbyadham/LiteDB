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

const QUESTION = "Show the two most expensive products in each category";
const HIGHLIGHTS = ["two", "most", "each"];

const EXEMPLARS = [
  {
    title: "Top-N per group",
    sql: "ROW_NUMBER() OVER (PARTITION BY dept …)",
    tag: "top · each",
  },
  {
    title: "Count on every row",
    sql: "COUNT(*) OVER (PARTITION BY dept)",
    tag: "how many · their",
  },
  {
    title: "Contrast: real GROUP BY",
    sql: "GROUP BY department (one row per group)",
    tag: "count · each",
  },
];

const HighlightedQuestion: React.FC<{ progress: number }> = ({ progress }) => {
  const parts = QUESTION.split(/(\s+)/);
  let consumed = 0;
  const total = QUESTION.length;
  const shown = Math.round(progress * total);

  return (
    <div
      style={{
        fontFamily: sans,
        fontSize: 36,
        fontWeight: 600,
        color: colors.text,
        letterSpacing: -0.6,
        lineHeight: 1.35,
      }}
    >
      {parts.map((part, i) => {
        const start = consumed;
        consumed += part.length;
        const visibleChars = Math.max(0, Math.min(part.length, shown - start));
        const visible = part.slice(0, visibleChars);
        const isWord = HIGHLIGHTS.includes(part.toLowerCase());
        return (
          <span
            key={i}
            style={{
              background: isWord && visibleChars === part.length ? colors.blueDim : "transparent",
              color: isWord && visibleChars === part.length ? colors.blue : colors.text,
              borderRadius: 6,
              padding: isWord ? "0 4px" : 0,
            }}
          >
            {visible}
          </span>
        );
      })}
    </div>
  );
};

export const SceneFewShot: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const typeProgress = interpolate(frame, [4, 28], [0, 1], {
    easing: Easing.out(Easing.quad),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const badgeIn = spring({
    frame,
    fps,
    delay: 30,
    config: { damping: 200 },
  });

  const barProgress = spring({
    frame,
    fps,
    delay: 92,
    durationInFrames: 28,
    config: { damping: 18, stiffness: 90 },
  });
  const windowPct = interpolate(barProgress, [0, 1], [51, 84]);

  const calloutOpacity = interpolate(frame, [118, 132], [0, 1], {
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
          color: colors.blue,
        }}
      >
        3 examples into the prompt
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 120,
          background: colors.bgElevated,
          border: `1px solid ${colors.border}`,
          borderRadius: 20,
          padding: "28px 32px",
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 16,
            color: colors.dim,
            marginBottom: 10,
            letterSpacing: 1.2,
            textTransform: "uppercase",
          }}
        >
          User question
        </div>
        <HighlightedQuestion progress={typeProgress} />
        <div
          style={{
            marginTop: 16,
            fontFamily: mono,
            fontSize: 16,
            color: colors.blue,
            opacity: interpolate(frame, [28, 38], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          matched on keywords · zero GPU overhead · different schema on purpose
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 360,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            opacity: badgeIn,
            transform: `translateY(${interpolate(badgeIn, [0, 1], [12, 0])}px)`,
          }}
        >
          <div
            style={{
              fontFamily: sans,
              fontSize: 22,
              color: colors.muted,
              fontWeight: 500,
            }}
          >
            Retrieved examples
          </div>
          <div
            style={{
              fontFamily: mono,
              fontSize: 16,
              color: colors.amber,
              background: "rgba(251,191,36,0.12)",
              border: "1px solid rgba(251,191,36,0.35)",
              borderRadius: 999,
              padding: "6px 14px",
              fontWeight: 600,
            }}
          >
            schema: employees / departments
          </div>
        </div>

        {EXEMPLARS.map((ex, i) => {
          const enter = spring({
            frame,
            fps,
            delay: 38 + i * 8,
            config: { damping: 16, stiffness: 160 },
          });
          return (
            <div
              key={ex.title}
              style={{
                background: colors.bgCard,
                border: `1px solid ${colors.border}`,
                borderRadius: 16,
                padding: "16px 22px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                opacity: interpolate(enter, [0, 0.2], [0, 1], {
                  extrapolateRight: "clamp",
                }),
                transform: `translateX(${interpolate(enter, [0, 1], [48, 0])}px)`,
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: sans,
                    fontSize: 24,
                    fontWeight: 600,
                    color: colors.text,
                  }}
                >
                  {ex.title}
                </div>
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: 18,
                    color: colors.muted,
                    marginTop: 4,
                  }}
                >
                  {ex.sql}
                </div>
              </div>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 15,
                  color: colors.blue,
                }}
              >
                {ex.tag}
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
          bottom: 128,
          opacity: interpolate(frame, [86, 98], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontFamily: sans,
            fontSize: 22,
            color: colors.muted,
            marginBottom: 10,
          }}
        >
          <span>Window functions</span>
          <span
            style={{
              fontFamily: mono,
              fontWeight: 700,
              color: barProgress > 0.6 ? colors.green : colors.red,
              fontSize: 28,
            }}
          >
            {Math.round(windowPct)}%
          </span>
        </div>
        <div
          style={{
            height: 14,
            borderRadius: 999,
            background: "rgba(148,163,184,0.14)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${windowPct}%`,
              height: "100%",
              borderRadius: 999,
              background: barProgress > 0.6 ? colors.green : colors.red,
            }}
          />
        </div>
      </div>

      <Callout
        text="7 cases fixed. Window functions 51% → 84%."
        opacity={calloutOpacity}
        y={interpolate(calloutOpacity, [0, 1], [14, 0])}
      />
    </AbsoluteFill>
  );
};
