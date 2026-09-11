// Stable names for the databases the app and the MCP server talk to.
//
// Split out of queryGate.ts because identity is not gate state: the MCP server
// writes audit entries for connections the desktop app never opened, and the
// two must agree on what a connection is called or the log stops being one
// history. queryGate owns *policy per connection*; this file owns *which
// connection*.
//
// Kept free of browser and Node imports so both hosts can use it unchanged.

/** Identity for a loaded SQLite file. In-memory databases share one key. */
export function sqliteConnectionId(filePath?: string | null): string {
    return filePath ? `sqlite:${filePath}` : 'sqlite:in-memory';
}

/** Identity for a Postgres connection. Excludes credentials by construction. */
export function postgresConnectionId(
    host: string,
    port: number | string,
    database: string,
): string {
    return `postgres:${host}:${port}/${database}`;
}
