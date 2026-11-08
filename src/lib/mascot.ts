// State for Star, the Text-to-SQL mascot. A tiny external store so the
// dialogs, the SQL editor and the mascot itself can share it without context
// plumbing; components read it with useMascot().

import { useSyncExternalStore } from 'react';

export type MascotMood = 'idle' | 'listening' | 'thinking' | 'happy' | 'error';
/** Where it peeks from: the status bar, the Text-to-SQL dialog, or the approval dialog. */
export type MascotPerch = 'home' | 'dialog' | 'approval';
/** One-off moves, as opposed to the moods it holds. */
export type MascotGesture = 'exhale' | 'nod' | 'shake' | 'rattle';

/** How Star looks: a preference, chosen in Settings and kept on this device. */
export interface StarLook {
  color: 'white' | 'graphite';
  eyes: 'cutout' | 'bubble' | 'lines' | 'none';
  mouth: boolean;
}
export const DEFAULT_LOOK: StarLook = { color: 'white', eyes: 'cutout', mouth: false };
const LOOK_KEY = 'litedb.star.look';

/** Whether Star shows at all, and whether it talks. */
export interface StarPrefs {
  visible: boolean;
  bubbles: boolean;
}
export const DEFAULT_PREFS: StarPrefs = { visible: true, bubbles: true };
const PREFS_KEY = 'litedb.star.prefs';

/** What Star offers when clicked after a query failed. */
export interface HelpOffer {
  explain: () => void;
  fix: () => void;
}

type Point = { x: number; y: number };

function loadLook(): StarLook {
  try {
    const saved = JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null') as Partial<StarLook> | null;
    if (!saved) return DEFAULT_LOOK;
    return {
      color: ['white', 'graphite'].includes(saved.color as string) ? (saved.color as StarLook['color']) : DEFAULT_LOOK.color,
      eyes: ['cutout', 'bubble', 'lines', 'none'].includes(saved.eyes as string) ? (saved.eyes as StarLook['eyes']) : DEFAULT_LOOK.eyes,
      mouth: typeof saved.mouth === 'boolean' ? saved.mouth : DEFAULT_LOOK.mouth,
    };
  } catch {
    return DEFAULT_LOOK;
  }
}

function loadPrefs(): StarPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<StarPrefs> | null;
    return {
      visible: typeof saved?.visible === 'boolean' ? saved.visible : DEFAULT_PREFS.visible,
      bubbles: typeof saved?.bubbles === 'boolean' ? saved.bubbles : DEFAULT_PREFS.bubbles,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: the change still applies for this session.
  }
}

export interface MascotState {
  mood: MascotMood;
  perch: MascotPerch;
  /** A point to look at instead of the cursor: the caret while typing, or something that just changed. */
  gaze: Point | null;
  /** A short line in its speech bubble. */
  say: string | null;
  /** How full the model's context window is: 0..1, past 1 when the prompt won't fit. */
  strain: number;
  look: StarLook;
  prefs: StarPrefs;
  /** Set while the last query in the SQL editor failed: clicking Star offers to explain or fix it. */
  help: HelpOffer | null;
}

let state: MascotState = {
  mood: 'idle',
  perch: 'home',
  gaze: null,
  say: null,
  strain: 0,
  look: loadLook(),
  prefs: loadPrefs(),
  help: null,
};
const listeners = new Set<() => void>();
const gestureListeners = new Set<(gesture: MascotGesture) => void>();
const timers: Partial<Record<'mood' | 'gaze' | 'say' | 'glance', ReturnType<typeof setTimeout>>> = {};

function set(patch: Partial<MascotState>) {
  state = { ...state, ...patch };
  listeners.forEach(fn => fn());
}

function later(key: keyof typeof timers, ms: number, fn: () => void) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

/** The mood it settles back to: attentive on a dialog, at rest otherwise. */
const restingMood = (): MascotMood => (state.perch === 'home' ? 'idle' : 'listening');

// --- perches -------------------------------------------------------------------------
// A stack, so a dialog opened over another dialog hands Star back when it closes.
const perches: { perch: MascotPerch }[] = [];

function applyPerch() {
  const perch = perches.length ? perches[perches.length - 1].perch : 'home';
  if (perch === state.perch) return;
  const mood =
    state.mood === 'thinking' ? 'thinking'
    : perch !== 'home' ? 'listening'
    : state.mood === 'listening' ? 'idle'
    : state.mood;
  set({ perch, gaze: null, mood });
}

// --- attention -------------------------------------------------------------------------
// Two kinds of looking. Following (the caret while typing) is continuous and
// cheap. Glancing is something changing (a toast, results, a button coming
// alive): it takes over for a moment, and following resumes after it.
let follow: { point: Point; until: number } | null = null;
let glancing = false;
const glanceQueue: { point: Point; ms: number }[] = [];

function pointOf(target: Element | Point | null | undefined): Point | null {
  if (!target) return null;
  if (!('getBoundingClientRect' in target)) return target;
  if (!target.isConnected) return null;
  const r = target.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function startGlance(point: Point, ms: number) {
  glancing = true;
  set({ gaze: point });
  later('glance', ms, () => {
    const next = glanceQueue.shift();
    if (next) {
      startGlance(next.point, next.ms);
      return;
    }
    glancing = false;
    const resume = follow && follow.until > Date.now() ? follow.point : null;
    set({ gaze: resume });
    if (resume && follow) later('gaze', follow.until - Date.now(), () => set({ gaze: null }));
  });
}

export const mascot = {
  get: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  /** Perch on a dialog while it is open; call the returned function when it closes. */
  perchOn(perch: Exclude<MascotPerch, 'home'>) {
    const entry = { perch };
    perches.push(entry);
    applyPerch();
    return () => {
      const i = perches.indexOf(entry);
      if (i >= 0) perches.splice(i, 1);
      applyPerch();
    };
  },
  /** Set a mood; with `forMs` it returns to resting afterwards. */
  setMood(mood: MascotMood, forMs?: number) {
    clearTimeout(timers.mood);
    set({ mood });
    if (forMs) later('mood', forMs, () => set({ mood: restingMood() }));
  },
  /** Follow a point for a while (the caret while typing), then go back to the cursor. */
  lookAt(point: Point, forMs = 1200) {
    follow = { point, until: Date.now() + forMs };
    if (glancing) return;
    set({ gaze: point });
    later('gaze', forMs, () => set({ gaze: null }));
  },
  /** Something changed over there: look at it for a moment, then back. Queued behind a glance in progress. */
  glance(target: Element | Point | null | undefined, forMs = 900) {
    const point = pointOf(target);
    if (!point) return;
    if (glancing) {
      glanceQueue.push({ point, ms: forMs });
      if (glanceQueue.length > 2) glanceQueue.shift();
      return;
    }
    clearTimeout(timers.gaze);
    startGlance(point, forMs);
  },
  say(text: string | null, forMs = 2400) {
    clearTimeout(timers.say);
    set({ say: text });
    if (text) later('say', forMs, () => set({ say: null }));
  },
  /** Context window use from the Text-to-SQL meter; 0 when the meter is closed. */
  setStrain(strain: number) {
    const next = Math.round(Math.max(0, strain) * 100) / 100;
    if (next !== state.strain) set({ strain: next });
  },
  setLook(patch: Partial<StarLook>) {
    const look = { ...state.look, ...patch };
    persist(LOOK_KEY, look);
    set({ look });
  },
  setPrefs(patch: Partial<StarPrefs>) {
    const prefs = { ...state.prefs, ...patch };
    persist(PREFS_KEY, prefs);
    set({ prefs, say: prefs.bubbles ? state.say : null });
  },
  /** Offer help with a failed query, or withdraw the offer (null). */
  offerHelp(help: HelpOffer | null) {
    if (help !== state.help) set({ help });
  },
  gesture(gesture: MascotGesture) {
    gestureListeners.forEach(fn => fn(gesture));
  },
  onGesture(fn: (gesture: MascotGesture) => void) {
    gestureListeners.add(fn);
    return () => {
      gestureListeners.delete(fn);
    };
  },
};

export function useMascot(): MascotState {
  return useSyncExternalStore(mascot.subscribe, mascot.get, mascot.get);
}
