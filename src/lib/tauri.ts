// File dialogs and file writes. Database access lives in src/lib/db.

import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeFile } from '@tauri-apps/plugin-fs';

const SQLITE_EXTENSIONS = ['db', 'sqlite', 'sqlite3', 'db3', 's3db', 'sl3'];

export const tauriService = {
  exportDatabase: async (data: string | Uint8Array, format: string): Promise<{ success: boolean; filePath?: string; error?: string }> => {
    try {
      const filePath = await save({
        filters: [{
          name: format.toUpperCase(),
          extensions: [format.toLowerCase()]
        }]
      });

      if (!filePath) return { success: false, error: 'Export cancelled' };

      if (data instanceof Uint8Array) {
        // Binary formats built in memory, such as .xlsx.
        await writeFile(filePath, data);
      } else if (['png', 'jpg', 'jpeg'].includes(format.toLowerCase()) && data.startsWith('data:')) {
        const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
        const binaryData = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        await writeFile(filePath, binaryData);
      } else {
        // Text data (SVG, SQL, JSON, CSV). An SVG arrives as a data URL from
        // html-to-image; writing that string as-is produced a file no viewer
        // could open, so unwrap it to the markup first.
        let text = data;
        const svgUrl = /^data:image\/svg\+xml(;charset=[^;,]+)?(;base64)?,/i.exec(data);
        if (svgUrl) {
          const payload = data.slice(svgUrl[0].length);
          text = svgUrl[2]
            ? new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)))
            : decodeURIComponent(payload);
        }
        await writeFile(filePath, new TextEncoder().encode(text));
      }

      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },

  /** Pick an existing SQLite file. */
  openSqliteDialog: async (): Promise<string | null> => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: 'SQLite Database', extensions: SQLITE_EXTENSIONS },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      return typeof selected === 'string' ? selected : null;
    } catch (e) {
      console.error('Error opening file dialog:', e);
      return null;
    }
  },

  /** Choose where a new SQLite database goes. */
  newSqliteDialog: async (): Promise<string | null> => {
    try {
      const selected = await save({
        defaultPath: 'database.db',
        filters: [{ name: 'SQLite Database', extensions: SQLITE_EXTENSIONS }],
      });
      return selected ?? null;
    } catch (e) {
      console.error('Error opening save dialog:', e);
      return null;
    }
  },

  /** Pick any file, for certificates and SSH keys. */
  pickFile: async (title: string, extensions?: string[]): Promise<string | null> => {
    try {
      const selected = await open({
        multiple: false,
        title,
        filters: extensions ? [{ name: title, extensions }, { name: 'All files', extensions: ['*'] }] : undefined,
      });
      return typeof selected === 'string' ? selected : null;
    } catch (e) {
      console.error('Error opening file dialog:', e);
      return null;
    }
  },

  /** Pick a CSV and read it. Null when cancelled. */
  openTextFile: async (extensions: string[]): Promise<{ path: string; text: string } | null> => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Delimited text', extensions }, { name: 'All files', extensions: ['*'] }],
    });
    if (typeof selected !== 'string') return null;
    return { path: selected, text: await readTextFile(selected) };
  },
};
