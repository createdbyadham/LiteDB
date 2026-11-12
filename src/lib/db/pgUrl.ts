// Postgres connection URLs, as Neon, Supabase, Railway, Heroku and RDS hand
// them out, read into the fields of the connection form.
//
// Parsed by hand rather than with `new URL`: passwords pasted from a dashboard
// are not always percent-encoded, and an `@` or `/` in one should not move
// the host. The host starts after the last `@`.
//
// Kept free of browser and Tauri imports so the self-test can run it.

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full';

export const SSL_MODES: { value: SslMode; label: string; hint: string }[] = [
    { value: 'disable', label: 'Off', hint: 'Plain TCP. Local databases.' },
    { value: 'prefer', label: 'Prefer', hint: 'Encrypt if the server offers it.' },
    { value: 'require', label: 'Require', hint: 'Always encrypt; do not check the certificate.' },
    { value: 'verify-ca', label: 'Verify CA', hint: 'Encrypt and check the certificate against a CA.' },
    {
        value: 'verify-full',
        label: 'Verify full',
        hint: 'Encrypt, check the CA, and check the host name. Safest.',
    },
];

export interface ParsedPostgresUrl {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    // Set when the URL's password was a stand-in such as [YOUR-PASSWORD], which was discarded.
    passwordPlaceholder?: boolean;
    sslMode?: SslMode;
    sslRootCert?: string;
}

function decode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        // A raw `%` in a password is not an escape; keep it as typed.
        return text;
    }
}

// Dashboards that never show the password again, Supabase in particular, print
// a stand-in in the connection string. It is the whole password or nothing:
// a real password that merely contains brackets is left alone. The paste may
// still be percent-encoded, or already decoded.
function isPlaceholderPassword(text: string): boolean {
    let value = text.trim();
    for (let i = 0; i < 3 && value; i++) {
        if (placeholderToken(value)) return true;
        const decoded = decode(value).trim();
        if (decoded === value) return false;
        value = decoded;
    }
    return placeholderToken(value);
}

function placeholderToken(value: string): boolean {
    let inner = value.trim();
    let bracketed = false;
    const wrapped = /^(\[|<|\{)\s*([\s\S]*?)\s*(\]|>|\})$/.exec(inner);
    if (wrapped) {
        const open = wrapped[1];
        const close = wrapped[3];
        if ((open === '[' && close === ']') || (open === '<' && close === '>') || (open === '{' && close === '}')) {
            inner = wrapped[2].trim();
            bracketed = true;
        }
    }
    const token = inner.toLowerCase().replace(/[\s_]+/g, '-');
    if (token === 'your-password' || token === 'yourpassword') return true;
    // The word "password" on its own is something a person might have set.
    // The bracketed forms are what the dashboards print.
    return bracketed && token === 'password';
}

export function sslModeFromParam(value: string | null | undefined): SslMode | undefined {
    switch ((value ?? '').trim().toLowerCase()) {
        case 'disable':
            return 'disable';
        case 'allow':
        case 'prefer':
            return 'prefer';
        case 'require':
        case 'no-verify':
        case 'true':
        case '1':
            return 'require';
        case 'verify-ca':
            return 'verify-ca';
        case 'verify-full':
            return 'verify-full';
        default:
            return undefined;
    }
}

/** Strip what people paste around a URL: `psql '…'`, quotes, a `jdbc:` prefix. */
function unwrap(input: string): string {
    let text = input.trim();
    text = text.replace(/^psql\s+/i, '').trim();
    if (/^(['"`]).*\1$/s.test(text)) text = text.slice(1, -1).trim();
    text = text.replace(/^jdbc:/i, '');
    return text;
}

export function looksLikePostgresUrl(input: string): boolean {
    return /^(postgres|postgresql):\/\//i.test(unwrap(input));
}

/** Null when the text is not a postgres:// URL. */
export function parsePostgresUrl(input: string): ParsedPostgresUrl | null {
    const text = unwrap(input);
    const scheme = /^(postgres|postgresql):\/\//i.exec(text);
    if (!scheme) return null;
    const rest = text.slice(scheme[0].length);

    // userinfo ends at the last `@` before the path. A path or query rarely
    // contains `@`; an unencoded password often does.
    const queryStart = rest.indexOf('?');
    const beforeQuery = queryStart === -1 ? rest : rest.slice(0, queryStart);
    const at = beforeQuery.lastIndexOf('@');
    const userinfo = at === -1 ? '' : beforeQuery.slice(0, at);
    const afterUser = rest.slice(at + 1);

    const pathStart = afterUser.search(/[/?]/);
    const hostPart = pathStart === -1 ? afterUser : afterUser.slice(0, pathStart);
    const remainder = pathStart === -1 ? '' : afterUser.slice(pathStart);

    let username = '';
    let password = '';
    let passwordPlaceholder = false;
    if (userinfo) {
        const colon = userinfo.indexOf(':');
        username = decode(colon === -1 ? userinfo : userinfo.slice(0, colon));
        if (colon !== -1) {
            const rawPassword = userinfo.slice(colon + 1);
            if (isPlaceholderPassword(rawPassword)) passwordPlaceholder = true;
            else password = decode(rawPassword);
        }
    }

    // A host list (failover) connects to the first.
    const firstHost = hostPart.split(',')[0] ?? '';
    let host = '';
    let port = 5432;
    if (firstHost.startsWith('[')) {
        const close = firstHost.indexOf(']');
        host = firstHost.slice(1, close === -1 ? undefined : close);
        const after = close === -1 ? '' : firstHost.slice(close + 1);
        if (after.startsWith(':') && /^\d+$/.test(after.slice(1))) port = Number(after.slice(1));
    } else {
        const colon = firstHost.lastIndexOf(':');
        if (colon !== -1 && /^\d+$/.test(firstHost.slice(colon + 1))) {
            host = firstHost.slice(0, colon);
            port = Number(firstHost.slice(colon + 1));
        } else {
            host = firstHost;
        }
    }
    host = decode(host);

    let database = '';
    let query = '';
    if (remainder.startsWith('/')) {
        const q = remainder.indexOf('?');
        database = decode(q === -1 ? remainder.slice(1) : remainder.slice(1, q));
        query = q === -1 ? '' : remainder.slice(q + 1);
    } else if (remainder.startsWith('?')) {
        query = remainder.slice(1);
    }

    const params = new URLSearchParams(query);
    const param = (name: string) => params.get(name) ?? undefined;
    if (param('host') && !host) host = param('host')!;
    if (param('port') && /^\d+$/.test(param('port')!)) port = Number(param('port'));
    if (param('dbname') && !database) database = param('dbname')!;
    if (param('user') && !username) username = param('user')!;
    if (param('password') && !password && !passwordPlaceholder) {
        const rawPassword = param('password')!;
        if (isPlaceholderPassword(rawPassword)) passwordPlaceholder = true;
        else password = rawPassword;
    }

    let sslMode = sslModeFromParam(param('sslmode'));
    if (!sslMode && (param('ssl') === 'true' || param('ssl') === '1')) sslMode = 'require';

    if (!host) host = 'localhost';
    if (!database) database = username || 'postgres';

    return {
        host,
        port,
        database,
        username,
        password,
        ...(passwordPlaceholder ? { passwordPlaceholder: true } : {}),
        ...(sslMode ? { sslMode } : {}),
        ...(param('sslrootcert') ? { sslRootCert: param('sslrootcert') } : {}),
    };
}

/** Build a URL from fields. The password is left out unless asked for. */
export function formatPostgresUrl(
    cfg: { host: string; port: number; database: string; username: string; password?: string; sslMode?: SslMode },
    options: { includePassword?: boolean } = {},
): string {
    const user = encodeURIComponent(cfg.username);
    const pass = options.includePassword && cfg.password ? `:${encodeURIComponent(cfg.password)}` : '';
    const auth = user ? `${user}${pass}@` : '';
    const host = cfg.host.includes(':') && !cfg.host.startsWith('[') ? `[${cfg.host}]` : cfg.host;
    const ssl = cfg.sslMode && cfg.sslMode !== 'disable' ? `?sslmode=${cfg.sslMode}` : '';
    return `postgresql://${auth}${host}:${cfg.port}/${encodeURIComponent(cfg.database)}${ssl}`;
}
