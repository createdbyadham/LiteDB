// The audit log as a file, for the npm server.
//
// The desktop app's audit view reads the same file (see audit.ts). Kept apart
// from audit.ts so the tools, which only record, carry no Node imports and the
// app can serve them over its own log.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setAuditSink, type AuditSink } from '../../src/lib/auditLog';

export function createFileSink(path: string): AuditSink {
    let ensured = false;

    return {
        async append(line: string): Promise<void> {
            if (!ensured) {
                await mkdir(dirname(path), { recursive: true });
                ensured = true;
            }
            await appendFile(path, line, 'utf8');
        },
        async read(): Promise<string> {
            try {
                return await readFile(path, 'utf8');
            } catch (error) {
                // No log yet is not a failure; it is a log with nothing in it.
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
                throw error;
            }
        },
        location(): string {
            return path;
        },
    };
}

/** Record into the log file at `path`. */
export function installFileAudit(path: string): void {
    setAuditSink(createFileSink(path));
}
