// Star, the Text-to-SQL mascot: the asterisk from LiteDB's logo, and from
// SELECT *. Six round arms around a large center. Its colour, eyes and mouth
// are a preference (Settings → Star); by default its colour follows the theme
// (white on a dark window, graphite on a light one), with its eyes cut out of
// the body so whatever is behind it shows through, and no mouth.
//
// This file draws Star and animates its own parts (arms, eyes, mouth, and the
// glasses it wears in Read-only and YOLO) from the state the rig in
// ./motion.ts computes each frame.

import { Spring } from '@/lib/spring';
import type { DrawnLook, StarColor } from '@/lib/mascot';

/** Star's size, and where its parts sit, in its own 64×64 coordinates. */
export const STAR = {
  W: 64,
  H: 64,
  /** How much of it shows above the edge it peeks over. */
  PEEK: 44,
  /** Between the eyes: what its gaze is measured from. */
  eye: { x: 32, y: 31 },
  /** Where the two lower arms meet the edge: fingertips are drawn there. */
  hands: [12.1, 51.9],
  /** Where puffs of air leave when it exhales. */
  puffs: [[24, 8], [32, 4], [40, 8]] as [number, number][],
  /** Where the Zs leave when it dozes: above its head, to the right of the top arm. */
  snore: { x: 41, y: 9 },
};

/**
 * What it wears for the connection's mode: reading glasses in Read-only,
 * sunglasses in YOLO. These are the values the rig springs between.
 */
export const WEAR = {
  /** Reading glasses this far above where they sit, px, are off and out of sight. */
  specsOff: -34,
  /** How far they slide down its nose when it peers over them, px: enough that its eyes rest on the rims. */
  peer: 3.2,
  /** Sunglasses flipped up this far (a vertical scale about their top bar) are off. */
  shadesOff: -0.7,
  /** The fedora (production connections) this far above where it sits, px, is off and out of sight. */
  hatOff: -30,
};

export const STAR_COLORS: Record<StarColor, { body: string; line: string; ink: string }> = {
  white: { body: '#ededed', line: 'rgba(16,16,18,0.3)', ink: '#161618' },
  graphite: { body: '#2b2b2f', line: 'rgba(237,237,237,0.4)', ink: '#ededed' },
};

/** What the rig hands Star each frame. Moods are 0..1 springs. */
export interface StarState {
  t: number;
  dt: number;
  /** Gaze offset, about ±3 px. */
  ex: number;
  ey: number;
  /** Cross-eyed, 0..1: each eye turns in toward the cursor parked on its face. */
  cross: number;
  /** Eyelids: 1 open, 0 shut. */
  open: number;
  widen: number;
  joy: number;
  wince: number;
  worry: number;
  /** How full the model's context window is: 0..1, past 1 when over. */
  strain: number;
  think: boolean;
  hover: boolean;
  /** Reaching for a table being dragged: 0.5 while it is anywhere, 1 when it is over Star. */
  reach: number;
  /** Arms jitter: generated SQL is running with nobody reviewing it (YOLO). */
  rattle: boolean;
  /** Horizontal speed, for the arms to trail behind. */
  vx: number;
  /** Reading glasses, px from where they sit: 0 on, positive slid down its nose, WEAR.specsOff gone. */
  specs: number;
  /** Sunglasses: 1 down over its eyes, WEAR.shadesOff flipped up and gone. */
  shades: number;
  /** A glint sweeping across the sunglasses as they come down, 0..1. */
  shine: number;
  /** The lower right arm lifted off the edge, 0..1: it taps while a query takes its time. */
  tap: number;
  /** Paws up over its eyes, 0..1: bracing for a statement that destroys data. */
  cover: number;
  /** How far apart the paws are: 0 shut over its eyes, 1 parted to peek between. */
  part: number;
  /** A bead of sweat: the statement being written would change every row. */
  sweat: boolean;
  /** Holding its breath through an open transaction, 0..1: puffed up, mouth pressed shut. */
  hold: number;
  /** The fedora it wears on production connections, px from where it sits: 0 on, WEAR.hatOff gone. */
  hat: number;
  reduced: boolean;
}

/** Star at rest, looking straight ahead: for still previews. */
export const AT_REST: StarState = {
  t: 0, dt: 0, ex: 0, ey: 0, cross: 0, open: 1, widen: 1, joy: 0, wince: 0, worry: 0, strain: 0,
  think: false, hover: false, reach: 0, rattle: false, vx: 0,
  specs: WEAR.specsOff, shades: WEAR.shadesOff, shine: 0, tap: 0, cover: 0, part: 1,
  sweat: false, hold: 0, hat: WEAR.hatOff, reduced: true,
};

export type StarGesture =
  | 'hello' | 'happy' | 'land' | 'attend' | 'nudge' | 'stretch' | 'yawn' | 'shrug' | 'rewind' | 'wipe';

export interface StarArt {
  springs: Spring[];
  /** True while it needs frames even with every spring at rest. */
  busy(st: StarState): boolean;
  /** `strength` (0..1) scales the landing wobble. */
  gesture(name: StarGesture, strength?: number): void;
  render(st: StarState): void;
}

/** Arm angles, degrees counter-clockwise from the right: one straight up, as in the logo. */
const ARMS = [90, 30, -30, -90, -150, 150];
const ARM_LENGTH = 23;
const CORE = 14.6;
const EY = 31;
const XL = 27.6;
const XR = 36.4;
const MY = 38.2;
/**
 * The paws it covers its eyes with: the two arms that hold the edge, brought
 * up in front of its face. Each runs from where its hand was, below the edge,
 * to a tip over one eye: [base x, base y, tip x, tip y].
 */
const PAWS: [number, number, number, number][] = [
  [STAR.hands[0], 54, XL + 0.6, EY],
  [STAR.hands[1], 54, XR - 0.6, EY],
];
/** How far each paw moves out to peek between them, px. */
const PAW_PART = 4.6;
/** Where the bead of sweat forms (its right temple, between the top and upper right arms), and how big it is. */
const SWEAT = { x: 42.6, y: 20.4, scale: 1.3 };
/** The fedora: how far below the top of its head the brim sits, px, and how much bigger than drawn. */
const HAT = { seat: 3, scale: 1.45 };
const BLUSH = 'rgba(255,128,140,0.34)';
/** Reading-glasses lens half-sizes [rx, ry] for each kind of eye, so the frames clear what they sit over. */
const LENS: Record<DrawnLook['eyes'], [number, number]> = {
  cutout: [3.9, 4.1],
  bubble: [4.2, 5.5],
  lines: [3.6, 3.9],
  none: [3.8, 3.8],
};
/** Sunglasses' top bar and lens bottom, relative to the eyes: tall glossy eyes need deeper lenses. */
const SHADE_DEPTH: Record<DrawnLook['eyes'], [number, number]> = {
  cutout: [-3.6, 3.4],
  bubble: [-4.9, 4.7],
  lines: [-3.5, 3.3],
  none: [-3.5, 3.3],
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const fade = (el: Element | null, v: number) => el?.setAttribute('opacity', clamp(v, 0, 1).toFixed(3));
/** Degrees between two angles, 0..180. */
const apart = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

export function makeStar(
  svg: SVGSVGElement,
  uid: string,
  look: DrawnLook,
  later: (fn: () => void, ms: number) => void,
): StarArt {
  const C = STAR_COLORS[look.color];
  const cut = look.eyes === 'cutout';
  const hasFace = look.eyes !== 'none';
  // A cut-out face is drawn in black inside a mask: black is cut out of the body.
  const ink = cut ? '#000' : C.ink;

  let defs = '';
  let eyes = '';
  if (look.eyes === 'bubble') {
    defs += [XL, XR]
      .map((x, i) => `<clipPath id="${uid}-c${i}"><ellipse cx="${x}" cy="${EY}" rx="3.3" ry="4.7"/></clipPath>`)
      .join('');
    eyes = [XL, XR]
      .map(
        (x, i) =>
          `<g class="eye"><g clip-path="url(#${uid}-c${i})"><ellipse class="pupil" cx="${x}" cy="${EY}" rx="2.6" ry="3.8" fill="${ink}"/><circle cx="${x - 0.9}" cy="${EY - 1.6}" r="0.95" fill="#fff"/><rect class="lid" x="${x - 3.8}" y="${EY - 4.8}" width="7.6" height="0" fill="${C.body}"/></g></g>`,
      )
      .join('');
  } else if (cut) {
    eyes = [XL, XR].map(x => `<g class="eye"><ellipse class="pupil" cx="${x}" cy="${EY}" rx="2.3" ry="3.2" fill="${ink}"/></g>`).join('');
  } else if (look.eyes === 'lines') {
    eyes = [XL, XR]
      .map(x => `<g class="eye"><rect class="pupil" x="${x - 0.95}" y="${EY - 2.8}" width="1.9" height="5.6" rx="0.95" fill="${ink}"/></g>`)
      .join('');
  }
  const arc = (x: number) => `M${x - 2.4} ${EY + 0.9} Q${x} ${EY - 2.7} ${x + 2.4} ${EY + 0.9}`;
  const chevron = (x: number, d: number) => `M${x - 1.8 * d} ${EY - 2} L${x + 1.8 * d} ${EY} L${x - 1.8 * d} ${EY + 2}`;
  const mouth = look.mouth
    ? `<path class="m-neutral" d="M29.6 ${MY - 0.8} Q32 ${MY + 1.1} 34.4 ${MY - 0.8}" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>
       <path class="m-happy" opacity="0" d="M28.7 ${MY - 1.5} Q32 ${MY + 3.9} 35.3 ${MY - 1.5} Z" fill="${ink}"/>
       <path class="m-wince" opacity="0" d="M29 ${MY} Q30.5 ${MY - 1.3} 32 ${MY} Q33.5 ${MY + 1.3} 35 ${MY}" fill="none" stroke="${ink}" stroke-width="1.45" stroke-linecap="round"/>
       <ellipse class="m-worry" opacity="0" cx="32" cy="${MY}" rx="1.4" ry="1.8" fill="${ink}"/>
       <path class="m-think" opacity="0" d="M29.9 ${MY} L34.1 ${MY - 0.5}" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>
       <ellipse class="m-yawn" opacity="0" cx="32" cy="${MY + 0.4}" rx="1.6" ry="0.6" fill="${ink}"/>
       <path class="m-hold" opacity="0" d="M30.1 ${MY} L33.9 ${MY}" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>`
    : '';
  const face = hasFace
    ? `<g class="eyes">${eyes}</g>
       <g class="joy" opacity="0" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"><path d="${arc(XL)}"/><path d="${arc(XR)}"/></g>
       <g class="wince" opacity="0" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${chevron(XL, 1)}"/><path d="${chevron(XR, -1)}"/></g>
       <g class="brows" opacity="0" fill="none" stroke="${ink}" stroke-width="1.45" stroke-linecap="round"><path d="M${XL - 2.4} ${EY - 4.4} L${XL + 2.2} ${EY - 5.6}"/><path d="M${XR + 2.4} ${EY - 4.4} L${XR - 2.2} ${EY - 5.6}"/></g>
       ${mouth}`
    : '';
  // Cheeks blush when it is pleased; not on a cut-out face or a dark body.
  const blush =
    hasFace && !cut && look.color !== 'graphite'
      ? [-1, 1].map(s => `<ellipse class="blush" cx="${32 + s * 8.8}" cy="35.8" rx="2.6" ry="1.5" fill="${BLUSH}" opacity="0"/>`).join('')
      : '';
  const arms = (cls: string, stroke: string, width: number) =>
    ARMS.map(() => `<line class="${cls}" x1="32" y1="32" x2="32" y2="32" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`).join('');
  if (cut) {
    defs += `<mask id="${uid}-face" maskUnits="userSpaceOnUse" x="-40" y="-40" width="144" height="144"><rect x="-40" y="-40" width="144" height="144" fill="#fff"/><g class="face">${face}</g></mask>`;
  }

  // Glasses go on top of everything, a cut-out face included. Reading
  // glasses are thin round frames in the face's ink.
  const [rx, ry] = LENS[look.eyes];
  const specs = `<g class="specs" opacity="0" fill="none" stroke="${C.ink}" stroke-width="1.15" stroke-linecap="round">
      <ellipse cx="${XL}" cy="${EY}" rx="${rx}" ry="${ry}"/><ellipse cx="${XR}" cy="${EY}" rx="${rx}" ry="${ry}"/>
      <path d="M${XL + rx - 0.3} ${EY - 1} Q32 ${EY - 2.6} ${XR - rx + 0.3} ${EY - 1}"/>
      <path d="M${XL - rx} ${EY - 0.8} L${XL - rx - 3} ${EY - 1.7}"/><path d="M${XR + rx} ${EY - 0.8} L${XR + rx + 3} ${EY - 1.7}"/>
    </g>`;
  // Sunglasses are dark whatever colour Star is; on the graphite body a light
  // rim keeps them readable. The right lens is the left one mirrored.
  const [top, bottom] = SHADE_DEPTH[look.eyes];
  const barY = EY + top, lensBottom = EY + bottom, mid = barY + (bottom - top) * 0.45;
  const ox = XL - 4.6, ix = XL + 3.9;
  const lensL = `M${ox} ${barY} L${ix} ${barY} L${ix - 0.3} ${mid} Q${ix - 0.9} ${lensBottom} ${XL - 0.3} ${lensBottom} Q${ox + 0.4} ${lensBottom} ${ox + 0.1} ${mid} Z`;
  const mirror = 'matrix(-1 0 0 1 64 0)';
  const dark = '#141416';
  const rim = look.color === 'graphite' ? C.line : dark;
  defs += `<clipPath id="${uid}-shades"><path d="${lensL}"/><path d="${lensL}" transform="${mirror}"/></clipPath>`;
  const shades = `<g class="shades" opacity="0">
      <g stroke="${dark}" stroke-width="1.3" stroke-linecap="round"><path d="M${ox - 0.4} ${barY + 0.3} L${ox - 3.4} ${barY - 0.5}"/><path d="M${64 - ox + 0.4} ${barY + 0.3} L${64 - ox + 3.4} ${barY - 0.5}"/></g>
      <g fill="${dark}" stroke="${rim}" stroke-width="0.7" stroke-linejoin="round"><path d="${lensL}"/><path d="${lensL}" transform="${mirror}"/></g>
      <path d="M${ox - 0.6} ${barY} L${64 - ox + 0.6} ${barY}" stroke="${dark}" stroke-width="1.8" stroke-linecap="round"/>
      <g stroke="#fff" stroke-opacity="0.45" stroke-width="0.9" stroke-linecap="round"><path d="M${ox + 1.5} ${barY + 2.7} L${ox + 2.9} ${barY + 1.3}"/><path d="M${XR - 3.1} ${barY + 2.7} L${XR - 1.7} ${barY + 1.3}"/></g>
      <g clip-path="url(#${uid}-shades)"><rect class="shine" x="-1.6" y="${barY - 2}" width="3.2" height="${bottom - top + 4}" fill="#fff" opacity="0"/></g>
    </g>`;
  // A bead of sweat on its right temple. It runs down and forms again by CSS
  // (.star-sweat in index.css), so sweating over a long edit does not keep the
  // frame loop awake.
  const sweat = `<g class="sweat-at" style="display:none" transform="translate(${SWEAT.x} ${SWEAT.y}) scale(${SWEAT.scale})"><g class="star-sweat">
      <path d="M0 -2.7 C1.3 -0.9 2 0.4 2 1.3 A2 2 0 0 1 -2 1.3 C-2 0.4 -1.3 -0.9 0 -2.7 Z" fill="#8fd0ff" stroke="${look.color === 'graphite' ? 'none' : 'rgba(16,16,18,0.4)'}" stroke-width="0.5"/>
      <path d="M-0.9 0.4 Q-1 1.4 -0.2 1.9" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="0.55" stroke-linecap="round"/>
    </g></g>`;
  // A detective's fedora for production, cocked to one side, sitting on its
  // head with the top arm tucked away under it (see render). In Star's own
  // colours: a white hat with a black band
  // on white Star, the reverse on graphite. A tapered crown with a soft pinch
  // at the top, and a snap brim: up at the back, dipped at the front. Drawn
  // with the brim at about y 0.
  const hat = `<g class="hat" opacity="0"><g transform="rotate(-8 32 0)" stroke="${C.line}" stroke-width="0.7" stroke-linejoin="round">
      <path d="M26 -1.2 C26.3 -4.6 26.6 -7.4 27.6 -8.6 Q29.8 -9.6 32 -8.7 Q34.2 -9.6 36.4 -8.6 C37.4 -7.4 37.7 -4.6 38 -1.2 Z" fill="${C.body}"/>
      <path d="M26.32 -5 L37.68 -5 L37.88 -2.2 L26.12 -2.2 Z" fill="${C.ink}" stroke="none"/>
      <path d="M20.3 -0.9 Q24 -2.3 32 -2.3 Q40 -2.3 43.7 -0.9 Q41 1.9 32 1.9 Q23 1.9 20.3 -0.9 Z" fill="${C.body}"/>
    </g></g>`;
  // Paws over everything, drawn like arms.
  const paws = `<g class="paws" opacity="0" stroke-linecap="round">${PAWS.map(
    ([bx, by, tx, ty]) =>
      `<g class="paw"><line x1="${bx}" y1="${by}" x2="${tx}" y2="${ty}" stroke="${C.line}" stroke-width="10.8"/><line x1="${bx}" y1="${by}" x2="${tx}" y2="${ty}" stroke="${C.body}" stroke-width="8.6"/></g>`,
  ).join('')}</g>`;

  svg.innerHTML = `<defs>${defs}</defs>
    <g${cut ? ` mask="url(#${uid}-face)"` : ''}>
      ${arms('arm-out', C.line, 10.8)}
      <circle class="core-out" cx="32" cy="32" r="${CORE + 1.1}" fill="${C.line}"/>
      ${arms('arm-in', C.body, 8.6)}
      <circle class="core" cx="32" cy="32" r="${CORE}" fill="${C.body}"/>
    </g>
    ${blush}${cut ? '' : `<g class="face">${face}</g>`}${sweat}${specs}${shades}${hat}${paws}`;

  const all = (s: string) => Array.from(svg.querySelectorAll(s));
  const one = (s: string) => svg.querySelector(s);
  const out = all('.arm-out'), inn = all('.arm-in');
  const core = one('.core')!, coreOut = one('.core-out')!, faceG = one('.face');
  const eyeGroups = all('.eye'), pupils = all('.eye .pupil'), lids = all('.eye .lid');
  const joy = one('.joy'), wince = one('.wince'), brows = one('.brows'), blushes = all('.blush');
  const specsG = one('.specs'), shadesG = one('.shades'), shine = one('.shine');
  const pawsG = one('.paws'), pawGroups = all('.paw');
  const sweatAt = one('.sweat-at') as SVGGElement | null, hatG = one('.hat');
  const m = {
    neutral: one('.m-neutral'), happy: one('.m-happy'), wince: one('.m-wince'),
    worry: one('.m-worry'), think: one('.m-think'), yawn: one('.m-yawn'), hold: one('.m-hold'),
  };
  const base = pupils.map(p => ({
    ry: Number(p.getAttribute('ry')),
    h: Number(p.getAttribute('height')),
    y: Number(p.getAttribute('y')),
  }));

  const s = {
    /** Turns while it works, like a progress indicator. */
    spin: new Spring(0, { response: 0.55, damping: 0.5, precision: 0.05 }),
    /** Arms trail behind when it moves. */
    lag: new Spring(0, { response: 0.32, damping: 0.42, precision: 0.05 }),
    /** One arm waves hello. */
    wave: new Spring(0, { response: 0.2, damping: 0.22, precision: 0.05 }),
    /** Arms droop when something goes wrong. */
    droop: new Spring(0, { response: 0.4, damping: 0.7, precision: 0.002 }),
    /** The upper arms reach for a table being dragged over. */
    reach: new Spring(0, { response: 0.3, damping: 0.6, precision: 0.002 }),
    /** A stretch: arms long, the upper ones raised. */
    extend: new Spring(0, { response: 0.55, damping: 0.75, precision: 0.002 }),
    /** A yawn: the mouth, when it has one, opens wide. */
    yawn: new Spring(0, { response: 0.5, damping: 0.85, precision: 0.002 }),
    /** Arm length wobble, px: they compress and rebound on landing. */
    splay: new Spring(0, { response: 0.24, damping: 0.3, precision: 0.02 }),
    /** A shrug: the upper side arms lift. */
    shrug: new Spring(0, { response: 0.3, damping: 0.6, precision: 0.002 }),
  };
  let free = 0;
  let spinning = false;

  return {
    springs: Object.values(s),
    busy: st => st.think || st.rattle,
    gesture(name, strength = 1) {
      if (name === 'happy') s.spin.target = Math.round(s.spin.target / 60) * 60 + 60;
      // The happy spin played backwards, and further: a rewind.
      if (name === 'rewind') {
        s.spin.target = Math.round(s.spin.target / 60) * 60 - 120;
        s.spin.velocity -= 200;
      }
      // A shrug is quick: up, a beat, down. Held longer it reads as hands up.
      if (name === 'shrug') { s.shrug.target = 1; later(() => { s.shrug.target = 0; }, 420); }
      if (name === 'hello') { s.wave.velocity += 520; later(() => { s.wave.velocity -= 460; }, 260); }
      if (name === 'attend') s.wave.velocity += 240;
      // Wiping its brow: the upper right arm sweeps up across its temple.
      if (name === 'wipe') { s.wave.velocity += 460; later(() => { s.wave.velocity -= 200; }, 200); }
      // Pushing its glasses up: a quick flick of the same arm, in time with them.
      if (name === 'nudge') s.wave.velocity += 300;
      if (name === 'land') {
        // The harder it lands, the more the arms swing and spring.
        s.lag.velocity += (Math.random() < 0.5 ? -1 : 1) * (40 + 140 * strength);
        s.splay.velocity -= 40 * strength;
      }
      if (name === 'stretch') { s.extend.target = 1; later(() => { s.extend.target = 0; }, 850); }
      if (name === 'yawn') {
        s.yawn.target = 1;
        s.extend.target = 0.55;
        later(() => { s.yawn.target = 0; s.extend.target = 0; }, 1150);
      }
    },
    render(st) {
      // Spins steadily while it writes SQL, then eases onto a symmetric pose.
      if (st.think && !st.reduced) { free += 170 * st.dt; s.spin.snap(free); spinning = true; }
      else if (spinning) { spinning = false; s.spin.velocity = 170; s.spin.target = Math.ceil(s.spin.value / 60) * 60; }
      else free = s.spin.value;
      s.lag.target = clamp(-st.vx * 0.025, -16, 16);
      s.droop.target = st.wince;
      s.reach.target = st.reach;

      // Without a face it looks around by turning, and twinkles where it would blink.
      const look = hasFace ? 0 : clamp(st.ex * 3.6, -13, 13);
      const twinkle = hasFace ? 1 : 0.9 + 0.1 * clamp(st.open, 0, 1);
      const tremble = st.reduced ? 0 : clamp((st.strain - 0.85) * 14, 0, 4);
      // The arm that waves is whichever one points up and to the right now.
      const nearest = (to: number) =>
        ARMS.reduce((best, a0, i) => (apart(a0 + s.spin.value, to) < apart(ARMS[best] + s.spin.value, to) ? i : best), 0);
      const waver = nearest(30);
      // The one that taps is whichever holds the edge on the right.
      const tapper = nearest(-30);
      const raise = Math.max(s.reach.value * 24, s.extend.value * 22, s.shrug.value * 15);
      // How far down the fedora has come, 0 off .. 1 on its head.
      const hatDown = clamp(1 - st.hat / WEAR.hatOff, 0, 1);
      ARMS.forEach((a0, i) => {
        let a = a0 + s.spin.value + s.lag.value + look;
        if (i === waver) a += s.wave.value;
        if (i === tapper) a += st.tap * 16;
        // Every arm sinks toward straight down, whichever way it points after spinning.
        a -= s.droop.value * 18 * Math.cos((a * Math.PI) / 180);
        // Reaching or stretching: the arms that point upward lift toward vertical.
        const up = Math.sin((a * Math.PI) / 180) > 0.3;
        if (up && raise > 0.05) a += clamp(((((90 - a) % 360) + 540) % 360) - 180, -raise, raise);
        if (tremble) a += rand(-1, 1) * tremble;
        if (st.rattle && !st.reduced) a += rand(-7, 7);
        // Holding its breath, it pulls its arms in a little.
        let length =
          (ARM_LENGTH + 3.4 * st.strain + 4.5 * s.extend.value + s.splay.value - 1.5 * st.hold + (up ? 3 * s.reach.value : 0)) * twinkle;
        // Covering its eyes, the lower arms are the paws: they draw in out of sight.
        if (st.cover > 0.001 && Math.sin((a * Math.PI) / 180) < -0.3) length += (CORE * 0.7 - length) * clamp(st.cover, 0, 1);
        // Under the fedora, the arm that points up tucks away as the hat comes
        // down. By how near it is to straight up, so while it spins each arm
        // ducks under the brim as it passes.
        if (hatDown > 0.001) {
          const under = clamp(1 - apart(a, 90) / 40, 0, 1);
          if (under > 0) length += (CORE * 0.7 - length) * hatDown * under;
        }
        const r = (a * Math.PI) / 180;
        const x2 = (32 + length * Math.cos(r)).toFixed(2), y2 = (32 - length * Math.sin(r)).toFixed(2);
        out[i].setAttribute('x2', x2); out[i].setAttribute('y2', y2);
        inn[i].setAttribute('x2', x2); inn[i].setAttribute('y2', y2);
      });
      // A fuller prompt swells the center; so does a held breath.
      const R = CORE * (1 + 0.07 * st.strain + 0.06 * st.hold);
      core.setAttribute('r', R.toFixed(2));
      coreOut.setAttribute('r', (R + 1.1).toFixed(2));

      // The fedora sits on its head, however swollen the center is just now.
      const hatShown = clamp((st.hat - WEAR.hatOff) / 12, 0, 1);
      fade(hatG, hatShown);
      if (hatShown > 0) {
        hatG?.setAttribute(
          'transform',
          `translate(0 ${(32 - R + HAT.seat + st.hat).toFixed(2)}) translate(32 0) scale(${HAT.scale}) translate(-32 0)`,
        );
      }

      // The bead of sweat sits on the face, so it moves with the gaze.
      if (sweatAt) {
        sweatAt.style.display = st.sweat ? '' : 'none';
        // Under a fedora's brim it forms a little lower.
        if (st.sweat) sweatAt.setAttribute('transform', `translate(${(SWEAT.x + st.ex * 0.35).toFixed(2)} ${(SWEAT.y + 3.6 * hatDown + st.ey * 0.3).toFixed(2)}) scale(${SWEAT.scale})`);
      }

      // Glasses sit on the face and move with it, so the eyes look around behind the lenses.
      const gx = (st.ex * 0.35).toFixed(2);
      const specsShown = clamp((st.specs - WEAR.specsOff) / 14, 0, 1);
      fade(specsG, specsShown);
      if (specsShown > 0) specsG?.setAttribute('transform', `translate(${gx} ${(st.ey * 0.3 + st.specs).toFixed(2)})`);
      const shadesShown = clamp((st.shades - WEAR.shadesOff) / 0.45, 0, 1);
      fade(shadesG, shadesShown);
      if (shadesShown > 0) {
        // They flip down about their top bar, and a glint crosses the lenses as they settle.
        shadesG?.setAttribute(
          'transform',
          `translate(${gx} ${(st.ey * 0.3 + barY).toFixed(2)}) scale(1 ${st.shades.toFixed(3)}) translate(0 ${-barY})`,
        );
        shine?.setAttribute('transform', `translate(${(28 + 28 * st.shine).toFixed(2)} 0) skewX(-18)`);
        fade(shine, st.shine > 0.001 && st.shine < 0.999 ? 0.6 : 0);
      }

      // Paws slide up from behind the edge along their own length, then part to peek.
      fade(pawsG, st.cover * 4);
      if (st.cover > 0.001) {
        pawGroups.forEach((g, i) => {
          const [bx, by, tx, ty] = PAWS[i];
          const len = Math.hypot(bx - tx, by - ty);
          const back = (1 - st.cover) * len;
          const spread = (i === 0 ? -1 : 1) * PAW_PART * st.part;
          g.setAttribute('transform', `translate(${(((bx - tx) / len) * back + spread).toFixed(2)} ${(((by - ty) / len) * back).toFixed(2)})`);
        });
      }
      if (!faceG) return;

      faceG.setAttribute('transform', `translate(${(st.ex * 0.35).toFixed(2)} ${(st.ey * 0.3).toFixed(2)})`);
      const expression = clamp(Math.max(st.joy, st.wince), 0, 1);
      const open = clamp(st.open, 0, 1);
      eyeGroups.forEach((g, i) => {
        // The left eye is first. Crossed, each moves in toward the nose and
        // leans in, one a touch lower than the other: a dot eye has no white
        // to turn a pupil in, so this is what reads as cross-eyed.
        const inward = i === 0 ? 1 : -1;
        const x = st.ex * 0.55 + inward * st.cross * 1.6;
        const y = st.ey * 0.5 + st.cross * (i === 0 ? 0.25 : 0.75);
        const lean = inward * st.cross * 14;
        g.setAttribute(
          'transform',
          `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${lean.toFixed(1)} ${i === 0 ? XL : XR} ${EY})`,
        );
        fade(g, 1 - expression);
      });
      pupils.forEach((p, i) => {
        if (lids[i]) {
          // Glossy eyes close with a lid instead of squashing.
          p.setAttribute('ry', (base[i].ry * (1 + (st.widen - 1) * 0.7)).toFixed(2));
          lids[i].setAttribute('height', ((1 - open) * (base[i].ry * 2 + 1.8)).toFixed(2));
        } else if (p.tagName === 'rect') {
          const h = base[i].h * Math.max(0.11, open) * st.widen;
          p.setAttribute('height', h.toFixed(2));
          p.setAttribute('y', (base[i].y + (base[i].h - h) / 2).toFixed(2));
        } else {
          p.setAttribute('ry', (base[i].ry * Math.max(0.12, open) * st.widen).toFixed(2));
        }
      });
      const at = `translate(${(st.ex * 0.5).toFixed(2)} ${(st.ey * 0.5).toFixed(2)})`;
      joy?.setAttribute('transform', at); fade(joy, st.joy);
      wince?.setAttribute('transform', at); fade(wince, st.wince * (1 - st.joy));
      fade(brows, st.worry * (1 - Math.max(st.joy, st.wince)));
      brows?.setAttribute('transform', `translate(${(st.ex * 0.3).toFixed(2)} ${(st.ey * 0.25 - st.worry * 0.6).toFixed(2)})`);
      // Cheeks colour when it is pleased, and while it holds its breath.
      blushes.forEach(b => fade(b, st.joy * 0.95 + (st.hover ? 0.3 : 0) + st.hold * 0.5));

      if (m.neutral) {
        // Crossfade the mouths: a yawn, happy, wince, held breath, worried, thinking, or neutral.
        const yawning = clamp(s.yawn.value, 0, 1);
        const happy = clamp(st.joy, 0, 1) * (1 - yawning);
        const hurt = clamp(st.wince, 0, 1) * (1 - Math.max(happy, yawning));
        const holding = clamp(st.hold, 0, 1) * (1 - Math.max(happy, hurt, yawning));
        const worried = clamp(st.worry, 0, 1) * (1 - Math.max(happy, hurt, holding, yawning));
        const thinking = (st.think ? 1 : 0) * (1 - Math.max(happy, hurt, holding, worried, yawning));
        fade(m.yawn, yawning);
        fade(m.hold, holding);
        if (yawning > 0.01) {
          m.yawn?.setAttribute('rx', (1.6 + 1.1 * yawning).toFixed(2));
          m.yawn?.setAttribute('ry', (0.6 + 3 * yawning).toFixed(2));
        }
        fade(m.happy, happy);
        fade(m.wince, hurt);
        fade(m.worry, worried);
        fade(m.think, thinking);
        fade(m.neutral, 1 - Math.max(happy, hurt, holding, worried, thinking, yawning));
      }
    },
  };
}
