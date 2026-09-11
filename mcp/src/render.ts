// Turning results into the text a model reads.
//
// An MCP tool result is text, and the reader is a language model, so the
// format is chosen for that reader rather than for a terminal. Two rules
// follow from it:
//
//   * Say what is missing. A truncated result that looks complete is how a
//     model concludes "there are 50 customers" from the 50 rows it was given
//     out of 4,000. Every cap here announces itself.
//   * NULL is not an empty string. `''` and NULL are different answers to
//     "what is in this cell", and a renderer that shows them the same way
//     invents facts.

/** How wide one cell may get before it is cut. */
const MAX_CELL = 200;

function truncate(text: string): string {
    const oneLine = text.replace(/\s*\n\s*/g, ' ');
    return oneLine.length > MAX_CELL ? `${oneLine.slice(0, MAX_CELL)}…` : oneLine;
}

/**
 * `[0.04,0.02,...]` -> `[384 floats]`, or null when it is not a vector.
 *
 * pgvector hands a `vector` column back as a *string*, not an array — the
 * driver has no type parser for an extension type — so the array check below
 * never sees one. Without this, a 384-dimensional embedding arrives as 200
 * characters of truncated digits in every row of a similarity search, which
 * is both unreadable and an expensive way to say nothing.
 */
function summariseVector(text: string): string | null {
    if (text.length < 64 || !text.startsWith('[') || !text.endsWith(']')) return null;
    const parts = text.slice(1, -1).split(',');
    if (parts.length <= 8) return null;
    // Probe the head rather than every element: a 1,536-dimensional vector is
    // not worth a full scan to decide how to print it.
    for (const part of parts.slice(0, 8)) {
        if (!Number.isFinite(Number(part))) return null;
    }
    return `[${parts.length} floats]`;
}

function renderValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'string') return summariseVector(value) ?? truncate(value);
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) {
        // A real array of numbers — a Postgres `real[]` column, or a driver
        // configured to parse vectors. Same reasoning as above.
        if (value.length > 8 && value.every((v) => typeof v === 'number')) {
            return `[${value.length} floats]`;
        }
        return truncate(JSON.stringify(value));
    }
    return truncate(JSON.stringify(value));
}

export interface RenderOptions {
    /** Rows to show. Anything beyond is dropped, and said to be dropped. */
    maxRows: number;
}

/**
 * A fixed-width table.
 *
 * Markdown pipe tables were the other option and are worse here: a cell
 * containing a `|` breaks them, and SQL results contain arbitrary text.
 */
export function renderTable(
    columns: string[],
    rows: unknown[][],
    options: RenderOptions,
): string {
    if (columns.length === 0) return '(no columns)';
    if (rows.length === 0) return `(0 rows)\n\n${columns.join('  ')}`;

    const shown = rows.slice(0, options.maxRows);
    const cells = shown.map((row) => columns.map((_, i) => renderValue(row[i])));
    const widths = columns.map((name, i) =>
        Math.max(name.length, ...cells.map((row) => row[i].length)),
    );

    const line = (values: string[]): string =>
        values.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd();

    const out = [
        line(columns),
        widths.map((w) => '-'.repeat(w)).join('  '),
        ...cells.map(line),
    ];

    if (rows.length > shown.length) {
        out.push(
            '',
            `… ${rows.length - shown.length} more row(s) not shown. Add a LIMIT, or ` +
                'raise LITEDB_MAX_ROWS, to see them.',
        );
    }
    return out.join('\n');
}

/** `4812` → `4,812`. Row counts get read by a human over the model's shoulder. */
export function formatCount(value: number): string {
    return value.toLocaleString('en-US');
}

/** `1 row` / `4,812 rows`, so the singular case does not read as a bug. */
export function pluralRows(count: number): string {
    return `${formatCount(count)} ${count === 1 ? 'row' : 'rows'}`;
}
