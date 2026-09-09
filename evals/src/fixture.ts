// Fixture database construction and read-only execution.
//
// Layer two of the safety model (layer one is guard.ts): the connection that
// runs model-generated SQL physically cannot write. SQLite gets a read-only
// connection to a throwaway temp file; Postgres runs every query inside a
// READ ONLY transaction that is always rolled back.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSchema, TableSchema } from '../../src/lib/schemaTypes';
import { attachSampleValues } from '../../src/lib/schemaSamples';
import type { Dialect, FixtureDb, FixtureName } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', 'fixtures');

/** File stems per fixture. The storefront names are historical. */
const FIXTURE_FILES: Record<FixtureName, { sqlite: string; postgres: string; seed: string }> = {
    storefront: { sqlite: 'schema.sqlite.sql', postgres: 'schema.postgres.sql', seed: 'seed.sql' },
    library: { sqlite: 'library.sqlite.sql', postgres: 'library.postgres.sql', seed: 'library.seed.sql' },
};

function readFixture(name: string): string {
    return readFileSync(join(FIXTURES, name), 'utf8');
}

/** Split a script into statements, ignoring semicolons inside string literals. */
function splitStatements(script: string): string[] {
    const withoutComments = script.replace(/--[^\n]*/g, '');
    const statements: string[] = [];
    let current = '';
    let inString = false;

    for (let i = 0; i < withoutComments.length; i++) {
        const ch = withoutComments[i];
        if (ch === "'") {
            inString = !inString;
            current += ch;
            continue;
        }
        if (ch === ';' && !inString) {
            if (current.trim()) statements.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    if (current.trim()) statements.push(current.trim());
    return statements;
}

// ---------------------------------------------------------------- SQLite ---

function introspectSqlite(db: DatabaseSync): DatabaseSchema {
    const tableRows = db
        .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name`,
        )
        .all() as Array<{ name: string }>;

    const tables: TableSchema[] = tableRows.map((t) => {
        const cols = db.prepare(`PRAGMA table_info(${t.name})`).all() as Array<{
            name: string;
            type: string;
            notnull: number;
            pk: number;
        }>;
        return {
            name: t.name,
            columns: cols.map((c) => ({
                name: c.name,
                type: c.type,
                isPrimaryKey: c.pk === 1,
                isNotNull: c.notnull === 1,
            })),
        };
    });

    return { dialect: 'sqlite', tables };
}

export interface FixtureOptions {
    /** Which fixture database to build. Defaults to 'storefront'. */
    name?: FixtureName;
    /**
     * Include sample values for enumerated columns. Off makes the run a
     * control for measuring what that context is actually worth.
     */
    includeSamples?: boolean;
}

export async function createSqliteFixture(options: FixtureOptions = {}): Promise<FixtureDb> {
    const name = options.name ?? 'storefront';
    const files = FIXTURE_FILES[name];
    const dir = mkdtempSync(join(tmpdir(), 'litedb-eval-'));
    const path = join(dir, 'fixture.sqlite');

    // Build with a writable connection...
    const writer = new DatabaseSync(path);
    for (const statement of splitStatements(readFixture(files.sqlite))) {
        writer.exec(statement);
    }
    for (const statement of splitStatements(readFixture(files.seed))) {
        writer.exec(statement);
    }
    const baseSchema = introspectSqlite(writer);
    writer.close();

    // ...then hand the runner a connection that cannot write at all.
    const reader = new DatabaseSync(path, { readOnly: true });

    const run = async (sql: string): Promise<unknown[][]> => {
        const statement = reader.prepare(sql);
        // Positional rows, not objects: a query selecting two columns that
        // happen to share a name (SELECT o.id, c.id ...) would silently
        // collapse to one key as an object, understating the column count
        // and failing a correct answer. @types/node still declares all()
        // as returning objects regardless of this flag, hence the cast.
        statement.setReturnArrays(true);
        return statement.all() as unknown as unknown[][];
    };

    // Sampled through the same read-only connection the runner uses, so the
    // harness cannot see anything a scored query could not.
    const schema =
        options.includeSamples === false
            ? baseSchema
            : await attachSampleValues(baseSchema, run);

    return {
        dialect: 'sqlite',
        name,
        schema,
        run,
        async close(): Promise<void> {
            reader.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

// ------------------------------------------------------------ PostgreSQL ---

/* eslint-disable @typescript-eslint/no-explicit-any */

async function introspectPostgres(client: any): Promise<DatabaseSchema> {
    const tableRes = await client.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
    );

    const tables: TableSchema[] = [];
    for (const row of tableRes.rows) {
        const name = row.table_name as string;
        const colRes = await client.query(
            `SELECT c.column_name, c.data_type, c.is_nullable,
                    COALESCE(pk.is_pk, false) AS is_pk
             FROM information_schema.columns c
             LEFT JOIN (
                 SELECT kcu.column_name, true AS is_pk
                 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu
                   ON kcu.constraint_name = tc.constraint_name
                 WHERE tc.table_schema = 'public'
                   AND tc.table_name = $1
                   AND tc.constraint_type = 'PRIMARY KEY'
             ) pk ON pk.column_name = c.column_name
             WHERE c.table_schema = 'public' AND c.table_name = $1
             ORDER BY c.ordinal_position`,
            [name],
        );

        tables.push({
            name,
            columns: colRes.rows.map((c: any) => ({
                name: c.column_name as string,
                type: c.data_type as string,
                isPrimaryKey: c.is_pk === true,
                isNotNull: c.is_nullable === 'NO',
            })),
        });
    }

    return { dialect: 'postgres', tables };
}

export async function createPostgresFixture(
    connectionString: string,
    options: FixtureOptions = {},
): Promise<FixtureDb> {
    const name = options.name ?? 'storefront';
    const files = FIXTURE_FILES[name];
    let pg: any;
    try {
        pg = await import('pg');
    } catch {
        throw new Error(
            "Postgres eval requires the 'pg' package. Run: npm install --save-dev pg",
        );
    }

    // Keep values comparable with the SQLite path: DATE as a plain string
    // (parsing to a JS Date would shift the day under a non-UTC TZ), NUMERIC
    // and INT8 as numbers rather than strings.
    const types = pg.types ?? pg.default?.types;
    types.setTypeParser(1082, (v: string) => v);
    types.setTypeParser(1700, (v: string) => parseFloat(v));
    types.setTypeParser(20, (v: string) => parseInt(v, 10));

    const Client = pg.Client ?? pg.default?.Client;
    const client = new Client({ connectionString });
    await client.connect();

    for (const statement of splitStatements(readFixture(files.postgres))) {
        await client.query(statement);
    }
    for (const statement of splitStatements(readFixture(files.seed))) {
        await client.query(statement);
    }

    const baseSchema = await introspectPostgres(client);

    const run = async (sql: string): Promise<unknown[][]> => {
        await client.query('BEGIN READ ONLY');
        try {
            const res = await client.query({ text: sql, rowMode: 'array' });
            return res.rows as unknown[][];
        } finally {
            await client.query('ROLLBACK');
        }
    };

    const schema =
        options.includeSamples === false
            ? baseSchema
            : await attachSampleValues(baseSchema, run);

    return {
        dialect: 'postgres',
        name,
        schema,
        run,
        async close(): Promise<void> {
            await client.end();
        },
    };
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export async function createFixture(
    dialect: Dialect,
    options: FixtureOptions = {},
): Promise<FixtureDb> {
    if (dialect === 'sqlite') return createSqliteFixture(options);
    const url = process.env.EVAL_POSTGRES_URL;
    if (!url) {
        throw new Error(
            'Postgres eval needs EVAL_POSTGRES_URL, e.g. postgres://postgres:postgres@localhost:5432/litedb_eval',
        );
    }
    return createPostgresFixture(url, options);
}
