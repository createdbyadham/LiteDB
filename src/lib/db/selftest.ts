// Self-test for the app's pure database helpers: connection URLs, CSV, SQL
// literals and copy formats, cell parsing, the statement under the cursor,
// inline suggestions, and the SSL settings handed to the MCP server.
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
import { completionName } from '../types';
import { columnOptions, tablesIn, type ColumnCatalog } from '../sqlComplete';
import { classifyStatement } from '../sqlClassifier';
import {
    buildDiffQuery,
    columnIndex,
    formatCell,
    parseDecision,
    parseRequest,
    requestToken,
    serializeRequest,
    shapeDiff,
    type ApprovalRequest,
} from '../agentApproval';
import {
    InlineSuggester,
    buildInlinePrompt,
    cleanSuggestion,
    inlineContext,
    reconcile,
    schemaComment,
    typeThrough,
    type InlinePrompt,
} from '../inlineSuggest';

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

process.stdout.write('\nNames as autocomplete inserts them\n');
equal('SQLite: capitals go in as written', completionName('Suppliers', 'sqlite'), 'Suppliers');
equal('SQLite: a space is quoted', completionName('Unit Price', 'sqlite'), '"Unit Price"');
equal('SQLite: a plain name stays plain', completionName('customer_id', 'sqlite'), 'customer_id');
equal('Postgres: capitals are quoted, or they fold to lower case', completionName('createdAt', 'postgres'), '"createdAt"');
equal('Postgres: a lower-case name stays plain', completionName('created_at', 'postgres'), 'created_at');
equal('a leading digit is quoted', completionName('2fa', 'postgres'), '"2fa"');
equal('a quote inside a name is doubled', completionName('a"b', 'postgres'), '"a""b"');

process.stdout.write('\nColumn names without table. first\n');
const shop: ColumnCatalog = {
    dialect: 'sqlite',
    defaultSchema: null,
    tables: [
        { schema: null, table: 'orders', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'customer_id', type: 'INTEGER' }, { name: 'status', type: 'TEXT' }] },
        { schema: null, table: 'customers', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }] },
        { schema: null, table: 'Order Details', columns: [{ name: 'Unit Price', type: 'REAL' }] },
    ],
};
/** Options with the cursor where `|` is, and the `|` removed. */
function at(catalog: ColumnCatalog, sqlWithCursor: string) {
    const offset = sqlWithCursor.indexOf('|');
    const sql = sqlWithCursor.replace('|', '');
    // The word being typed starts where its letters do.
    let from = offset;
    while (from > 0 && /[A-Za-z0-9_$]/.test(sql[from - 1])) from--;
    return columnOptions(catalog, sql, from);
}
/** What the popup shows for each option. */
const labels = (options: ReturnType<typeof at>) => (options ? options.map((o) => o.display ?? o.label) : null);
equal(
    'FROM and JOIN tables with their aliases',
    tablesIn('SELECT * FROM orders o JOIN customers AS c ON c.id = o.customer_id').map((t) => [t.table.name, t.alias?.name ?? null]),
    [['orders', 'o'], ['customers', 'c']],
);
equal('a FROM list, UPDATE and INSERT INTO', tablesIn('UPDATE a SET x = 1; INSERT INTO b (y) SELECT * FROM c, d').map((t) => t.table.name), ['a', 'b', 'c', 'd']);
equal("names in strings and comments are not tables", tablesIn("SELECT 'FROM fake' FROM real -- FROM other").map((t) => t.table.name), ['real']);
check('nothing after FROM: a table belongs there', at(shop, 'SELECT * FROM |') === null);
check('nothing after AS: an alias belongs there', at(shop, 'SELECT count(*) AS n| FROM orders') === null);
check('nothing inside VALUES', at(shop, 'INSERT INTO orders (status) VALUES (|') === null);
equal('the FROM table\'s columns, even when FROM comes later', labels(at(shop, 'SELECT st| FROM orders')), ['id', 'customer_id', 'status']);
equal(
    'a name two tables share comes qualified by alias',
    labels(at(shop, 'SELECT | FROM orders o JOIN customers c ON c.id = o.customer_id')),
    ['o.id', 'customer_id', 'status', 'c.id', 'name'],
);
equal(
    'a shared name is still found by its first letter',
    at(shop, 'SELECT i| FROM orders o JOIN customers c ON c.id = o.customer_id')
        ?.filter((o) => o.label.startsWith('i'))
        .map((o) => o.apply),
    ['o.id', 'c.id'],
);
equal('INSERT INTO t ( lists t\'s columns', labels(at(shop, 'INSERT INTO customers (|')), ['id', 'name']);
equal('a column that needs quotes is inserted quoted', at(shop, 'SELECT | FROM "Order Details"')?.[0]?.apply, '"Unit Price"');
equal(
    'with no FROM yet, every column once',
    at(shop, 'SELECT i|')?.map((o) => `${o.label}: ${o.detail}`),
    ['id: orders +1', 'customer_id: orders · INTEGER', 'status: orders · TEXT', 'name: customers · TEXT', 'Unit Price: Order Details · REAL'],
);
const pgCatalog: ColumnCatalog = {
    dialect: 'postgres',
    defaultSchema: 'public',
    tables: [
        { schema: 'public', table: 'users', columns: [{ name: 'createdAt', type: 'timestamp' }] },
        { schema: 'auth', table: 'sessions', columns: [{ name: 'token', type: 'text' }] },
    ],
};
equal('Postgres: a bare name folds to lower case', labels(at(pgCatalog, 'SELECT | FROM Users')), ['createdAt']);
equal('Postgres: camelCase goes in quoted', at(pgCatalog, 'SELECT | FROM users')?.[0]?.apply, '"createdAt"');
equal('Postgres: schema-qualified tables', labels(at(pgCatalog, 'SELECT | FROM auth.sessions s')), ['token']);

process.stdout.write('\nWhat an agent approval shows\n');
const diffSql = (sql: string) => buildDiffQuery(classifyStatement(sql))?.sql ?? null;
equal('a DELETE shows the rows it deletes', diffSql("DELETE FROM orders WHERE status = 'new'"), "SELECT * FROM orders WHERE status = 'new' LIMIT 21");
equal('an unbounded DELETE shows the table', diffSql('DELETE FROM orders'), 'SELECT * FROM orders LIMIT 21');
equal(
    'an UPDATE computes each new value beside the old',
    diffSql("UPDATE orders o SET status = 'paid', total = total * 2 WHERE o.id < 4"),
    "SELECT *, ('paid') AS __litedb_new_0, (total * 2) AS __litedb_new_1 FROM orders o WHERE o.id < 4 LIMIT 21",
);
equal(
    'a quoted column keeps its name',
    buildDiffQuery(classifyStatement('UPDATE "Order Details" SET "Unit Price" = 1 WHERE "OrderID" = 7'))?.assigned,
    ['Unit Price'],
);
check('UPDATE … FROM is not sampled: the join would have to be repeated', diffSql('UPDATE a SET x = b.y FROM b WHERE a.id = b.id') === null);
check('a tuple assignment is not sampled', diffSql('UPDATE t SET (a, b) = (1, 2) WHERE id = 1') === null);
const insertDiff = buildDiffQuery(classifyStatement("INSERT INTO people (name, score) VALUES ('Ada', 1), ('Alan', 2) ON CONFLICT DO NOTHING"));
equal(
    'an INSERT shows the rows its source produces',
    insertDiff && { sql: insertDiff.sql, columns: insertDiff.insertColumns },
    { sql: "SELECT * FROM (VALUES ('Ada', 1), ('Alan', 2)) AS __litedb_source LIMIT 21", columns: ['name', 'score'] },
);
equal(
    'INSERT … SELECT samples the SELECT',
    diffSql('INSERT INTO archive SELECT * FROM orders WHERE total < 5'),
    'SELECT * FROM (SELECT * FROM orders WHERE total < 5) AS __litedb_source LIMIT 21',
);
check('DEFAULT VALUES has nothing to show', diffSql('INSERT INTO t DEFAULT VALUES') === null);
check('DDL has no rows to show', diffSql('DROP TABLE orders') === null);
const updated = shapeDiff(
    { mode: 'update', sql: '', assigned: ['status'] },
    { columns: ['id', 'status', '__litedb_new_0'], rows: [[1, 'new', 'paid'], [2, null, 'paid']] },
);
equal('an UPDATE sample keeps old and new apart', [updated.columns, updated.rows, updated.changes], [
    ['id', 'status'],
    [['1', 'new'], ['2', 'NULL']],
    [{ column: 'status', values: ['paid', 'paid'] }],
]);
check('one row more than shown means there are more', shapeDiff({ mode: 'delete', sql: '' }, { columns: ['id'], rows: [[1], [2], [3]] }, 2).truncated);
equal('cells read as text', [formatCell(null), formatCell(new Uint8Array(3)), formatCell('x'.repeat(200)).length], ['NULL', '[3 bytes]', 120]);
equal('column names match ignoring case', columnIndex(['ID', 'Status'], 'status'), 1);
equal('request files are told from answers', [requestToken('abc.json'), requestToken('abc.decision.json'), requestToken('abc.json.partial')], ['abc', null, null]);
const sample: ApprovalRequest = {
    version: 1, token: 't1', createdAt: '2026-11-09T10:00:00Z', expiresAt: '2026-11-09T10:05:00Z', client: 'claude-code',
    connection: 'sqlite:/a.db', connectionId: 'sqlite:/a.db', dialect: 'sqlite', policy: 'guarded', reason: 'r',
    destructive: true, requireTypedConfirmation: false, confirmPhrase: 'orders',
    statements: [{ sql: 'DELETE FROM orders WHERE id = 1', kind: 'destructive', verb: 'DELETE', table: 'orders', unbounded: false, reason: '',
        affectedRows: 1, estimatedRows: null, tableRows: 5, tableRowsCapped: false, diff: null }],
};
equal('a request reads back as written', parseRequest(serializeRequest(sample)), sample);
check('a request from a newer version is ignored', parseRequest(JSON.stringify({ ...sample, version: 2 })) === null);
check('an answer for another token does not count', parseDecision(JSON.stringify({ token: 'x', decision: 'approved' }), 't1') === null);
check('an answer must say approved or declined', parseDecision(JSON.stringify({ token: 't1', decision: 'yes' }), 't1') === null);

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

process.stdout.write('\nInline suggestions: what is sent\n');
/** Prefix and suffix of the statement at the cursor, with the cursor where `|` is. */
function around(sqlWithCursor: string): [string, string] | null {
    const context = inlineContext(sqlWithCursor.replace('|', ''), sqlWithCursor.indexOf('|'));
    return context && [context.prefix, context.suffix];
}
equal('the statement the cursor is in, not the one above', around('SELECT 1;\nSELECT * FROM |'), ['SELECT * FROM ', '']);
equal('a ; in a string does not split, and the suffix keeps its ;', around("SELECT ';' AS x, | FROM t; SELECT 2"), ["SELECT ';' AS x, ", ' FROM t;']);
equal('a blank line ends a statement on both sides', around('SELECT 1\n\nSELECT * FROM t WHERE |\n\nSELECT 3'), ['SELECT * FROM t WHERE ', '']);
equal('a comment just above starts the statement', around('-- customers by revenue\n|'), ['-- customers by revenue\n', '']);
check('nothing in the middle of a word', around('SELECT na|me FROM t') === null);
check('nothing inside a comment', around('-- top customers|') === null && around('SELECT 1 /* note | */') === null);
check('nothing after a finished statement', around('SELECT 1;|') === null && around('SELECT 1\n\n|') === null);
equal(
    'columns for the tables the statement reads, names for the rest',
    schemaComment('sqlite', shop, 'SELECT * FROM orders o JOIN customers c ON '),
    '-- Dialect: SQLite\n-- Table orders (id INTEGER, customer_id INTEGER, status TEXT)\n-- Table customers (id INTEGER, name TEXT)\n-- Other tables: "Order Details"\n',
);
equal('with no table yet, names only', schemaComment('sqlite', shop, 'SELECT '), '-- Dialect: SQLite\n-- Tables: orders, customers, "Order Details"\n');
equal(
    'Postgres: quoted columns, and a schema on tables outside the default',
    schemaComment('postgres', pgCatalog, 'SELECT * FROM users'),
    '-- Dialect: PostgreSQL\n-- Table users ("createdAt" timestamp)\n-- Other tables: auth.sessions\n',
);
const wide: ColumnCatalog = {
    dialect: 'sqlite',
    defaultSchema: null,
    tables: Array.from({ length: 300 }, (_, t) => ({
        schema: null,
        table: `table_${String(t).padStart(3, '0')}`,
        columns: Array.from({ length: 60 }, (_, c) => ({ name: `column_${c}`, type: 'INTEGER' })),
    })),
};
const capped = schemaComment('sqlite', wide, 'SELECT * FROM table_000 JOIN table_001 ON ');
check('300 tables of 60 columns stay short', capped.length < 2000, `${capped.length} characters`);
check('...and say what was left out', /-- Table table_000 \(.*… \d+ more\)/.test(capped) && /… \d+ more\n$/.test(capped));
const long = buildInlinePrompt({ from: 0, pos: 6007, prefix: `SELECT\n${'a,\n'.repeat(2000)}`, suffix: '' }, 'sqlite', null);
check('a long statement is cut from the start, at a line', long.prefix.length <= 1200 && long.prefix.startsWith('a,') && long.prefix.endsWith('a,\n'));
check(
    'the cache tells statements apart by what follows the cursor',
    buildInlinePrompt({ from: 0, pos: 7, prefix: 'SELECT ', suffix: '' }, 'sqlite', shop).key !==
        buildInlinePrompt({ from: 0, pos: 7, prefix: 'SELECT ', suffix: ' FROM orders' }, 'sqlite', shop).key,
);

process.stdout.write('\nInline suggestions: what is kept\n');
const fim = { fim: true };
equal('code fences are stripped', cleanSuggestion('```sql\nid = 1\n```', 'SELECT * FROM t WHERE ', ''), 'id = 1');
equal('a restated statement keeps only what is new', cleanSuggestion('SELECT * FROM users WHERE id = 1', 'SELECT * FROM users WHERE ', ''), 'id = 1');
equal('a restated word keeps only its rest', cleanSuggestion('email FROM users', 'SELECT e', ''), 'mail FROM users');
equal('fill-in-the-middle keeps a doubled letter', cleanSuggestion('ardvarks', 'SELECT * FROM a', '', fim), 'ardvarks');
equal('a tail that repeats the suffix goes', cleanSuggestion('id, name FROM users', 'SELECT ', ' FROM users;', fim), 'id, name');
equal('...and so does one that runs on past it', cleanSuggestion('id FROM users WHERE id = 1', 'SELECT ', ' FROM users', fim), 'id');
equal('half a word is not a repeat', cleanSuggestion('a, id', 'SELECT ', ' identity_col FROM t', fim), 'a, id');
equal('a bracket the suffix already closes goes', cleanSuggestion('*) FROM users', 'SELECT COUNT(', ')', fim), '*');
equal('brackets it opens itself stay', cleanSuggestion('SUM(x)', 'SELECT COALESCE(', ', 0)', fim), 'SUM(x)');
equal('a quote the suffix already closes goes', cleanSuggestion("pending'", "SELECT * FROM t WHERE status = '", "'", fim), 'pending');
equal('it stops at a semicolon', cleanSuggestion('id = 1; DROP TABLE t', 'SELECT * FROM t WHERE ', ''), 'id = 1');
equal('...and at a blank line', cleanSuggestion('1\n\nSELECT 2', 'SELECT * FROM t LIMIT ', '', fim), '1');
equal('a ; inside a string is not the end', cleanSuggestion("'a;b'", 'SELECT ', '', fim), "'a;b'");
equal('one space after the prefix, not two', cleanSuggestion(' FROM users', 'SELECT * ', '', fim), 'FROM users');
equal('a line break to start with stays', cleanSuggestion('\nFROM users', 'SELECT *', '', fim), '\nFROM users');
check(
    'nothing left is null',
    cleanSuggestion('```\n```', 'SELECT ', '') === null && cleanSuggestion(' FROM users', 'SELECT *', ' FROM users', fim) === null,
);
const shownGhost = { pos: 10, text: 'FROM users' };
equal('typing its next letters keeps the rest', typeThrough(shownGhost, 10, 10, 'FR'), { pos: 12, text: 'OM users' });
check('typing anything else clears it', typeThrough(shownGhost, 10, 10, 'x') === null);
check('so does deleting, or typing all of it', typeThrough(shownGhost, 9, 10, '') === null && typeThrough(shownGhost, 10, 10, 'FROM users') === null);
const asked = { from: 0, pos: 11, prefix: 'SELECT * FR', suffix: '' };
equal('a late answer drops what was typed meanwhile', reconcile(asked, { from: 0, pos: 12, prefix: 'SELECT * FRO', suffix: '' }, 'OM users'), 'M users');
check('...unless what was typed differs from it', reconcile(asked, { from: 0, pos: 12, prefix: 'SELECT * FRX', suffix: '' }, 'OM users') === null);
check('...or the text after the cursor changed', reconcile(asked, { from: 0, pos: 11, prefix: 'SELECT * FR', suffix: ' x' }, 'OM users') === null);

/** When to ask: one request at a time, a cache, and a pause after a failure. Async, so it runs last. */
async function suggesterChecks(): Promise<void> {
    process.stdout.write('\nInline suggestions: when to ask\n');
    const prompt = (key: string): InlinePrompt => ({ context: '', prefix: key, suffix: '', key });
    let clock = 0;
    let calls = 0;
    let answer: (p: InlinePrompt) => Promise<string | null> = async (p) => `${p.prefix}!`;
    const suggester = new InlineSuggester(
        (p) => {
            calls++;
            return answer(p);
        },
        { now: () => clock, backoffMs: 30_000 },
    );
    equal('a pause asks', await suggester.suggest(prompt('a')), { kind: 'ok', text: 'a!', cached: false });
    equal('the same statement again comes from the cache', await suggester.suggest(prompt('a')), { kind: 'ok', text: 'a!', cached: true });
    check('...without asking again', calls === 1, `${calls} calls`);

    let release: (text: string) => void = () => undefined;
    answer = () =>
        new Promise<string>((resolve) => {
            release = resolve;
        });
    const slow = suggester.suggest(prompt('b'));
    equal('one request at a time', await suggester.suggest(prompt('c')), { kind: 'busy' });
    release('b!');
    equal('...and its answer still arrives', await slow, { kind: 'ok', text: 'b!', cached: false });

    answer = async () => {
        throw new Error('down');
    };
    check('a failure is reported', (await suggester.suggest(prompt('d'))).kind === 'failed');
    equal('then it waits before asking again', await suggester.suggest(prompt('e')), { kind: 'cooling' });
    equal('cached answers still show meanwhile', await suggester.suggest(prompt('a')), { kind: 'ok', text: 'a!', cached: true });
    clock += 30_001;
    answer = async (p) => `${p.prefix}!`;
    equal('30 seconds later it asks again', await suggester.suggest(prompt('e')), { kind: 'ok', text: 'e!', cached: false });

    suggester.reset();
    const before = calls;
    await suggester.suggest(prompt('a'));
    check('another model forgets the cached answers', calls === before + 1, `${calls - before} calls`);

    const hung = new InlineSuggester(() => new Promise<string | null>(() => undefined), { timeoutMs: 20 });
    check('a request that never answers frees the slot', (await hung.suggest(prompt('f'))).kind === 'failed');
}

process.stdout.write('\nSSL handed to the MCP server\n');
const base = { host: 'h', port: 5432, database: 'd', username: 'u', password: 'p', ssl: false };
check('off sends no sslmode', !postgresTarget({ ...base, sslMode: 'disable' }).includes('sslmode'));
check('require encrypts without verifying in node-pg', postgresTarget({ ...base, ssl: true, sslMode: 'require' }).endsWith('?sslmode=no-verify'));
check(
    'verify-full keeps verifying, with the CA file',
    postgresTarget({ ...base, ssl: true, sslMode: 'verify-full', sslRootCert: '/ca.pem' }).endsWith('?sslmode=verify-full&sslrootcert=%2Fca.pem'),
);
check('the old checkbox still means require', postgresTarget({ ...base, ssl: true }).endsWith('?sslmode=no-verify'));

void suggesterChecks()
    .catch((error: unknown) => {
        failures++;
        process.stdout.write(`  FAIL the suggester checks threw — ${String(error)}\n`);
    })
    .then(() => {
        process.stdout.write('\n');
        process.stdout.write(failures === 0 ? 'self-test passed\n' : `self-test FAILED (${failures})\n`);
        process.exitCode = failures === 0 ? 0 : 1;
    });
