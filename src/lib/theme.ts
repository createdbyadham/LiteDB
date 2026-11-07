// Light, dark, or whatever the OS says. next-themes owns the class on <html>
// once React is up; this only sets it before the first render so a light
// theme does not open with a dark flash.

export const THEME_STORAGE_KEY = 'litedb-theme';

export type ThemeChoice = 'light' | 'dark' | 'system';

export function applyStoredTheme(): void {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
        const dark = stored === 'light' ? false : stored === 'system' ? systemDark : true;
        document.documentElement.classList.toggle('dark', dark);
        document.documentElement.classList.toggle('light', !dark);
    } catch {
        // Storage unavailable: stay on the dark default in index.html.
    }
}
