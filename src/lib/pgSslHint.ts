/**
 * "Require SSL" now means what it says, in the app and in the MCP server alike:
 * on requires TLS, off sends nothing encrypted. Before 2.2 the app ignored the
 * box and quietly tried TLS anyway, so a remembered connection to a host that
 * insists on TLS — Neon, RDS, most managed Postgres — worked unticked and now
 * fails. The server's refusal does not mention the checkbox; this does.
 */
export function pgSslHint(message: string, sslRequired: boolean): string | null {
    if (!sslRequired && /no encryption|ssl off|insecure|sslmode|requires? (ssl|encryption|tls)/i.test(message)) {
        return 'This server requires an encrypted connection. Tick "Require SSL" and connect again.';
    }
    if (sslRequired && /does not support (tls|ssl)/i.test(message)) {
        return 'This server does not accept encrypted connections. Untick "Require SSL" to connect without it.';
    }
    return null;
}
