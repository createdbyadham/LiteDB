// Text typed into a cell, turned into the value to store.
//
// Shared by inline editing, the edit dialog and the insert dialog. Values are
// parsed when the edit is committed, not on every keystroke, so "-" and "3."
// on the way to "-3.5" are not refused, and a required field can be cleared
// to retype it.
//
// Free of browser and Tauri imports so the self-test can run it.

export type ParsedCell = { ok: true; value: unknown } | { ok: false; error: string };

export interface CellColumn {
    name: string;
    type: string;
    notnull: number;
}

/** What a column's declared type expects, roughly. Postgres and SQLite spellings both. */
export function typeFamily(type: string): 'integer' | 'number' | 'boolean' | 'json' | 'text' {
    const t = type.toLowerCase();
    if (/^(json|jsonb)\b/.test(t)) return 'json';
    if (/bool/.test(t)) return 'boolean';
    if (/int|serial/.test(t) && !/interval|point/.test(t)) return 'integer';
    if (/real|floa|doub|numeric|decimal|money/.test(t)) return 'number';
    return 'text';
}

export function parseCellText(column: CellColumn, text: string): ParsedCell {
    if (text === '') {
        if (column.notnull) return { ok: false, error: `${column.name} is required` };
        return { ok: true, value: null };
    }
    switch (typeFamily(column.type)) {
        case 'integer': {
            const trimmed = text.trim();
            if (!/^[+-]?\d+$/.test(trimmed)) return { ok: false, error: `${column.name} needs a whole number` };
            const n = Number(trimmed);
            // Beyond 2^53 a number would round; the database casts the text exactly.
            return { ok: true, value: Number.isSafeInteger(n) ? n : trimmed };
        }
        case 'number': {
            const trimmed = text.trim();
            if (trimmed === '' || !Number.isFinite(Number(trimmed))) {
                return { ok: false, error: `${column.name} needs a number` };
            }
            // Text keeps numeric(38, 10) exact; the server parses it.
            return { ok: true, value: /^[+-]?\d+(\.\d+)?$/.test(trimmed) && trimmed.length > 15 ? trimmed : Number(trimmed) };
        }
        case 'boolean': {
            const t = text.trim().toLowerCase();
            if (['true', '1', 't', 'yes', 'y'].includes(t)) return { ok: true, value: true };
            if (['false', '0', 'f', 'no', 'n'].includes(t)) return { ok: true, value: false };
            return { ok: false, error: `${column.name} needs true or false` };
        }
        case 'json': {
            try {
                JSON.parse(text);
            } catch (error) {
                return { ok: false, error: `${column.name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
            }
            return { ok: true, value: text };
        }
        default:
            return { ok: true, value: text };
    }
}

/** The text an edit box starts with for a value. */
export function editText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/**
 * Whether a value looks like JSON worth showing in the viewer: an object or
 * array, either already parsed or as text from a json/jsonb or TEXT column.
 */
export function asJsonDocument(value: unknown): unknown | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === 'object' && !(value instanceof Uint8Array)) return value;
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!(text.startsWith('{') && text.endsWith('}')) && !(text.startsWith('[') && text.endsWith(']'))) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
