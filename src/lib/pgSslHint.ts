/**
 * "Require SSL" now means what it says, in the app and in the MCP server alike:
 * on requires TLS, off sends nothing encrypted. Before 2.2 the app ignored the
 * box and quietly tried TLS anyway, so a remembered connection to a host that
 * insists on TLS: Neon, RDS, most managed Postgres, worked unticked and now
 * fails. The server's refusal does not mention the checkbox; this does.
 */
export function pgSslHint(message: string, sslRequired: boolean): string | null {
    if (!sslRequired && /no encryption|ssl off|insecure|sslmode|requires? (ssl|encryption|tls)/i.test(message)) {
        return 'This server requires an encrypted connection. Set SSL to Require (or a Verify mode) and connect again.';
    }
    if (sslRequired && /does not support (tls|ssl)/i.test(message)) {
        return 'This server does not accept encrypted connections. Set SSL to Off to connect without it.';
    }
    if (sslRequired && /certificate|unknown ca|self.signed|UnknownIssuer|invalid peer/i.test(message)) {
        return 'The server certificate could not be verified. Choose the CA certificate it was issued by, or use Require to encrypt without verifying.';
    }
    return null;
}

/**
 * Supabase's `db.<ref>.supabase.co` address is IPv6-only unless the project
 * bought the IPv4 add-on. On an IPv4-only network the failure is a raw OS
 * error about an unreachable route, a name that did not resolve, or the
 * connect giving up. None of those mention Supabase or IPv6. The poolers
 * (`*.pooler.supabase.com`) are reachable over IPv4, so they get no hint.
 */
export function pgSupabaseDirectHint(host: string, message: string): string | null {
    if (!/^db\.[^.]+\.supabase\.co$/i.test(host.trim())) return null;
    const unreachable =
        /unreachable network|unreachable host|network is unreachable|no route to host|ENETUNREACH|EHOSTUNREACH|os error 10051|os error 10065/i;
    const unresolved =
        /no such host is known|failed to lookup address information|name or service not known|nodename nor servname|temporary failure in name resolution/i;
    const timedOut = /timed out|\btimeout\b|ETIMEDOUT|os error 10060|deadline has elapsed|did not properly respond/i;
    if (!unreachable.test(message) && !unresolved.test(message) && !timedOut.test(message)) return null;
    return "Supabase's direct connection (db.<ref>.supabase.co) is IPv6-only unless the project has the IPv4 add-on, and this network can't reach it. In Supabase, open Connect and copy the Session pooler string instead (port 5432).";
}
