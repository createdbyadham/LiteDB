// CSV, Excel and JSON files that open as read-only databases.
//
// The app reads such a file into an in-memory SQLite copy
// (src-tauri/src/db/datafile.rs) and then treats it as any SQLite connection,
// except that it is always read-only and agents reach it through the app's
// own connection, since there is no database file for them to open.
//
// Free of browser and Tauri imports so the self-test can run it.

/** Kept in step with `format_of` in src-tauri/src/db/datafile.rs. */
export const DATA_FILE_EXTENSIONS = ['csv', 'tsv', 'tab', 'xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'json', 'jsonl', 'ndjson'];

const KINDS: Record<string, string> = {
    csv: 'CSV',
    tsv: 'TSV',
    tab: 'TSV',
    xlsx: 'Excel',
    xlsm: 'Excel',
    xlsb: 'Excel',
    xls: 'Excel',
    ods: 'OpenDocument',
    json: 'JSON',
    jsonl: 'JSON Lines',
    ndjson: 'JSON Lines',
};

function extension(path: string): string {
    const name = path.split(/[\\/]/).pop() ?? '';
    const dot = name.lastIndexOf('.');
    // `.csv` alone is a hidden file with no extension, as Rust's Path reads it.
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Whether the path opens as a read-only copy rather than as a SQLite database. */
export function isDataFile(path: string): boolean {
    return extension(path) in KINDS;
}

/** What to call the file's format: CSV, Excel, JSON. Null for anything else. */
export function dataFileKind(path: string): string | null {
    return KINDS[extension(path)] ?? null;
}
