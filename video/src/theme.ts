export const colors = {
  bg: "#020817",
  bgElevated: "#030711",
  bgCard: "#0f172a",
  border: "#1e293b",
  text: "#e1e7ef",
  muted: "#94a3b8",
  dim: "#64748b",
  green: "#10b981",
  greenDim: "rgba(16, 185, 129, 0.16)",
  red: "#ef4444",
  redDim: "rgba(239, 68, 68, 0.18)",
  amber: "#fbbf24",
  blue: "#3b82f6",
  blueDim: "rgba(59, 130, 246, 0.16)",
  white: "#f8fafc",
};

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1080;

export const TRANSITION_FRAMES = 8;
export const SCENE_EVAL = Math.round(7.2 * FPS);
export const SCENE_BEAT = Math.round(2.2 * FPS);
export const SCENE_SLICE = Math.round(5.4 * FPS);
export const SCENE_FEWSHOT = Math.round(6.2 * FPS);
export const SCENE_REPAIR = Math.round(8.2 * FPS);
export const SCENE_OUTRO = Math.round(4.6 * FPS);

const BEATS = 4;

export const DURATION_IN_FRAMES =
  SCENE_EVAL +
  SCENE_SLICE +
  SCENE_FEWSHOT +
  SCENE_REPAIR +
  SCENE_OUTRO +
  SCENE_BEAT * BEATS;
