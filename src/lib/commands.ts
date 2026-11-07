// Actions the command palette (and keyboard shortcuts) send to whichever view
// can carry them out. A window event, so the palette does not need to know
// which components are mounted.

import { useEffect, useRef } from 'react';

export type AppCommand =
    | { type: 'openTable'; table: string }
    | { type: 'switchTab'; tab: 'browse' | 'schema' | 'query' | 'vectors' }
    | { type: 'newQueryTab' }
    | { type: 'runQuery' }
    | { type: 'aiGenerate' }
    | { type: 'importCsv'; table?: string }
    | { type: 'export' }
    | { type: 'insertRow' }
    | { type: 'refresh' }
    | { type: 'newPostgres' }
    | { type: 'connectSaved'; id: string };

const EVENT = 'appCommand';

export function emitAppCommand(command: AppCommand): void {
    window.dispatchEvent(new CustomEvent<AppCommand>(EVENT, { detail: command }));
}

/** Handle commands while mounted. The handler may change between renders. */
export function useAppCommand(handler: (command: AppCommand) => void): void {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {
        const listener = (event: Event) => ref.current((event as CustomEvent<AppCommand>).detail);
        window.addEventListener(EVENT, listener);
        return () => window.removeEventListener(EVENT, listener);
    }, []);
}

export function openCommandPalette(): void {
    window.dispatchEvent(new CustomEvent('openCommandPalette'));
}

/**
 * A command for a view that is not mounted yet: the palette navigates there,
 * and the view picks this up on mount.
 */
let pending: AppCommand | null = null;

export function setPendingCommand(command: AppCommand): void {
    pending = command;
}

export function takePendingCommand(): AppCommand | null {
    const command = pending;
    pending = null;
    return command;
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** `Mod` is ⌘ on macOS and Ctrl elsewhere. */
export function shortcutLabel(keys: string): string {
    return keys
        .split('+')
        .map((k) => (k === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : k === 'Shift' ? (isMac ? '⇧' : 'Shift') : k === 'Alt' ? (isMac ? '⌥' : 'Alt') : k))
        .join(isMac ? '' : '+');
}
