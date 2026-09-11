// Merge litedb-mcp into Claude Desktop's config.
//
// Two files on Windows: the documented Roaming path, and the MSIX virtualized
// copy the store install actually reads. Writing only the first is how a valid
// JSON file produces "Failed / Server disconnected" with no explanation.

import { mergeLiteDbMcp, stdioServerEntry } from './mcpAgentConfig';

function join(base: string, ...parts: string[]): string {
    const sep = base.includes('\\') ? '\\' : '/';
    return [base.replace(/[/\\]+$/, ''), ...parts].join(sep);
}

function parentDir(path: string): string {
    return path.replace(/[/\\][^/\\]+$/, '');
}

function isWindows(): boolean {
    if (typeof navigator === 'undefined') return false;
    return navigator.userAgent.includes('Windows');
}

async function pathExists(path: string): Promise<boolean> {
    const { exists } = await import('@tauri-apps/plugin-fs');
    return exists(path);
}

/** Config files we merge into. Windows always gets Roaming + Store copies. */
export async function claudeDesktopConfigPaths(): Promise<string[]> {
    const { dataDir, localDataDir, homeDir, configDir } = await import('@tauri-apps/api/path');
    const [data, local, home, config] = await Promise.all([
        dataDir(),
        localDataDir(),
        homeDir(),
        configDir(),
    ]);

    if (isWindows()) {
        return [
            join(data, 'Claude', 'claude_desktop_config.json'),
            join(
                local,
                'Packages',
                'Claude_pzs8sxrjxfjjc',
                'LocalCache',
                'Roaming',
                'Claude',
                'claude_desktop_config.json',
            ),
        ];
    }

    const candidates = [
        join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        join(config, 'Claude', 'claude_desktop_config.json'),
    ];
    const unique = [...new Set(candidates)];
    const hits: string[] = [];
    for (const path of unique) {
        try {
            if ((await pathExists(path)) || (await pathExists(parentDir(path)))) {
                hits.push(path);
            }
        } catch {
            // Scope miss — skip rather than pretend the file is absent.
        }
    }
    return hits.length > 0 ? hits : unique.slice(0, 1);
}

export interface ClaudeInstallResult {
    written: string[];
    skipped: string[];
    alreadyPresent: boolean;
}

export async function installClaudeDesktopMcp(): Promise<ClaudeInstallResult> {
    const { mkdir, readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
    const entry = stdioServerEntry();
    const paths = await claudeDesktopConfigPaths();
    if (paths.length === 0) {
        throw new Error('Could not resolve Claude Desktop config paths.');
    }

    const written: string[] = [];
    const skipped: string[] = [];
    let alreadyPresent = false;
    const errors: string[] = [];

    for (const path of paths) {
        try {
            await mkdir(parentDir(path), { recursive: true });
            let present = false;
            try {
                present = await pathExists(path);
            } catch {
                throw new Error(`Could not check ${path}. Not overwriting it.`);
            }
            let raw = '';
            if (present) {
                try {
                    raw = await readTextFile(path);
                } catch {
                    throw new Error(
                        `Could not read ${path}. Refusing to overwrite a Claude config we cannot parse.`,
                    );
                }
            }
            const next = mergeLiteDbMcp(raw, entry);
            if (raw === next) alreadyPresent = true;
            await writeTextFile(path, next);
            written.push(path);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(message);
            skipped.push(path);
        }
    }

    if (written.length === 0) {
        throw new Error(errors.join(' ') || 'Could not write Claude Desktop config.');
    }

    return { written, skipped, alreadyPresent };
}
