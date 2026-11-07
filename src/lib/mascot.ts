// State for Star, the Text-to-SQL mascot. A tiny external store so the
// dialog, the SQL editor and the mascot itself can share it without context
// plumbing; components read it with useMascot().

import { useSyncExternalStore } from 'react';

export type MascotMood = 'idle' | 'listening' | 'thinking' | 'happy' | 'error';
/** Where it peeks from: over the status bar, or over the Text-to-SQL dialog. */
export type MascotPerch = 'home' | 'dialog';
/** One-off moves, as opposed to the moods it holds. */
export type MascotGesture = 'exhale';

/** How Star looks: a preference, chosen in Settings and kept on this device. */
export interface StarLook {
  color: 'white' | 'amber' | 'graphite';
  eyes: 'cutout' | 'bubble' | 'dots' | 'lines' | 'none';
  mouth: boolean;
}
export const DEFAULT_LOOK: StarLook = { color: 'white', eyes: 'cutout', mouth: false };
const LOOK_KEY = 'litedb.star.look';

function loadLook(): StarLook {
  try {
    const saved = JSON.parse(localStorage.getItem(LOOK_KEY) ?? 'null') as Partial<StarLook> | null;
    if (!saved) return DEFAULT_LOOK;
    return {
      color: ['white', 'amber', 'graphite'].includes(saved.color as string) ? (saved.color as StarLook['color']) : DEFAULT_LOOK.color,
      eyes: ['cutout', 'bubble', 'dots', 'lines', 'none'].includes(saved.eyes as string) ? (saved.eyes as StarLook['eyes']) : DEFAULT_LOOK.eyes,
      mouth: typeof saved.mouth === 'boolean' ? saved.mouth : DEFAULT_LOOK.mouth,
    };
  } catch {
    return DEFAULT_LOOK;
  }
}

export interface MascotState {
  mood: MascotMood;
  perch: MascotPerch;
  /** A point to look at instead of the cursor (the caret while typing). */
  gaze: { x: number; y: number } | null;
  /** A short line in its speech bubble. */
  say: string | null;
  /** How full the model's context window is: 0..1, past 1 when the prompt won't fit. */
  strain: number;
  look: StarLook;
}

let state: MascotState = { mood: 'idle', perch: 'home', gaze: null, say: null, strain: 0, look: loadLook() };
const listeners = new Set<() => void>();
const gestureListeners = new Set<(gesture: MascotGesture) => void>();
const timers: Partial<Record<'mood' | 'gaze' | 'say', ReturnType<typeof setTimeout>>> = {};

function set(patch: Partial<MascotState>) {
  state = { ...state, ...patch };
  listeners.forEach(fn => fn());
}

function later(key: 'mood' | 'gaze' | 'say', ms: number, fn: () => void) {
  clearTimeout(timers[key]);
  timers[key] = setTimeout(fn, ms);
}

/** The mood it settles back to: attentive in the dialog, at rest otherwise. */
const restingMood = (): MascotMood => (state.perch === 'dialog' ? 'listening' : 'idle');

export const mascot = {
  get: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  setPerch(perch: MascotPerch) {
    if (perch === state.perch) return;
    set({ perch, gaze: null, mood: state.mood === 'thinking' ? state.mood : perch === 'dialog' ? 'listening' : state.mood });
  },
  /** Set a mood; with `forMs` it returns to resting afterwards. */
  setMood(mood: MascotMood, forMs?: number) {
    clearTimeout(timers.mood);
    set({ mood });
    if (forMs) later('mood', forMs, () => set({ mood: restingMood() }));
  },
  /** Look at a point for a moment, then back to the cursor. */
  lookAt(point: { x: number; y: number }, forMs = 1200) {
    set({ gaze: point });
    later('gaze', forMs, () => set({ gaze: null }));
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
    try {
      localStorage.setItem(LOOK_KEY, JSON.stringify(look));
    } catch {
      // Storage unavailable: the look still applies for this session.
    }
    set({ look });
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
