// Values written into SQL text, and rows copied out of the grid.
//
// One place for both, so a row copied as INSERT and a row saved from the edit
// dialog spell the same value the same way.
//
// Free of browser and Tauri imports so the self-test can run it.

import type { SqlDialect } from '../schemaTypes';
import { OmittedBlob } from './blob';

function hex(bytes: Uint8Array): string {
    let out = '';
    for (const b of bytes) out += b.toString(16).padStart(2, '0');
    return out;
}

export function quoteString(text: string): string {
    if (text.includes('\0')) throw new Error('Text containing a NUL character cannot be written as SQL.');
    return `'${text.replace(/'/g, "''")}'`;
}

/** A SQL literal for a cell value. */
export function sqlLiteral(value: unknown, dialect: SqlDialect): string {
    if (value === null || value === undefined) return 'NULL';
    if (value instanceof OmittedBlob) {
        throw new Error('This blob is too large to copy into SQL text.');
    }
    if (value instanceof Uint8Array) {
        return dialect === 'sqlite' ? `X'${hex(value)}'` : `'\\x${hex(value)}'::bytea`;
    }
    if (typeof value === 'number') {
        if (Number.isFinite(value)) return String(value);
        return dialect === 'postgres' ? quoteString(Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity') : 'NULL';
    }
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'boolean') {
        return dialect === 'postgres' ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0';
    }
    if (value instanceof Date) return quoteString(value.toISOString());
    if (typeof value === 'object') return quoteString(JSON.stringify(value));
    return quoteString(String(value));
}

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'insert' | 'markdown';

export const COPY_FORMATS: { value: CopyFormat; label: string }[] = [
    { value: 'tsv', label: 'Tab-separated (pastes into spreadsheets)' },
    { value: 'csv', label: 'CSV' },
    { value: 'json', label: 'JSON' },
    { value: 'insert', label: 'INSERT statements' },
    { value: 'markdown', label: 'Markdown table' },
];

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** A value as plain text: what a cell shows, minus the NULL styling. */
export function cellText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (value instanceof Uint8Array) return bytesToBase64(value);
    if (value instanceof OmittedBlob) return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function delimited(value: unknown, delimiter: string): string {
    if (value === null || value === undefined) return '';
    const text = cellText(value);
    const needsQuotes = text.includes(delimiter) || /["\r\n]/.test(text) || /^\s|\s$/.test(text);
    return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

function jsonValue(value: unknown): unknown {
    if (value instanceof Uint8Array) return bytesToBase64(value);
    if (value instanceof OmittedBlob) return null;
    if (typeof value === 'bigint') return value.toString();
    return value ?? null;
}

export interface CopyOptions {
    dialect: SqlDialect;
    /** Quoted, qualified table name for INSERT. */
    table?: string;
    /** Column names already quoted for INSERT, in `columns` order. */
    quotedColumns?: string[];
}

export function formatRows(
    columns: string[],
    rows: unknown[][],
    format: CopyFormat,
    options: CopyOptions,
): string {
    switch (format) {
        case 'tsv':
        case 'csv': {
            const d = format === 'tsv' ? '\t' : ',';
            const lines = [columns.map((c) => delimited(c, d)).join(d)];
            for (const row of rows) lines.push(row.map((v) => delimited(v, d)).join(d));
            return lines.join('\n');
        }
        case 'json': {
            const objects = rows.map((row) =>
                Object.fromEntries(columns.map((c, i) => [c, jsonValue(row[i])])),
            );
            return JSON.stringify(objects.length === 1 ? objects[0] : objects, null, 2);
        }
        case 'insert': {
            const table = options.table ?? 'table_name';
            const cols = (options.quotedColumns ?? columns).join(', ');
            return rows
                .map(
                    (row) =>
                        `INSERT INTO ${table} (${cols}) VALUES (${row
                            .map((v) => sqlLiteral(v, options.dialect))
                            .join(', ')});`,
                )
                .join('\n');
        }
        case 'markdown': {
            const esc = (v: unknown) =>
                (v === null || v === undefined ? 'NULL' : cellText(v)).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
            const header = `| ${columns.map(esc).join(' | ')} |`;
            const rule = `| ${columns.map(() => '---').join(' | ')} |`;
            return [header, rule, ...rows.map((row) => `| ${row.map(esc).join(' | ')} |`)].join('\n');
        }
    }
}
