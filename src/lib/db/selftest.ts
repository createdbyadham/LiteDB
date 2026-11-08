// Self-test for the app's pure database helpers: connection URLs, CSV, SQL
// literals and copy formats, cell parsing, the statement under the cursor,
// and the SSL settings handed to the MCP server.
//
//   npm run test:unit
//
// No database and no network: these are the parts that decide what text is
// sent, and they are cheap to pin down.

import { formatPostgresUrl, looksLikePostgresUrl, parsePostgresUrl } from './pgUrl';
import { detectDelimiter, headerNames, inferColumnType, parseCsv, sqlTypeFor } from './csv';
import { cellText, formatRows, sqlLiteral } from './sqlLiteral';
import { OmittedBlob } from './blob';
import { asJsonDocument, parseCellText, typeFamily } from './cellParse';
import { placeAfterStatement, statementAt, statementRanges } from '../sqlCursor';
import { titleFromSql } from '../editorTabs';
import { postgresTarget } from '../mcpHandoff';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
        process.stdout.write(`  ok   ${name}\n`);
    } else {
        failures++;
        process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
    }
}

function equal(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    check(name, a === e, `got ${a}, expected ${e}`);
}

function threw(fn: () => unknown): boolean {
    try {
        fn();
        return false;
    } catch {
        return true;
    }
}

process.stdout.write('connection URLs\n');
equal(
    'a Neon-style URL fills every field',
    parsePostgresUrl('postgresql://alex:AbC123@ep-cool-name.eu-central-1.aws.neon.tech/neondb?sslmode=require'),
    { host: 'ep-cool-name.eu-central-1.aws.neon.tech', port: 5432, database: 'neondb', username: 'alex', password: 'AbC123', sslMode: 'require' },
);
equal('the port is read when given', parsePostgresUrl('postgres://u:p@db:6543/app')?.port, 6543);
equal('an unencoded @ in the password does not move the host', parsePostgresUrl('postgres://u:p@ss@host:5432/db')?.host, 'host');
equal('...and the password keeps it', parsePostgresUrl('postgres://u:p@ss@host:5432/db')?.password, 'p@ss');
equal('percent-encoded passwords are decoded', parsePostgresUrl('postgres://u:p%2Fw%3Fd@h/db')?.password, 'p/w?d');
equal('a raw % that is not an escape is kept', parsePostgresUrl('postgres://u:100%@h/db')?.password, '100%');
equal('IPv6 hosts in brackets', parsePostgresUrl('postgres://u@[::1]:5433/db')?.host, '::1');
equal('psql wrappers and quotes are stripped', parsePostgresUrl("psql 'postgresql://u:p@h/db'")?.database, 'db');
equal('JDBC URLs read user and password from the query', parsePostgresUrl('jdbc:postgresql://h:5432/db?user=bob&password=x')?.username, 'bob');
equal('no-verify means encrypt without verifying', parsePostgresUrl('postgres://u@h/db?sslmode=no-verify')?.sslMode, 'require');
equal('ssl=true means require', parsePostgresUrl('postgres://u@h/db?ssl=true')?.sslMode, 'require');
equal('a failover host list connects to the first', parsePostgresUrl('postgres://u@a:5432,b:5432/db')?.host, 'a');
check('anything else is not a URL', parsePostgresUrl('host=localhost dbname=x') === null && !looksLikePostgresUrl('mysql://x'));
check(
    'the URL written back leaves the password out',
    formatPostgresUrl({ host: 'h', port: 5432, database: 'd b', username: 'u', password: 'secret', sslMode: 'require' }) ===
        'postgresql://u@h:5432/d%20b?sslmode=require',
);

process.stdout.write('\nCSV\n');
equal('quoted fields with commas, quotes and newlines', parseCsv('a,b\n"x, y","say ""hi""\nthere"\n'), [
    ['a', 'b'],
    ['x, y', 'say "hi"\nthere'],
]);
equal('CRLF line endings and a byte-order mark', parseCsv(String.fromCharCode(0xfeff) + 'a;b\r\n1;2\r\n', ';'), [
    ['a', 'b'],
    ['1', '2'],
]);
equal('blank lines are not records', parseCsv('a\n\nb\n'), [['a'], ['b']]);
equal('empty trailing fields are kept', parseCsv('a,,\n'), [['a', '', '']]);
equal('semicolons detected', detectDelimiter('a;b;c\n1;2;3\n4;5;6'), ';');
equal('tabs detected', detectDelimiter('a\tb\n1\t2'), '\t');
equal('commas detected despite a semicolon in a value', detectDelimiter('name,note\nx,"a;b"\ny,c'), ',');
equal('integers', inferColumnType(['1', '22', '', '-3']), 'integer');
equal('leading zeros stay text', inferColumnType(['02134', '10001']), 'text');
equal('decimals', inferColumnType(['1.5', '2', '.25']), 'real');
equal('dates', inferColumnType(['2026-01-02', '2025-12-31']), 'date');
equal('timestamps', inferColumnType(['2026-01-02 10:00:00', '2026-01-02T10:00:00Z']), 'timestamp');
equal('booleans', inferColumnType(['true', 'false', 'yes']), 'boolean');
equal('SQLite types', [sqlTypeFor('integer', 'sqlite'), sqlTypeFor('real', 'sqlite'), sqlTypeFor('date', 'sqlite')], ['INTEGER', 'REAL', 'TEXT']);
equal('Postgres types', [sqlTypeFor('integer', 'postgres'), sqlTypeFor('timestamp', 'postgres')], ['bigint', 'timestamptz']);
equal('empty and repeated header names are made unique', headerNames(['id', '', 'Id', 'name']), ['id', 'column_2', 'Id_2', 'name']);

process.stdout.write('\nSQL literals and copy formats\n');
equal('strings double their quotes', sqlLiteral("it's", 'sqlite'), "'it''s'");
equal('NULL', sqlLiteral(null, 'postgres'), 'NULL');
equal('booleans per dialect', [sqlLiteral(true, 'postgres'), sqlLiteral(true, 'sqlite')], ['TRUE', '1']);
equal('blobs per dialect', [sqlLiteral(new Uint8Array([0xde, 0xad]), 'sqlite'), sqlLiteral(new Uint8Array([0xde, 0xad]), 'postgres')], ["X'dead'", "'\\xdead'::bytea"]);
equal('non-finite numbers in Postgres', sqlLiteral(Number.NaN, 'postgres'), "'NaN'");
check('a NUL character is refused, not truncated', threw(() => sqlLiteral('a\0b', 'sqlite')));
check('an omitted blob cannot be written as SQL', threw(() => sqlLiteral(new OmittedBlob(10), 'sqlite')));
equal('cell text for blobs is base64', cellText(new Uint8Array([104, 105])), 'aGk=');
equal(
    'TSV quotes only what needs it',
    formatRows(['a', 'b'], [['x\ty', 'plain'], [null, 1]], 'tsv', { dialect: 'sqlite' }),
    'a\tb\n"x\ty"\tplain\n\t1',
);
equal(
    'INSERT uses the quoted table and columns',
    formatRows(['id', 'name'], [[1, "O'Brien"]], 'insert', { dialect: 'postgres', table: '"public"."people"', quotedColumns: ['"id"', '"name"'] }),
    `INSERT INTO "public"."people" ("id", "name") VALUES (1, 'O''Brien');`,
);
equal('one row as JSON is an object', formatRows(['a'], [[1]], 'json', { dialect: 'sqlite' }), '{\n  "a": 1\n}');
equal(
    'Markdown escapes pipes and shows NULL',
    formatRows(['a', 'b'], [['x|y', null]], 'markdown', { dialect: 'sqlite' }),
    '| a | b |\n| --- | --- |\n| x\\|y | NULL |',
);

process.stdout.write('\ncell parsing\n');
const col = (type: string, notnull = 0) => ({ name: 'c', type, notnull });
equal('integers become numbers', parseCellText(col('INTEGER'), '-42'), { ok: true, value: -42 });
equal('huge integers stay exact text', parseCellText(col('bigint'), '9007199254740993'), { ok: true, value: '9007199254740993' });
check('letters in an integer are refused', !parseCellText(col('int4'), '4x').ok);
equal('empty is NULL when allowed', parseCellText(col('text'), ''), { ok: true, value: null });
check('empty is refused when required', !parseCellText(col('text', 1), '').ok);
equal('booleans accept yes', parseCellText(col('boolean'), 'yes'), { ok: true, value: true });
check('invalid JSON is refused for json columns', !parseCellText(col('jsonb'), '{oops').ok);
equal('type families', [typeFamily('character varying(20)'), typeFamily('serial'), typeFamily('numeric(10,2)'), typeFamily('interval')], ['text', 'integer', 'number', 'text']);
check('JSON text is recognised for the viewer', JSON.stringify(asJsonDocument('{"a":[1,2]}')) === '{"a":[1,2]}');
check('plain text is not JSON', asJsonDocument('hello') === undefined && asJsonDocument('{not json}') === undefined);

process.stdout.write('\nthe statement under the cursor\n');
const script = "SELECT 1;\n\nSELECT ';' AS semi;\nSELECT 3";
const ranges = statementRanges(script);
equal('a semicolon in a string does not split', ranges.map((r) => r.sql), ['SELECT 1', "SELECT ';' AS semi", 'SELECT 3']);
equal('inside the second statement', statementAt(script, script.indexOf('semi'))?.sql, "SELECT ';' AS semi");
equal('right after a semicolon is the statement before it', statementAt(script, script.indexOf(';') + 1)?.sql, 'SELECT 1');
equal('a blank line belongs to the statement above', statementAt(script, script.indexOf('\n\n') + 1)?.sql, 'SELECT 1');
equal('the end of the script is the last statement', statementAt(script, script.length)?.sql, 'SELECT 3');
check('an empty script has no statement', statementAt('   ', 1) === null);

process.stdout.write('\nWhere Text to SQL puts its SQL\n');
/** The script after placing `sql` with the cursor at `offset`, and the placed text read back. */
function placed(script: string, offset: number, sql: string): [string, string] {
    const p = placeAfterStatement(script, offset, sql);
    const result = script.slice(0, p.from) + p.insert + script.slice(p.to);
    return [result, result.slice(p.start, p.start + sql.length)];
}
equal('an empty tab takes it whole', placed('', 0, 'SELECT 2'), ['SELECT 2', 'SELECT 2']);
equal('blank lines count as empty', placed('\n\n', 1, 'SELECT 2'), ['SELECT 2', 'SELECT 2']);
equal('after the statement, past its semicolon', placed('SELECT 1;', 3, 'SELECT 2'), ['SELECT 1;\n\nSELECT 2', 'SELECT 2']);
equal('a statement without a semicolon gets one', placed('SELECT 1', 8, 'SELECT 2'), ['SELECT 1;\n\nSELECT 2', 'SELECT 2']);
equal(
    'a statement below is not joined to the new one',
    placed('SELECT 1;\nSELECT 3;', 3, 'SELECT 2'),
    ['SELECT 1;\n\nSELECT 2;\nSELECT 3;', 'SELECT 2'],
);
equal(
    'SQL that ends in a semicolon gets no second one',
    placed('SELECT 1;\nSELECT 3;', 3, 'SELECT 2;'),
    ['SELECT 1;\n\nSELECT 2;\nSELECT 3;', 'SELECT 2;'],
);
equal('a space before the semicolon is kept', placed('SELECT 1 ;', 2, 'SELECT 2'), ['SELECT 1 ;\n\nSELECT 2', 'SELECT 2']);
equal(
    'trailing blank lines stay after the new statement',
    placed('SELECT 1\n\n', 0, 'SELECT 2'),
    ['SELECT 1;\n\nSELECT 2\n\n', 'SELECT 2'],
);
equal(
    'a semicolon in a string does not end the statement',
    placed("SELECT ';' AS x;", 2, 'SELECT 2'),
    ["SELECT ';' AS x;\n\nSELECT 2", 'SELECT 2'],
);
equal('tab titles come from the first line of SQL', titleFromSql('-- note\nselect * from orders where id = 1', 'Query 1'), 'select * from orders where i…');

process.stdout.write('\nSSL handed to the MCP server\n');
const base = { host: 'h', port: 5432, database: 'd', username: 'u', password: 'p', ssl: false };
check('off sends no sslmode', !postgresTarget({ ...base, sslMode: 'disable' }).includes('sslmode'));
check('require encrypts without verifying in node-pg', postgresTarget({ ...base, ssl: true, sslMode: 'require' }).endsWith('?sslmode=no-verify'));
check(
    'verify-full keeps verifying, with the CA file',
    postgresTarget({ ...base, ssl: true, sslMode: 'verify-full', sslRootCert: '/ca.pem' }).endsWith('?sslmode=verify-full&sslrootcert=%2Fca.pem'),
);
check('the old checkbox still means require', postgresTarget({ ...base, ssl: true }).endsWith('?sslmode=no-verify'));

process.stdout.write('\n');
process.stdout.write(failures === 0 ? 'self-test passed\n' : `self-test FAILED (${failures})\n`);
process.exitCode = failures === 0 ? 0 : 1;
