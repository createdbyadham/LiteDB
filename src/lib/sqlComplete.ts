// Column names without typing `table.` first.
//
// lang-sql completes a column only after `orders.` or an alias. This adds the
// bare names: the columns of the tables the statement reads (its FROM, JOIN,
// UPDATE and INTO), ranked above keywords, or of every table while there is
// no FROM yet. A name two of those tables share comes qualified (`o.id`,
// `c.id`), so what goes in is never ambiguous. Nothing is offered where a
// table name belongs, right after FROM or JOIN, or where no name does.
//
// Built on the tokenizer the safety layer uses, so strings and comments are
// never read as names. Free of CodeMirror and browser imports so the
// self-test can run it.

import { tokenize, type SqlToken } from './sqlTokenizer';
import { completionName } from './types';

export interface CatalogColumn {
    name: string;
    type: string;
}

export interface CatalogTable {
    /** Postgres schema; null for SQLite. */
    schema: string | null;
    table: string;
    columns: CatalogColumn[];
}

export interface ColumnCatalog {
    dialect: 'sqlite' | 'postgres';
    /** Postgres: where an unqualified table name resolves. */
    defaultSchema: string | null;
    tables: CatalogTable[];
}

/** A name as the statement spells it. */
export interface NamePart {
    name: string;
    /** Quoted names keep their case; bare ones fold (Postgres) or ignore it (SQLite). */
    quoted: boolean;
}

/** A table the statement reads. */
export interface TableRef {
    schema: NamePart | null;
    table: NamePart;
    alias: NamePart | null;
}

export interface ColumnOption {
    /** Matched against what is typed: always the bare column name. */
    label: string;
    /** Shown instead of the label when they differ: `o.id` for a shared name. */
    display?: string;
    /** What goes in, quoted where the database needs it. */
    apply: string;
    detail: string;
    boost: number;
}

/** Words that start or join clauses: never read as a table name or an alias. */
const KEYWORDS = new Set(
    (
        'SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING GROUP BY ORDER HAVING ' +
        'LIMIT OFFSET FETCH FOR UNION INTERSECT EXCEPT ALL DISTINCT AS SET UPDATE INSERT INTO VALUES DELETE ' +
        'RETURNING WITH RECURSIVE AND OR NOT IN IS NULL LIKE ILIKE GLOB BETWEEN EXISTS CASE WHEN THEN ELSE END ' +
        'ASC DESC NULLS WINDOW OVER PARTITION LATERAL TABLESAMPLE TABLE CREATE ALTER DROP INDEX VIEW DEFAULT ' +
        'CONFLICT DO NOTHING REPLACE INDEXED COLLATE ESCAPE TRUE FALSE ONLY'
    ).split(' '),
);

/** After these a table name belongs, not a column. */
const TABLE_AFTER = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE']);

/** After these nothing from the catalog belongs: an alias, a count, literal values. */
const NOTHING_AFTER = new Set(['AS', 'LIMIT', 'OFFSET', 'VALUES']);

const isPunct = (t: SqlToken | undefined, value: string): boolean => t?.kind === 'punct' && t.value === value;

function namePart(t: SqlToken | undefined, sql: string): NamePart | null {
    if (!t) return null;
    if (t.kind === 'ident') return { name: t.value, quoted: true };
    if (t.kind === 'word' && !KEYWORDS.has(t.value)) return { name: sql.slice(t.start, t.end), quoted: false };
    return null;
}

/**
 * `schema.table [AS] alias` starting at token `start`, or null if no table
 * starts there. `callIsNotTable`: after FROM or JOIN, `name(` is a function;
 * after INTO it is the column list.
 */
function readTableRef(tokens: SqlToken[], start: number, sql: string, callIsNotTable: boolean): { ref: TableRef; next: number } | null {
    let j = start;
    if (tokens[j]?.kind === 'word' && tokens[j].value === 'ONLY') j++;
    const parts: NamePart[] = [];
    for (;;) {
        const part = namePart(tokens[j], sql);
        if (!part) break;
        parts.push(part);
        j++;
        if (!isPunct(tokens[j], '.')) break;
        j++;
    }
    if (parts.length === 0) return null;
    // A function in FROM, generate_series(...), is not a table.
    if (callIsNotTable && isPunct(tokens[j], '(')) return null;
    if (tokens[j]?.kind === 'word' && tokens[j].value === 'AS') j++;
    const alias = namePart(tokens[j], sql);
    if (alias) j++;
    return {
        ref: { schema: parts.length > 1 ? parts[parts.length - 2] : null, table: parts[parts.length - 1], alias },
        next: j,
    };
}

/** The tables a statement reads, in the order it names them. */
export function tablesIn(sql: string): TableRef[] {
    return readTables(tokenize(sql), sql);
}

function readTables(tokens: SqlToken[], sql: string): TableRef[] {
    const refs: TableRef[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.kind !== 'word' || !(t.value === 'FROM' || t.value === 'JOIN' || t.value === 'UPDATE' || t.value === 'INTO')) continue;
        let j = i + 1;
        // FROM takes a list (FROM a, b); the others take one table.
        for (;;) {
            const read = readTableRef(tokens, j, sql, t.value !== 'INTO');
            if (!read) break;
            refs.push(read.ref);
            j = read.next;
            if (t.value !== 'FROM' || !isPunct(tokens[j], ',') || tokens[j].depth !== t.depth) break;
            j++;
        }
    }
    return refs;
}

/** What belongs at `offset`: a column, a table name, or neither. */
function positionAt(tokens: SqlToken[], offset: number): 'column' | 'table' | 'none' {
    const before = tokens.filter((t) => t.end <= offset);
    const last = before[before.length - 1];
    const depth = !last ? 0 : isPunct(last, '(') ? last.depth + 1 : last.depth;
    for (let i = before.length - 1; i >= 0; i--) {
        const t = before[i];
        // Inside a group that closed before the cursor.
        if (t.depth > depth) continue;
        if (t.depth < depth) {
            // The `(` that opens the cursor's group. VALUES (…) holds values;
            // INSERT INTO t (…), a function's arguments and IN (…) take columns.
            const prev = before[i - 1];
            return prev?.kind === 'word' && prev.value === 'VALUES' ? 'none' : 'column';
        }
        if (t.kind === 'word' && KEYWORDS.has(t.value)) {
            if (TABLE_AFTER.has(t.value)) return 'table';
            if (NOTHING_AFTER.has(t.value)) return 'none';
            return 'column';
        }
        // Names, dots, commas, operators and literals: keep looking back.
    }
    return 'column';
}

function findTable(catalog: ColumnCatalog, ref: TableRef): CatalogTable | null {
    if (catalog.dialect === 'sqlite') {
        // A SQLite schema is a database name (main, temp); names ignore case.
        const name = ref.table.name.toLowerCase();
        return catalog.tables.find((t) => t.table.toLowerCase() === name) ?? null;
    }
    const fold = (p: NamePart) => (p.quoted ? p.name : p.name.toLowerCase());
    const table = fold(ref.table);
    if (ref.schema) {
        const schema = fold(ref.schema);
        return catalog.tables.find((t) => t.schema === schema && t.table === table) ?? null;
    }
    const inDefault = catalog.tables.find((t) => t.schema === catalog.defaultSchema && t.table === table);
    if (inDefault) return inDefault;
    const anywhere = catalog.tables.filter((t) => t.table === table);
    return anywhere.length === 1 ? anywhere[0] : null;
}

/** A name as the statement wrote it, quoted again if it was quoted there. */
function written(part: NamePart): string {
    return part.quoted ? `"${part.name.replace(/"/g, '""')}"` : part.name;
}

/** One entry per column name across the whole catalog, for a statement with no FROM yet. */
function everyColumn(catalog: ColumnCatalog, key: (name: string) => string): ColumnOption[] {
    const byName = new Map<string, { column: CatalogColumn; tables: string[] }>();
    for (const table of catalog.tables) {
        for (const column of table.columns) {
            const entry = byName.get(key(column.name));
            if (entry) entry.tables.push(table.table);
            else byName.set(key(column.name), { column, tables: [table.table] });
        }
    }
    return [...byName.values()].map(({ column, tables }) => ({
        label: column.name,
        apply: completionName(column.name, catalog.dialect),
        detail: tables.length === 1 ? `${tables[0]} · ${column.type}` : `${tables[0]} +${tables.length - 1}`,
        boost: 0,
    }));
}

/**
 * Column completions for the cursor at `offset` in `statement`, or null where
 * a column does not belong. `offset` is where the word being typed starts.
 */
export function columnOptions(catalog: ColumnCatalog, statement: string, offset: number): ColumnOption[] | null {
    const tokens = tokenize(statement);
    // Column definitions name new columns.
    if (tokens[0]?.kind === 'word' && tokens[0].value === 'CREATE') return null;
    if (positionAt(tokens, offset) !== 'column') return null;

    const key = (name: string) => (catalog.dialect === 'sqlite' ? name.toLowerCase() : name);
    const scoped: { ref: TableRef; table: CatalogTable }[] = [];
    for (const ref of readTables(tokens, statement)) {
        const table = findTable(catalog, ref);
        if (table) scoped.push({ ref, table });
    }
    if (scoped.length === 0) return everyColumn(catalog, key);

    // How many of the statement's tables have each name: shared ones need a qualifier.
    const counts = new Map<string, number>();
    for (const { table } of scoped) {
        for (const column of table.columns) counts.set(key(column.name), (counts.get(key(column.name)) ?? 0) + 1);
    }
    const options: ColumnOption[] = [];
    for (const { ref, table } of scoped) {
        const qualifier = ref.alias ?? ref.table;
        for (const column of table.columns) {
            const name = completionName(column.name, catalog.dialect);
            if ((counts.get(key(column.name)) ?? 0) > 1) {
                // Labelled with the bare name so typing `i` finds `o.id`:
                // a one-letter query only matches the start of a label.
                options.push({
                    label: column.name,
                    display: `${qualifier.name}.${column.name}`,
                    apply: `${written(qualifier)}.${name}`,
                    detail: `${table.table} · ${column.type}`,
                    boost: 2,
                });
            } else {
                options.push({ label: column.name, apply: name, detail: `${table.table} · ${column.type}`, boost: 2 });
            }
        }
    }
    return options;
}
