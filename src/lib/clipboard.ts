import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { inTauri } from '@/lib/db/native';

/** The native clipboard, with the browser's as a fallback. */
export async function copyText(text: string): Promise<void> {
    if (inTauri()) {
        try {
            await writeText(text);
            return;
        } catch {
            // Fall through to the web clipboard.
        }
    }
    await navigator.clipboard.writeText(text);
}
