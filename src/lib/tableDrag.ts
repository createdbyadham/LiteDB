// Dragging a table out of the sidebar, onto Star.
//
// Pointer events rather than HTML5 drag and drop: the window handles file
// drops natively (that is how a database file lands on the upload screen),
// and on Windows that native handler stops HTML5 drag and drop between
// elements on the page from working at all.

import { useSyncExternalStore } from 'react';

export interface TableDrag {
  table: string;
  x: number;
  y: number;
  /** Over a drop target that wants it. */
  over: boolean;
}

export interface DropTarget {
  /** Whether a drop at this point lands on the target. */
  hit(x: number, y: number): boolean;
  drop(table: string): void;
}

/** Distance the pointer travels before a press becomes a drag, so clicks stay clicks. */
const THRESHOLD = 5;

let drag: TableDrag | null = null;
const listeners = new Set<() => void>();
const targets = new Set<DropTarget>();

function set(next: TableDrag | null) {
  drag = next;
  listeners.forEach((fn) => fn());
}

export function registerDropTarget(target: DropTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}

const targetAt = (x: number, y: number) => [...targets].find((t) => t.hit(x, y)) ?? null;

function makeGhost(table: string): HTMLElement {
  const ghost = document.createElement('div');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.className =
    'pointer-events-none fixed left-0 top-0 z-[80] rounded-md border bg-popover px-2.5 py-1 font-mono text-xs text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.45)]';
  ghost.textContent = table;
  document.body.append(ghost);
  return ghost;
}

/**
 * Start tracking a press on a table. It becomes a drag once the pointer moves
 * a few pixels; a press that never moves is left to be a click.
 */
export function pressTable(event: React.PointerEvent<HTMLElement>, table: string): void {
  if (event.button !== 0 || event.pointerType === 'touch') return;
  const source = event.currentTarget;
  const pointerId = event.pointerId;
  const start = { x: event.clientX, y: event.clientY };
  let ghost: HTMLElement | null = null;
  let userSelect = '';

  const place = (x: number, y: number) => {
    if (ghost) ghost.style.transform = `translate3d(${x + 12}px, ${y + 10}px, 0)`;
  };

  const move = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    if (!ghost) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < THRESHOLD) return;
      ghost = makeGhost(table);
      userSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';
      try {
        source.setPointerCapture(pointerId);
      } catch {
        // Capture is a nicety: moves still arrive on the window.
      }
    }
    place(e.clientX, e.clientY);
    set({ table, x: e.clientX, y: e.clientY, over: !!targetAt(e.clientX, e.clientY) });
  };

  const finish = (e: PointerEvent | null, dropped: boolean) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', escape, true);
    if (!ghost) return;
    ghost.remove();
    document.body.style.userSelect = userSelect;
    // The press ends in a click on the item it started on; a drag is not a click.
    const swallow = (c: MouseEvent) => {
      c.stopPropagation();
      c.preventDefault();
    };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
    const target = dropped && e ? targetAt(e.clientX, e.clientY) : null;
    set(null);
    target?.drop(table);
  };

  const up = (e: PointerEvent) => e.pointerId === pointerId && finish(e, true);
  const cancel = (e: PointerEvent) => e.pointerId === pointerId && finish(e, false);
  const escape = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !ghost) return;
    e.stopPropagation();
    finish(null, false);
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', escape, true);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const current = () => drag;

/** The table being dragged, if any, and where. */
export function useTableDrag(): TableDrag | null {
  return useSyncExternalStore(subscribe, current, current);
}
