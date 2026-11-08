// Star, the Text-to-SQL mascot: the asterisk from LiteDB's logo, and from
// SELECT *. Six round arms around a large center. Its colour, eyes and mouth
// are a preference (Settings → Star); by default it is white, with its eyes
// cut out of the body so whatever is behind it shows through, and no mouth.
//
// This file draws Star and animates its own parts (arms, eyes, mouth) from the
// state the rig in ./motion.ts computes each frame.

import { Spring } from '@/lib/spring';
import type { StarLook } from '@/lib/mascot';

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
  /** Top-left corner of the read-only padlock (13×15), beside the top-right arm. */
  badge: { x: 48, y: 2 },
  /** Where puffs of air leave when it exhales. */
  puffs: [[24, 8], [32, 4], [40, 8]] as [number, number][],
};

export const STAR_COLORS: Record<StarLook['color'], { body: string; line: string; ink: string }> = {
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
  reduced: boolean;
}

/** Star at rest, looking straight ahead: for still previews. */
export const AT_REST: StarState = {
  t: 0, dt: 0, ex: 0, ey: 0, open: 1, widen: 1, joy: 0, wince: 0, worry: 0, strain: 0,
  think: false, hover: false, reach: 0, rattle: false, vx: 0, reduced: true,
};

export type StarGesture = 'hello' | 'happy' | 'land' | 'attend' | 'stretch' | 'yawn';

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
const BLUSH = 'rgba(255,128,140,0.34)';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const fade = (el: Element | null, v: number) => el?.setAttribute('opacity', clamp(v, 0, 1).toFixed(3));
/** Degrees between two angles, 0..180. */
const apart = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

export function makeStar(
  svg: SVGSVGElement,
  uid: string,
  look: StarLook,
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
       <ellipse class="m-yawn" opacity="0" cx="32" cy="${MY + 0.4}" rx="1.6" ry="0.6" fill="${ink}"/>`
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
  svg.innerHTML = `<defs>${defs}</defs>
    <g${cut ? ` mask="url(#${uid}-face)"` : ''}>
      ${arms('arm-out', C.line, 10.8)}
      <circle class="core-out" cx="32" cy="32" r="${CORE + 1.1}" fill="${C.line}"/>
      ${arms('arm-in', C.body, 8.6)}
      <circle class="core" cx="32" cy="32" r="${CORE}" fill="${C.body}"/>
    </g>
    ${blush}${cut ? '' : `<g class="face">${face}</g>`}`;

  const all = (s: string) => Array.from(svg.querySelectorAll(s));
  const one = (s: string) => svg.querySelector(s);
  const out = all('.arm-out'), inn = all('.arm-in');
  const core = one('.core')!, coreOut = one('.core-out')!, faceG = one('.face');
  const eyeGroups = all('.eye'), pupils = all('.eye .pupil'), lids = all('.eye .lid');
  const joy = one('.joy'), wince = one('.wince'), brows = one('.brows'), blushes = all('.blush');
  const m = {
    neutral: one('.m-neutral'), happy: one('.m-happy'), wince: one('.m-wince'),
    worry: one('.m-worry'), think: one('.m-think'), yawn: one('.m-yawn'),
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
  };
  let free = 0;
  let spinning = false;

  return {
    springs: Object.values(s),
    busy: st => st.think || st.rattle,
    gesture(name, strength = 1) {
      if (name === 'happy') s.spin.target = Math.round(s.spin.target / 60) * 60 + 60;
      if (name === 'hello') { s.wave.velocity += 520; later(() => { s.wave.velocity -= 460; }, 260); }
      if (name === 'attend') s.wave.velocity += 240;
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
      const waver = ARMS.reduce((best, a0, i) => (apart(a0 + s.spin.value, 30) < apart(ARMS[best] + s.spin.value, 30) ? i : best), 0);
      const raise = Math.max(s.reach.value * 24, s.extend.value * 22);
      ARMS.forEach((a0, i) => {
        let a = a0 + s.spin.value + s.lag.value + look;
        if (i === waver) a += s.wave.value;
        // Every arm sinks toward straight down, whichever way it points after spinning.
        a -= s.droop.value * 18 * Math.cos((a * Math.PI) / 180);
        // Reaching or stretching: the arms that point upward lift toward vertical.
        const up = Math.sin((a * Math.PI) / 180) > 0.3;
        if (up && raise > 0.05) a += clamp(((((90 - a) % 360) + 540) % 360) - 180, -raise, raise);
        if (tremble) a += rand(-1, 1) * tremble;
        if (st.rattle && !st.reduced) a += rand(-7, 7);
        const length =
          (ARM_LENGTH + 3.4 * st.strain + 4.5 * s.extend.value + s.splay.value + (up ? 3 * s.reach.value : 0)) * twinkle;
        const r = (a * Math.PI) / 180;
        const x2 = (32 + length * Math.cos(r)).toFixed(2), y2 = (32 - length * Math.sin(r)).toFixed(2);
        out[i].setAttribute('x2', x2); out[i].setAttribute('y2', y2);
        inn[i].setAttribute('x2', x2); inn[i].setAttribute('y2', y2);
      });
      // A fuller prompt swells the center.
      const R = CORE * (1 + 0.07 * st.strain);
      core.setAttribute('r', R.toFixed(2));
      coreOut.setAttribute('r', (R + 1.1).toFixed(2));
      if (!faceG) return;

      faceG.setAttribute('transform', `translate(${(st.ex * 0.35).toFixed(2)} ${(st.ey * 0.3).toFixed(2)})`);
      const expression = clamp(Math.max(st.joy, st.wince), 0, 1);
      const open = clamp(st.open, 0, 1);
      eyeGroups.forEach(g => {
        g.setAttribute('transform', `translate(${(st.ex * 0.55).toFixed(2)} ${(st.ey * 0.5).toFixed(2)})`);
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
      blushes.forEach(b => fade(b, st.joy * 0.95 + (st.hover ? 0.3 : 0)));

      if (m.neutral) {
        // Crossfade the mouths: a yawn, happy, wince, worried, thinking, or neutral.
        const yawning = clamp(s.yawn.value, 0, 1);
        const happy = clamp(st.joy, 0, 1) * (1 - yawning);
        const hurt = clamp(st.wince, 0, 1) * (1 - Math.max(happy, yawning));
        const worried = clamp(st.worry, 0, 1) * (1 - Math.max(happy, hurt, yawning));
        const thinking = (st.think ? 1 : 0) * (1 - Math.max(happy, hurt, worried, yawning));
        fade(m.yawn, yawning);
        if (yawning > 0.01) {
          m.yawn?.setAttribute('rx', (1.6 + 1.1 * yawning).toFixed(2));
          m.yawn?.setAttribute('ry', (0.6 + 3 * yawning).toFixed(2));
        }
        fade(m.happy, happy);
        fade(m.wince, hurt);
        fade(m.worry, worried);
        fade(m.think, thinking);
        fade(m.neutral, 1 - Math.max(happy, hurt, worried, thinking, yawning));
      }
    },
  };
}
