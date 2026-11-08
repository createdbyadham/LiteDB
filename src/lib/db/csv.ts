// CSV in: parsing for the import dialog, and the column types it suggests.
//
// RFC 4180 with the usual real-world tolerances: a byte-order mark, CRLF or
// LF, quoted fields with embedded newlines and doubled quotes, and a delimiter
// guessed from the first lines (comma, semicolon, tab or pipe).
//
// Free of browser and Tauri imports so the self-test can run it.

import type { SqlDialect } from '../schemaTypes';

export type Delimiter = ',' | ';' | '\t' | '|';

export const DELIMITERS: { value: Delimiter; label: string }[] = [
    { value: ',', label: 'Comma' },
    { value: ';', label: 'Semicolon' },
    { value: '\t', label: 'Tab' },
    { value: '|', label: 'Pipe' },
];

/** The delimiter that splits the first lines into the most consistent columns. */
export function detectDelimiter(text: string): Delimiter {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
    if (lines.length === 0) return ',';
    let best: Delimiter = ',';
    let bestScore = -1;
    for (const { value } of DELIMITERS) {
        const counts = lines.map((line) => parseCsv(line, value)[0]?.length ?? 0);
        const first = counts[0];
        if (first < 2) continue;
        const consistent = counts.filter((c) => c === first).length;
        const score = consistent * 100 + first;
        if (score > bestScore) {
            bestScore = score;
            best = value;
        }
    }
    return best;
}

/** Every record as an array of fields. Blank lines are skipped. */
export function parseCsv(input: string, delimiter: Delimiter = ','): string[][] {
    const text = input.replace(/^\uFEFF/, '');
    const records: string[][] = [];
    let record: string[] = [];
    let field = '';
    let inQuotes = false;
    let fieldStarted = false;

    const endField = () => {
        record.push(field);
        field = '';
        fieldStarted = false;
    };
    const endRecord = () => {
        endField();
        // A line with nothing on it is not a record of one empty field.
        if (!(record.length === 1 && record[0] === '')) records.push(record);
        record = [];
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
            continue;
        }
        if (ch === '"' && !fieldStarted) {
            inQuotes = true;
            fieldStarted = true;
        } else if (ch === delimiter) {
            endField();
        } else if (ch === '\n') {
            endRecord();
        } else if (ch === '\r') {
            if (text[i + 1] === '\n') i++;
            endRecord();
        } else {
            field += ch;
            fieldStarted = true;
        }
    }
    if (field !== '' || record.length > 0 || fieldStarted) endRecord();
    return records;
}

export type InferredType = 'integer' | 'real' | 'boolean' | 'date' | 'timestamp' | 'text';

const INTEGER = /^[+-]?\d+$/;
const REAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOLEAN = /^(true|false|t|f|yes|no)$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * The narrowest type every non-empty value fits. A column of zip codes with
 * leading zeros stays text: "02134" read as an integer would lose the zero.
 */
export function inferColumnType(values: string[]): InferredType {
    const present = values.map((v) => v.trim()).filter((v) => v !== '');
    if (present.length === 0) return 'text';
    const all = (test: (v: string) => boolean) => present.every(test);
    const noLeadingZero = (v: string) => !/^[+-]?0\d/.test(v);
    if (all((v) => INTEGER.test(v) && noLeadingZero(v) && Number.isSafeInteger(Number(v)))) return 'integer';
    if (all((v) => REAL.test(v) && noLeadingZero(v.replace(/\..*$/, '')))) return 'real';
    if (all((v) => BOOLEAN.test(v))) return 'boolean';
    if (all((v) => DATE.test(v))) return 'date';
    if (all((v) => TIMESTAMP.test(v) || DATE.test(v))) return 'timestamp';
    return 'text';
}

export function sqlTypeFor(type: InferredType, dialect: SqlDialect): string {
    if (dialect === 'sqlite') {
        return { integer: 'INTEGER', real: 'REAL', boolean: 'INTEGER', date: 'TEXT', timestamp: 'TEXT', text: 'TEXT' }[type];
    }
    return {
        integer: 'bigint',
        real: 'double precision',
        boolean: 'boolean',
        date: 'date',
        timestamp: 'timestamptz',
        text: 'text',
    }[type];
}

/** A column name from a header cell that may be empty or repeated. */
export function headerNames(header: string[]): string[] {
    const seen = new Map<string, number>();
    return header.map((raw, i) => {
        const base = raw.trim() || `column_${i + 1}`;
        const count = seen.get(base.toLowerCase()) ?? 0;
        seen.set(base.toLowerCase(), count + 1);
        return count === 0 ? base : `${base}_${count + 1}`;
    });
}
