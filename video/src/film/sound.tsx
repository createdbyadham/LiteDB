// The film's sound: the voiceover, one take split into its lines and placed on
// the shots they talk about, over the music, which ducks under each line.
import React from "react";
import { Audio, interpolate, Sequence, staticFile } from "remotion";
import { HOOK_LEN } from "./scenes1";

const FPS = 60;
const f = (s: number) => Math.round(s * FPS);

/**
 * The instrumental (about 94 BPM) opens with stabs and gaps, then the groove
 * comes in on the downbeat at 10.588 s. That downbeat lands on the cut to
 * "Meet", so the hook plays over the stabs.
 */
const DROP = 10.588;
const MUSIC_FROM = DROP - HOOK_LEN;

/** [in, out] in the VO take (s), and where the line starts in the film (s). */
const VO: [number, number, number][] = [
  [0.09, 3.0, 0.1], // Would you give an AI agent write access to production?
  [3.47, 4.37, 3.35], // Didn't think so.
  [4.93, 6.55, 4.5], // What if it had to ask you first?
  [7.05, 8.17, 7.6], // Meet LiteDB.
  [8.63, 10.62, 10.8], // You ask Claude to clean up the test accounts.
  [11.25, 15.76, 16.1], // Before anything runs, LiteDB shows you the query...
  [16.18, 17.96, 21.3], // Most of these are real customers.
  [18.42, 20.59, 24.6], // So you decline. Nothing runs.
  [21.18, 23.93, 29.2], // One loose match. Twelve hundred rows.
  [24.44, 25.25, 32.6], // Tell it what you meant.
  [25.75, 30.36, 37.1], // Now it's thirty-seven rows... Approve, and it runs.
  [30.99, 33.35, 44.6], // Every statement is logged, right on your machine.
  [33.84, 36.26, 49.1], // Changed your mind? Undo puts the rows back.
  [36.76, 41.22, 57.6], // It works with Claude Code, Cursor, VS Code...
  [41.78, 46.5, 64.1], // Your schema becomes context, so your agents...
  [46.96, 48.5, 71.8], // Or just ask inside the app.
  [49.0, 50.59, 75.6], // Type a question in plain words.
  [51.15, 55.02, 81.1], // LiteDB writes the SQL from your schema...
  [55.54, 59.5, 87.6], // SQLite, Postgres, local models. All on your machine.
  [60.01, 61.31, 95.1], // You didn't just run a query.
  [61.64, 63.01, 100.0], // You stayed in control.
  [63.53, 65.86, 102.6], // LiteDB. Free and open source.
];
const PAD = 0.06;

const MUSIC = 0.4;
const DUCKED = 0.14;
const RAMP = 0.2;
/** How far the music sits under the voice at film time s: 0 clear, 1 fully ducked. */
const duck = (s: number) => {
  let d = 0;
  for (const [a, b, at] of VO) {
    const start = at;
    const end = at + (b - a);
    d = Math.max(d, Math.min(1, Math.max(0, Math.min((s - (start - RAMP)) / RAMP, (end + RAMP - s) / RAMP))));
  }
  return d;
};

export const Sound: React.FC<{ frames: number }> = ({ frames }) => (
  <>
    <Audio
      src={staticFile("launch/audio/music.mp3")}
      trimBefore={f(MUSIC_FROM)}
      volume={(fr) => {
        const s = fr / FPS;
        const fade = interpolate(fr, [0, f(0.4), frames - f(2.2), frames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        return fade * (MUSIC + (DUCKED - MUSIC) * duck(s));
      }}
    />
    {VO.map(([a, b, at], i) => (
      <Sequence key={i} from={f(at - PAD)} durationInFrames={f(b - a + 2 * PAD)} layout="none">
        <Audio src={staticFile("launch/audio/vo.mp3")} trimBefore={f(a - PAD)} durationInFrames={f(b - a + 2 * PAD)} volume={1} />
      </Sequence>
    ))}
  </>
);
