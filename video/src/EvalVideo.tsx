import React from "react";
import { AbsoluteFill, interpolate, Series, useCurrentFrame, useVideoConfig } from "remotion";
import { Background } from "./components/Chrome";
import { SceneEval } from "./scenes/SceneEval";
import { SceneBeat } from "./scenes/SceneBeat";
import { SceneSlice } from "./scenes/SceneSlice";
import { SceneFewShot } from "./scenes/SceneFewShot";
import { SceneRepair } from "./scenes/SceneRepair";
import { SceneOutro } from "./scenes/SceneOutro";
import {
  SCENE_BEAT,
  SCENE_EVAL,
  SCENE_FEWSHOT,
  SCENE_OUTRO,
  SCENE_REPAIR,
  SCENE_SLICE,
  TRANSITION_FRAMES,
} from "./theme";

const SceneGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const fade = TRANSITION_FRAMES;
  const opacity = interpolate(
    frame,
    [0, fade, Math.max(fade + 1, durationInFrames - fade), durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );

  return <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>;
};

const BeatSlice: React.FC = () => (
  <SceneBeat
    step="What I did next"
    line="I sliced that 77% by query type."
    sub="A single average hides which questions actually fail."
  />
);

const BeatFewShot: React.FC = () => (
  <SceneBeat
    step="What I tried"
    line="Instructions in the prompt failed"
    sub="Retrieval examples worked (dynamic few shot)"
  />
);

const BeatRepair: React.FC = () => (
  <SceneBeat
    step="What else I tried"
    line="Self-correction only works when the query crashes."
    sub="If the SQL runs cleanly with the wrong data, there is no error to fix."
  />
);

const BeatHoldout: React.FC = () => (
  <SceneBeat
    step="The reality check"
    line="Then I tested queries written after tuning."
    sub="That is the number that would actually ship."
  />
);

export const EvalVideo: React.FC = () => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill>
      <Background />
      <Series>
        <Series.Sequence durationInFrames={SCENE_EVAL} premountFor={fps}>
          <SceneGate>
            <SceneEval />
          </SceneGate>
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENE_BEAT} premountFor={fps}>
          <SceneGate>
            <BeatSlice />
          </SceneGate>
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENE_SLICE} premountFor={fps}>
          <SceneGate>
            <SceneSlice />
          </SceneGate>
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENE_BEAT} premountFor={fps}>
          <SceneGate>
            <BeatFewShot />
          </SceneGate>
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENE_FEWSHOT} premountFor={fps}>
          <SceneGate>
            <SceneFewShot />
          </SceneGate>
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENE_BEAT} premountFor={fps}>
          <SceneGate>
            <BeatRepair />
          </SceneGate>
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENE_REPAIR} premountFor={fps}>
          <SceneGate>
            <SceneRepair />
          </SceneGate>
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENE_BEAT} premountFor={fps}>
          <SceneGate>
            <BeatHoldout />
          </SceneGate>
        </Series.Sequence>
        <Series.Sequence durationInFrames={SCENE_OUTRO} premountFor={fps}>
          <SceneGate>
            <SceneOutro />
          </SceneGate>
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
};
