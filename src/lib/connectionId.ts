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

/**
 * Identity for a Postgres connection. The password is not a parameter, so it
 * cannot end up in a policy key or an audit line, and the username is not
 * written into the id either.
 *
 * Supabase is the one host where the username has to be read, and only to
 * name the project. Every project in a region shares a pooler host
 * (`aws-0-eu-central-1.pooler.supabase.com`, `aws-1-...`) and the database is
 * `postgres`; the project is the 20-character ref in the user
 * (`postgres.<ref>`). Host, port and database alone would make opening a
 * second project switch to the first, and the two would share a read-only
 * policy, audit history and agent approvals.
 *
 * The direct host (`db.<ref>.supabase.co`), the session pooler (port 5432)
 * and the transaction pooler (port 6543, on the shared host or on the direct
 * host) are one project reached three ways, so they all take the id the
 * direct host would get on port 5432. Any other host stays
 * `postgres:<host>:<port>/<database>` with the host and port exactly as
 * given, which is what saved policies and audit history are already keyed by.
 */
export function postgresConnectionId(
    host: string,
    port: number | string,
    database: string,
    username: string,
): string {
    const supabase = canonicalSupabase(host, port, username);
    if (supabase) return `postgres:${supabase}/${database}`;
    return `postgres:${host}:${port}/${database}`;
}

/** Supabase project refs are 20 lowercase letters and digits. */
const SUPABASE_REF = '[a-z0-9]{20}';
const DIRECT_HOST = new RegExp(`^db\\.(${SUPABASE_REF})\\.supabase\\.co$`);
const POOLER_USER = new RegExp(`^(.+)\\.(${SUPABASE_REF})$`, 'i');
const POOLER_SUFFIX = '.pooler.supabase.com';

/**
 * `db.<ref>.supabase.co:5432` for a Supabase project, otherwise null.
 * Hosts are compared case-insensitively and the id is stored lowercase, so
 * `DB.<ref>.SUPABASE.CO` and the pooler hostname spell one project.
 */
function canonicalSupabase(host: string, port: number | string, username: string): string | null {
    const lower = host.toLowerCase();
    const direct = DIRECT_HOST.exec(lower);
    if (direct) {
        const portNumber = Number(port);
        // 6543 is the dedicated pooler in front of the same database as 5432.
        if (portNumber === 5432 || portNumber === 6543) {
            return `db.${direct[1]}.supabase.co:5432`;
        }
        return null;
    }
    if (!lower.endsWith(POOLER_SUFFIX)) return null;
    const user = POOLER_USER.exec(username);
    if (!user) return null;
    return `db.${user[2].toLowerCase()}.supabase.co:5432`;
}
