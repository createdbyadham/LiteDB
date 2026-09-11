import React from "react";
import { Composition, Still } from "remotion";
import { EvalThumbnail } from "./EvalThumbnail";
import { EvalVideo } from "./EvalVideo";
import { DURATION_IN_FRAMES, FPS, HEIGHT, WIDTH } from "./theme";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="EvalPost"
        component={EvalVideo}
        durationInFrames={DURATION_IN_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
      />
      <Still
        id="EvalThumbnail"
        component={EvalThumbnail}
        width={WIDTH}
        height={HEIGHT}
      />
    </>
  );
};
