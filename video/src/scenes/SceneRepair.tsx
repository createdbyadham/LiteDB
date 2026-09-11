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

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

const BOX_W = 210;
const BOX_H = 148;
const ROW_Y = 78;

const USER_X = 0;
const MODEL_X = 379;
const DB_X = 758;
const USER_RIGHT = USER_X + BOX_W;
const MODEL_RIGHT = MODEL_X + BOX_W;
const ARROW_Y = ROW_Y + BOX_H / 2;
const BOX_BOTTOM = ROW_Y + BOX_H;

type Tone = "idle" | "ask" | "write" | "error" | "ok" | "retry";

const Node: React.FC<{
  x: number;
  y: number;
  title: string;
  sub: string;
  active: number;
  tone: Tone;
}> = ({ x, y, title, sub, active, tone }) => {
  const border =
    tone === "error"
      ? colors.red
      : tone === "ok"
        ? colors.green
        : tone === "retry" || tone === "write"
          ? colors.amber
          : tone === "ask"
            ? colors.blue
            : colors.border;
  const glow =
    tone === "error"
      ? colors.redDim
      : tone === "ok"
        ? colors.greenDim
        : tone === "retry" || tone === "write"
          ? "rgba(251,191,36,0.16)"
          : tone === "ask"
            ? colors.blueDim
            : "transparent";
  const subColor =
    tone === "error"
      ? colors.red
      : tone === "ok"
        ? colors.green
        : tone === "write" || tone === "retry"
          ? colors.amber
          : colors.muted;

  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: BOX_W,
        height: BOX_H,
        borderRadius: 22,
        border: `1.5px solid ${border}`,
        background: colors.bgCard,
        boxShadow: `0 0 0 10px ${glow}`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "0 18px",
        zIndex: 2,
        opacity: interpolate(active, [0, 0.2], [0, 1], { extrapolateRight: "clamp" }),
        transform: `scale(${interpolate(active, [0, 1], [0.9, 1])})`,
      }}
    >
      <div
        style={{
          fontFamily: sans,
          fontSize: 26,
          fontWeight: 700,
          color: colors.text,
          letterSpacing: -0.4,
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: 8,
          fontFamily: mono,
          fontSize: 15,
          color: subColor,
          lineHeight: 1.35,
        }}
      >
        {sub}
      </div>
    </div>
  );
};

const HArrow: React.FC<{
  fromX: number;
  toX: number;
  y: number;
  progress: number;
  color: string;
  label: string;
  labelSide: "above" | "below";
}> = ({ fromX, toX, y, progress, color, label, labelSide }) => {
  const pointingRight = toX > fromX;
  const tip = interpolate(progress, [0, 1], [fromX, toX], {
    easing: Easing.out(Easing.quad),
    ...clamp,
  });
  const head = 18;
  const span = Math.abs(tip - fromX);
  const lineW = Math.max(0, span - head);
  const lineLeft = pointingRight ? fromX : tip + head;
  const trackLeft = Math.min(fromX, toX);
  const trackW = Math.abs(toX - fromX);
  const show = progress > 0.04 ? 1 : 0;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {progress > 0.01 ? (
        <div
          style={{
            position: "absolute",
            left: trackLeft,
            top: y,
            width: trackW,
            height: 3,
            borderRadius: 99,
            background: "rgba(148,163,184,0.16)",
          }}
        />
      ) : null}
      <div
        style={{
          position: "absolute",
          left: lineLeft,
          top: y,
          width: lineW,
          height: 3,
          borderRadius: 99,
          background: color,
          opacity: show,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: pointingRight ? tip - head : tip,
          top: y + 1.5 - 9,
          width: 0,
          height: 0,
          borderTop: "9px solid transparent",
          borderBottom: "9px solid transparent",
          ...(pointingRight
            ? { borderLeft: `${head}px solid ${color}` }
            : { borderRight: `${head}px solid ${color}` }),
          opacity: show,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: trackLeft,
          width: trackW,
          top: labelSide === "above" ? y - 32 : y + 16,
          textAlign: "center",
          fontFamily: mono,
          fontSize: 14,
          fontWeight: 600,
          color,
          opacity: interpolate(progress, [0.35, 0.7], [0, 1], clamp) * show,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
    </div>
  );
};

const LoopBack: React.FC<{ progress: number }> = ({ progress }) => {
  const modelCx = MODEL_X + BOX_W / 2;
  const dbCx = DB_X + BOX_W / 2;
  const dip = BOX_BOTTOM + 44;
  const d = `M ${dbCx} ${BOX_BOTTOM} L ${dbCx} ${dip} L ${modelCx} ${dip} L ${modelCx} ${BOX_BOTTOM}`;
  const offset = interpolate(progress, [0, 1], [100, 0], clamp);
  const show = progress > 0.04 ? 1 : 0;
  const headOn = interpolate(progress, [0.86, 0.96], [0, 1], clamp);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <svg width="968" height="420" viewBox="0 0 968 420" style={{ overflow: "visible" }}>
        <path
          d={d}
          fill="none"
          stroke={colors.red}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={offset}
          opacity={show}
        />
        <polygon
          points={`${modelCx - 9},${BOX_BOTTOM + 16} ${modelCx + 9},${BOX_BOTTOM + 16} ${modelCx},${BOX_BOTTOM}`}
          fill={colors.red}
          opacity={headOn}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          left: Math.min(modelCx, dbCx),
          width: Math.abs(dbCx - modelCx),
          top: dip + 10,
          textAlign: "center",
          fontFamily: mono,
          fontSize: 14,
          fontWeight: 600,
          color: colors.red,
          opacity: interpolate(progress, [0.35, 0.7], [0, 1], clamp) * show,
        }}
      >
        error fed back
      </div>
    </div>
  );
};

export const SceneRepair: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const nodesIn = spring({
    frame,
    fps,
    delay: 2,
    config: { damping: 16, stiffness: 140 },
  });

  const ask = interpolate(frame, [14, 40], [0, 1], clamp);
  const write = interpolate(frame, [44, 76], [0, 1], clamp);
  const errorHit = interpolate(frame, [74, 86], [0, 1], clamp);
  const back = interpolate(frame, [88, 122], [0, 1], clamp);
  const retry = interpolate(frame, [118, 134, 158], [0, 1, 0], clamp);
  const fix = interpolate(frame, [140, 176], [0, 1], clamp);
  const passHit = interpolate(frame, [172, 188], [0, 1], clamp);
  const calloutOpacity = interpolate(frame, [192, 210], [0, 1], clamp);

  const userTone: Tone = ask > 0.2 && write < 0.3 ? "ask" : "idle";
  const modelTone: Tone =
    retry > 0.25 ? "retry" : write > 0.25 && back < 0.4 ? "write" : "idle";
  const dbTone: Tone = passHit > 0.4 ? "ok" : errorHit > 0.4 && passHit < 0.2 ? "error" : "idle";

  const userSub = ask > 0.4 ? "asks a question" : "waiting";
  const modelSub =
    retry > 0.3 ? "fixes the SQL" : write > 0.4 ? "writes SQL" : "waiting";
  const dbSub =
    passHit > 0.5 ? "12 rows returned" : errorHit > 0.5 ? "column does not exist" : "waiting";

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
          color: colors.red,
        }}
      >
        +2pp
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 112,
          fontFamily: sans,
          fontSize: 28,
          fontWeight: 700,
          color: colors.text,
          letterSpacing: -0.5,
        }}
      >
        User asks. Model writes. Database checks.
      </div>

      <div
        style={{
          position: "absolute",
          left: 56,
          right: 56,
          top: 168,
          height: 420,
        }}
      >
        <HArrow
          fromX={USER_RIGHT + 6}
          toX={MODEL_X - 6}
          y={ARROW_Y}
          progress={ask}
          color={colors.blue}
          label="question"
          labelSide="above"
        />
        <HArrow
          fromX={MODEL_RIGHT + 6}
          toX={DB_X - 6}
          y={ARROW_Y}
          progress={fix > 0.08 ? fix : write}
          color={fix > 0.08 ? colors.green : colors.blue}
          label={fix > 0.08 ? "orders.id" : "orders.order_id"}
          labelSide="above"
        />
        <LoopBack progress={back} />

        <Node
          x={USER_X}
          y={ROW_Y}
          title="User"
          sub={userSub}
          active={nodesIn}
          tone={userTone}
        />
        <Node
          x={MODEL_X}
          y={ROW_Y}
          title="7B model"
          sub={modelSub}
          active={nodesIn}
          tone={modelTone}
        />
        <Node
          x={DB_X}
          y={ROW_Y}
          title="Database"
          sub={dbSub}
          active={nodesIn}
          tone={dbTone}
        />
      </div>

      <Callout
        text="Fixes syntax crashes (+2pp). Silent logic bugs slip right through."
        opacity={calloutOpacity}
        y={interpolate(calloutOpacity, [0, 1], [12, 0])}
      />
    </AbsoluteFill>
  );
};
