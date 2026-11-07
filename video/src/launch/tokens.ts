import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrains } from "@remotion/google-fonts/JetBrainsMono";

export const { fontFamily: sans } = loadInter("normal", {
  weights: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
});

export const { fontFamily: mono } = loadJetBrains("normal", {
  weights: ["400", "500"],
  subsets: ["latin"],
});

/**
 * LiteDB v2.3.0 "graphite" tokens, read from the running app's computed
 * styles (src/index.css resolves to these exact values).
 */
export const C = {
  bg: "#141415",
  sidebar: "#0f0f10",
  card: "#18181b",
  secondary: "#232325",
  border: "#28282a",
  input: "#2d2d2f",
  fg: "#ededed",
  muted: "#a0a0a6",
  mutedSoft: "rgba(160,160,166,0.7)",
  key: "#f6ae31",
  warning: "#f08842",
  amber500: "#f59e0b",
  positive: "#4cc38a",
  connected: "#10b981",
  destructive: "#e5484d",
};

/** Inter stylistic sets the app turns on for body text. */
export const INTER_FEATURES = '"ss01", "ss02", "cv01", "cv02", "cv03"';

/** The agent cursor's name tag. One place to change it. */
export const CURSOR_LABEL = "Sequel";
