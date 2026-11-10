// The LiteDB launch film. Scenes follow the first reference's beat, with holds
// where there is something to read. Inside the app, switching between Claude
// and LiteDB uses the second reference's transitions (./wall.tsx): the wall of
// screens going into LiteDB, the move-down coming back to Claude. A scene that
// switches screens is played in parts around those transitions.
import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { holdTotal, P, sec, unwarp } from "./kit";
import { WALL } from "./motion";
import { Catch, CATCH_LEN, CATCH_SWITCH, Fix, FIX_LEN, FIX_SWITCH, H_CATCH, H_FIX, H_SPLIT, HOOK_LEN, Meet, MEET, Opener, Split, SPLIT_LEN, TitleRows } from "./scenes1";
import { Ask, ASK_LEN, Connect, End, H_ASK, H_TABLES, Orbit, PixelWords, Tables, TABLES_LEN, TitleAsk, TitleQuery } from "./scenes2";
import { makeSlide, makeWall, Shot, SLIDE_FRAMES } from "./wall";
import { Sound } from "./sound";

/** A scene from `from` frames in: the part of it between two screen switches. */
const part = (Scene: React.FC, from: number): React.FC => {
  const Part: React.FC = () => (
    <Sequence from={-from} layout="none">
      <Scene />
    </Sequence>
  );
  return Part;
};

// Where the switches fall, in each scene's own frames.
const catchApp = sec(unwarp(CATCH_SWITCH.toApp, H_CATCH));
const catchChat = sec(unwarp(CATCH_SWITCH.toChat, H_CATCH));
const catchFollow = sec(unwarp(CATCH_SWITCH.follow, H_CATCH));
const catchEnd = sec(CATCH_LEN + holdTotal(H_CATCH));
const fixChat = sec(unwarp(FIX_SWITCH.toChat, H_FIX));
const fixAudit = sec(unwarp(FIX_SWITCH.toAudit, H_FIX));
const fixEnd = sec(FIX_LEN + holdTotal(H_FIX));
const tablesEnd = sec(TABLES_LEN + holdTotal(H_TABLES));
const askEnd = sec(ASK_LEN + holdTotal(H_ASK));

/** The rest of the wall: real frames from elsewhere in the film, all whole screens (no close-ups), as on the reference's wall. */
const WALL_TILES: Shot[] = [
  { Scene: Catch, frame: catchApp + sec(2.4) },
  { Scene: Tables, frame: Math.min(tablesEnd - 1, sec(2.6)) },
  { Scene: Ask, frame: sec(2.6) },
  { Scene: Tables, frame: Math.min(tablesEnd - 1, sec(2.9)) },
  { Scene: Fix, frame: fixEnd - sec(0.4) },
  { Scene: Ask, frame: Math.min(askEnd - 1, sec(9.6)) },
  { Scene: Catch, frame: catchChat + sec(1.2) },
  { Scene: Split, frame: sec(7.0) },
  { Scene: Fix, frame: sec(1.5) },
];
const wall = (Scene: React.FC, at: number) => makeWall({ Scene, frame: at - 1 }, { Scene, frame: at }, WALL_TILES);
/** The move-down plays the next part's first frames itself, so that part starts this many frames in. */
/** The move-down plays the whole next part, from `at` to `end`, sliding the entire time. */
const slide = (Scene: React.FC, at: number, end: number) => makeSlide({ Scene, frame: at - 1 }, Scene, at, end - at);

// [scene, frames on screen]
const LIST: [React.FC, number][] = [
  [Opener, sec(HOOK_LEN)],
  [Meet, sec(MEET.len)],
  [part(Catch, 0), catchApp],
  [wall(Catch, catchApp), sec(WALL.total)],
  [part(Catch, catchApp), catchChat - catchApp],
  [slide(Catch, catchChat, catchFollow), SLIDE_FRAMES.dip + catchFollow - catchChat],
  [TitleRows, sec(2.4 + 0.9)],
  [part(Catch, catchFollow), catchEnd - catchFollow],
  [part(Fix, 0), fixChat],
  [slide(Fix, fixChat, fixAudit), SLIDE_FRAMES.dip + fixAudit - fixChat],
  [wall(Fix, fixAudit), sec(WALL.total)],
  [part(Fix, fixAudit), fixEnd - fixAudit],
  [Split, sec(SPLIT_LEN + holdTotal(H_SPLIT))],
  [Connect, sec(6.8)],
  [PixelWords, sec(2.2)],
  [Tables, tablesEnd],
  [TitleAsk, sec(2.5 + 0.9)],
  [Ask, askEnd],
  [TitleQuery, sec(2.5 + 0.8)],
  [Orbit, sec(4.0)],
  [End, sec(3.5 + 1.5)],
];
/** [first frame, last frame + 1, scene] */
export const CUTS: [number, number, React.FC][] = [];
let at = 0;
for (const [Scene, d] of LIST) {
  CUTS.push([at, at + d, Scene]);
  at += d;
}

export const FILM_FRAMES = at;

export const LaunchFilm: React.FC = () => (
  <AbsoluteFill
    style={{
      background: P.ink
    }}
  >
    {CUTS.map(([a, b, Scene]) => (
      <Sequence key={a} from={a} durationInFrames={b - a}>
        <Scene />
      </Sequence>
    ))}
    <Sound frames={FILM_FRAMES} />
  </AbsoluteFill>
);
