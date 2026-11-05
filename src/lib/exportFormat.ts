// Shared cell formatting for the CSV and JSON exports, so SQLite and Postgres
// write the same thing for the same value.

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/** A value as JSON can carry it: BLOBs become base64, bigints become strings. */
export function toJsonValue(value: unknown): unknown {
    if (value instanceof Uint8Array) return bytesToBase64(value);
    if (typeof value === 'bigint') return value.toString();
    return value;
}

export function rowsToJson(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map(row =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toJsonValue(v)])),
    );
}

/** One RFC 4180 CSV field. NULL is an empty field. */
export function csvCell(value: unknown): string {
    if (value === null || value === undefined) return '';
    let text: string;
    if (value instanceof Uint8Array) text = bytesToBase64(value);
    else if (value instanceof Date) text = value.toISOString();
    else if (typeof value === 'object') text = JSON.stringify(value);
    else text = String(value);
    return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: unknown[]): string {
    return values.map(csvCell).join(',');
}
