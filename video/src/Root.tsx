import React from "react";
import { Composition, Still } from "remotion";
import { EvalThumbnail } from "./EvalThumbnail";
import { EvalVideo } from "./EvalVideo";
import { DURATION_IN_FRAMES, FPS, HEIGHT, WIDTH } from "./theme";
import { FILM_FRAMES, LaunchFilm } from "./film/LaunchFilm";

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
      <Composition
        id="LaunchFilm"
        component={LaunchFilm}
        durationInFrames={FILM_FRAMES}
        fps={60}
        width={1920}
        height={1080}
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
