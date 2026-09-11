import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrains } from "@remotion/google-fonts/JetBrainsMono";

export const { fontFamily: sans } = loadInter("normal", {
  weights: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
});

export const { fontFamily: mono } = loadJetBrains("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
});
