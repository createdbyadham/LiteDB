// Switching screens the way the second reference does. Curves in ./motion.ts.
// The wall: the screen zooms out into a wall of screens (0.625 s), the wall
// pans diagonally to the next one (0.96 s), and it zooms into that screen
// (0.625 s). Every tile is a real frame of the film, frozen, so the zoom starts
// on the exact frame the last shot ended on and lands on the frame the next one
// opens with. The move-down: the next screen slides up in front of the last.
import React from "react";
import { AbsoluteFill, Freeze, Sequence } from "remotion";
import { E, P, useT } from "./kit";
import { SLIDE, slideK, WALL } from "./motion";

/** Frames the move-down takes at 60 fps: the last screen's dip, then the slide. */
export const SLIDE_FRAMES = { dip: Math.round(SLIDE.dipDur * 60) };

/**
 * The move-down (the reference at 65.7 s and 66.8 s): the last screen dips a few
 * pixels, then the next one comes up from 27% of the frame below, in front of
 * it, and settles. The next screen is live: `Scene` from frame `at` on.
 */
export const makeSlide = (from: Shot, Scene: React.FC, at: number, len: number): React.FC => {
  const SlideScene: React.FC = () => {
    const t = useT();
    const dipT = SLIDE_FRAMES.dip / 60;
    const dip = SLIDE.dip * E.in(Math.min(1, t / dipT));
    const y = 1080 * SLIDE.from * (1 - slideK(t - dipT, len / 60));
    const radius = 28 * Math.min(1, y / 60);
    return (
      <AbsoluteFill style={{ background: P.ink, overflow: "hidden" }}>
        <AbsoluteFill style={{ transform: `translateY(${dip}px)` }}>
          <Freeze frame={from.frame}>
            <from.Scene />
          </Freeze>
        </AbsoluteFill>
        {t >= dipT ? (
          <AbsoluteFill style={{ transform: `translateY(${y}px)`, borderRadius: `${radius}px ${radius}px 0 0`, overflow: "hidden", boxShadow: "0 -24px 80px rgba(0,0,0,0.55)" }}>
            <Sequence from={SLIDE_FRAMES.dip - at} layout="none">
              <Scene />
            </Sequence>
          </AbsoluteFill>
        ) : null}
      </AbsoluteFill>
    );
  };
  return SlideScene;
};

const GAP = 120;
const TW = 1920 + GAP;
const TH = 1080 + GAP;
/** Rows are offset by half a screen, brick-wise, as on the reference's wall. */
const pos = (r: number, c: number) => ({ x: c * TW + (((r % 2) + 2) % 2) * TW * 0.5, y: r * TH });
/** Where the next screen sits: two rows down, three across, so the pan runs diagonally (dy about 0.4 dx). */
const TO = { r: 2, c: 3 };

export type Shot = { Scene: React.FC; frame: number };

const Tile: React.FC<{ shot: Shot }> = ({ shot }) => (
  <Freeze frame={shot.frame}>
    <shot.Scene />
  </Freeze>
);

export const makeWall = (from: Shot, to: Shot, others: Shot[]): React.FC => {
  const WallScene: React.FC = () => {
    const t = useT();
    const c0 = { x: 960, y: 540 };
    const p1 = pos(TO.r, TO.c);
    const c1 = { x: p1.x + 960, y: p1.y + 540 };
    // One continuous move, no speed jumps: the pan eases in and out over the
    // whole switch, and the zoom rises out and back in around it, flat at the top.
    const L = Math.log(WALL.out);
    const u = Math.min(1, Math.max(0, t / WALL.total));
    const k = u * u * u * (u * (u * 6 - 15) + 10);
    const out = 1 - Math.pow(Math.abs(Math.cos(Math.PI * u)), 3);
    const s = Math.exp(L * out);
    const c = { x: c0.x + (c1.x - c0.x) * k, y: c0.y + (c1.y - c0.y) * k };
    const tiles: React.ReactNode[] = [];
    let n = 0;
    for (let r = -3; r <= 5; r++) {
      for (let col = -4; col <= 7; col++) {
        const q = pos(r, col);
        const x = (q.x - c.x) * s + 960;
        const y = (q.y - c.y) * s + 540;
        const w = 1920 * s;
        const h = 1080 * s;
        const idx = n++;
        if (x + w < 0 || x > 1920 || y + h < 0 || y > 1080) continue;
        const shot = r === 0 && col === 0 ? from : r === TO.r && col === TO.c ? to : others[(idx * 7 + (r + 9) * 3) % others.length];
        tiles.push(
          <div
            key={`${r},${col}`}
            style={{ position: "absolute", left: q.x, top: q.y, width: 1920, height: 1080, overflow: "hidden", borderRadius: 28 * Math.min(1, Math.max(0, (1 - s) / (1 - WALL.out * 1.5))), boxShadow: "0 30px 90px rgba(0,0,0,0.55)", outline: "2px solid rgba(255,255,255,0.06)" }}
          >
            <Tile shot={shot} />
          </div>,
        );
      }
    }
    return (
      <AbsoluteFill style={{ background: P.ink, overflow: "hidden" }}>
        <div style={{ position: "absolute", left: 0, top: 0, transformOrigin: "0 0", transform: `translate(${960 - c.x * s}px, ${540 - c.y * s}px) scale(${s})` }}>{tiles}</div>
      </AbsoluteFill>
    );
  };
  return WallScene;
};
