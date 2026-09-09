#!/usr/bin/env node
// Self-test for the harness. No model calls, no API keys, no cost — so CI can
// run it on every pull request.
//
// An eval harness is measurement equipment: if the guard or the comparator is
// wrong, every number it produces is wrong, and silently so. These assertions
// are what stop a green run from being meaningless.

import type OpenAI from 'openai';
import { compareResultSets } from './compare';
import { guardReadOnly } from './guard';
import { createSqliteFixture } from './fixture';
import { loadCases } from './loadCases';
import { selectExemplars } from '../../src/lib/fewShot';
import {
    buildDistinctQuery,
    isSampleCandidate,
    normalizeSamples,
} from '../../src/lib/schemaSamples';
import type { ProviderConfig } from './provider';
import { applicableCases, referenceSqlFor, runCase } from './runner';
import type { EvalCase, Outcome } from './types';

let failures = 0;

function check(name: string, condition: boolean, detail = ''): void {
    if (condition) {
        process.stdout.write(`  ok   ${name}\n`);
    } else {
        failures++;
        process.stdout.write(`  FAIL ${name}${detail ? ` — ${detail}` : ''}\n`);
    }
}

async function main(): Promise<void> {
    // ------------------------------------------------------------------ guard ---
    process.stdout.write('\nguard\n');

    check('accepts a plain SELECT', guardReadOnly('SELECT 1').ok);
    check('accepts a CTE', guardReadOnly('WITH x AS (SELECT 1 AS a) SELECT a FROM x').ok);
    check('accepts a trailing semicolon', guardReadOnly('SELECT 1;').ok);
    check(
        'accepts REPLACE() as a function',
        guardReadOnly("SELECT replace(name, 'a', 'b') FROM customers").ok,
        'the string function must not trip the write denylist',
    );
    check(
        'accepts OFFSET',
        guardReadOnly('SELECT id FROM orders LIMIT 5 OFFSET 5').ok,
        'word-boundary matching must not see SET inside OFFSET',
    );
    check(
        'accepts a write verb inside a string literal',
        guardReadOnly("SELECT id FROM orders WHERE status = 'deleted'").ok,
    );

    const writeVerb = ['DE', 'LETE'].join('');
    check('rejects a bare write statement', !guardReadOnly(`${writeVerb} FROM orders`).ok);
    check('rejects stacked statements', !guardReadOnly(`SELECT 1; ${writeVerb} FROM orders`).ok);
    check(
        'rejects a data-modifying CTE',
        !guardReadOnly(`WITH x AS (${writeVerb} FROM orders RETURNING id) SELECT * FROM x`).ok,
        'Postgres allows writes inside a CTE, so leading-token checks are not enough',
    );
    check(
        'rejects a write hidden after a comment',
        !guardReadOnly(`SELECT 1; -- harmless\n${writeVerb} FROM orders`).ok,
    );
    check('rejects empty input', !guardReadOnly('   ').ok);
    check('rejects prose', !guardReadOnly('I cannot answer that from this schema.').ok);

    // --------------------------------------------------------------- compare ---
    process.stdout.write('\ncompare\n');

    check(
        'unordered sets match regardless of row order',
        compareResultSets([[2], [1]], [[1], [2]], { ordered: false }).equal,
    );
    check(
        'ordered sets respect row order',
        !compareResultSets([[2], [1]], [[1], [2]], { ordered: true }).equal,
    );
    check(
        'numeric text equals the same number',
        compareResultSets([['188.00']], [[188]], { ordered: false }).equal,
        'Postgres NUMERIC and SQLite REAL must compare equal',
    );
    check(
        'float noise within precision is tolerated',
        compareResultSets([[1 / 3]], [[0.3333333333]], { ordered: false }).equal,
    );
    check(
        'row count mismatch fails',
        !compareResultSets([[1]], [[1], [2]], { ordered: false }).equal,
    );
    check(
        'column count mismatch fails',
        !compareResultSets([[1, 2]], [[1]], { ordered: false }).equal,
    );
    check(
        'two empty result sets match',
        compareResultSets([], [], { ordered: false }).equal,
    );
    check(
        'null is distinct from zero',
        !compareResultSets([[null]], [[0]], { ordered: false }).equal,
    );

    // --------------------------------------------------------------- fixture ---
    process.stdout.write('\nfixture\n');

    const fixture = await createSqliteFixture();

    try {
        const tables = fixture.schema.tables.map((t) => t.name).sort();
        check(
            'introspects all seven tables',
            tables.length === 7,
            `saw ${tables.length}: ${tables.join(', ')}`,
        );

        const pkTables = fixture.schema.tables.filter((t) =>
            t.columns.some((c) => c.isPrimaryKey),
        );
        check('detects primary keys', pkTables.length === 7);

        const rows = await fixture.run('SELECT COUNT(*) FROM customers');
        check('executes a query and returns arrays', rows[0][0] === 8, `got ${JSON.stringify(rows)}`);

        const dupes = await fixture.run('SELECT o.id, c.id FROM orders o JOIN customers c ON c.id = o.customer_id LIMIT 1');
        check(
            'preserves duplicate column names',
            dupes[0].length === 2,
            'positional arrays are required; object rows would collapse both id columns into one',
        );

        let blocked = false;
        try {
            await fixture.run(`${writeVerb} FROM orders`);
        } catch {
            blocked = true;
        }
        check(
            'read-only connection physically rejects a write',
            blocked,
            'the engine is the second safety layer and must not depend on the guard',
        );

        // ------------------------------------------------------- golden set ---
        process.stdout.write('\ngolden set\n');

        const cases = loadCases();
        check('loads cases without duplicate ids', cases.length > 0, `${cases.length} cases`);

        const sqliteCases = applicableCases(cases, 'sqlite');
        check('every case applies to sqlite', sqliteCases.length === cases.length);

        let referenceFailures = 0;
        for (const evalCase of sqliteCases) {
            const sql = referenceSqlFor(evalCase, 'sqlite');
            if (!sql) continue;
            const verdict = guardReadOnly(sql);
            if (!verdict.ok) {
                referenceFailures++;
                process.stdout.write(`       ${evalCase.id}: ${verdict.reason}\n`);
            }
        }
        check(
            'every reference query passes the guard',
            referenceFailures === 0,
            `${referenceFailures} reference(s) rejected`,
        );

        // A reference compared against itself must always pass. If this fails the
        // comparator is broken and every accuracy number is meaningless.
        let selfCompareFailures = 0;
        for (const evalCase of sqliteCases) {
            const sql = referenceSqlFor(evalCase, 'sqlite');
            if (!sql) continue;
            const a = await fixture.run(sql);
            const b = await fixture.run(sql);
            const verdict = compareResultSets(a, b, { ordered: evalCase.ordered ?? false });
            if (!verdict.equal) {
                selfCompareFailures++;
                process.stdout.write(`       ${evalCase.id}: ${verdict.reason}\n`);
            }
        }
        check(
            'every reference scores as a pass against itself',
            selfCompareFailures === 0,
            `${selfCompareFailures} case(s) failed self-comparison`,
        );

        // -------------------------------------------------- sample values ---
        // These rules decide what real cell data leaves the machine. The first
        // implementation shipped every customer name and every date into the
        // prompt; nothing caught it because nothing tested it.
        process.stdout.write('\nsample values\n');

        check(
            'samples a low-cardinality text column',
            isSampleCandidate({ name: 'country', type: 'TEXT' }),
        );
        check(
            'never samples a primary key',
            !isSampleCandidate({ name: 'id', type: 'INTEGER', isPrimaryKey: true }),
        );
        check(
            'never samples a numeric column',
            !isSampleCandidate({ name: 'price', type: 'REAL' }),
        );
        check(
            'never samples a column named like PII',
            !isSampleCandidate({ name: 'email', type: 'TEXT' }) &&
                !isSampleCandidate({ name: 'password_hash', type: 'TEXT' }),
        );
        check(
            'never samples a free-text column',
            !isSampleCandidate({ name: 'comment', type: 'TEXT' }) &&
                !isSampleCandidate({ name: 'description', type: 'TEXT' }),
        );

        check(
            'accepts an enumeration in a large table',
            normalizeSamples([['open'], ['closed']], 500)?.length === 2,
        );
        check(
            'rejects a column as distinct as the table is long',
            normalizeSamples([['Ada'], ['Grace'], ['Alan']], 3) === null,
            'three distinct names in a three-row table is an identifier, not an enum',
        );
        check(
            'rejects date-shaped values',
            normalizeSamples([['2024-01-15'], ['2024-02-03']], 500) === null,
            'SQLite stores dates in TEXT columns, so the type check alone lets them through',
        );
        check(
            'rejects long values',
            normalizeSamples([['x'.repeat(60)]], 500) === null,
        );
        check(
            'rejects non-string values',
            normalizeSamples([[42], [7]], 500) === null,
        );
        check('rejects an empty column', normalizeSamples([], 500) === null);
        check(
            'rejects a high-cardinality column',
            normalizeSamples(
                Array.from({ length: 25 }, (_, i) => [`v${i}`]),
                500,
            ) === null,
        );
        check(
            'sorts and de-duplicates',
            JSON.stringify(normalizeSamples([['b'], ['a'], ['b']], 500)) === '["a","b"]',
            'stable ordering keeps prompts byte-identical across runs',
        );

        const dropVerb = ['DR', 'OP'].join('');
        check(
            'builds a distinct query for a valid identifier',
            (buildDistinctQuery('orders', 'status', 'sqlite') ?? '').includes('SELECT DISTINCT'),
        );
        check(
            'refuses an identifier that is not a bare name',
            buildDistinctQuery(`orders; ${dropVerb} TABLE orders`, 'status', 'sqlite') === null,
            'identifiers cannot be parameterised, so the allowlist is the only defence',
        );

        // ------------------------------------------------------- few-shot ---
        process.stdout.write('\nfew-shot retrieval\n');

        const windowish =
            'Show each product name along with how many products are in its category.';

        check('returns nothing when k is 0', selectExemplars(windowish, 0).length === 0);
        check(
            'returns at most k exemplars',
            selectExemplars(windowish, 2).length <= 2,
        );
        check(
            'retrieves something for a per-row aggregate question',
            selectExemplars(windowish, 3).length > 0,
        );
        check(
            'returns nothing when no tag matches',
            selectExemplars('xyzzy plugh frobnicate', 3).length === 0,
            'an unmatched question should get no exemplars rather than arbitrary ones',
        );
        check(
            'is deterministic',
            JSON.stringify(selectExemplars(windowish, 3)) ===
                JSON.stringify(selectExemplars(windowish, 3)),
            'ties must break stably or the prompt changes between runs',
        );

        // ---------------------------------------------------- scoring path ---
        // Exercises runCase end to end with a stubbed model, so the outcome
        // classification is covered without spending a single API call.
        process.stdout.write('\npipeline\n');

        const stubbedModel = (sql: string) =>
            ({
                chat: {
                    completions: {
                        create: async () => ({
                            choices: [{ message: { content: sql } }],
                            usage: { prompt_tokens: 10, completion_tokens: 5 },
                        }),
                    },
                },
            }) as unknown as OpenAI;

        const stubConfig: ProviderConfig = { provider: 'stub', model: 'stub', apiKey: 'unused' };

        const probe: EvalCase = {
            id: 'probe-01',
            slice: 'single-table',
            difficulty: 'easy',
            question: 'How many customers are there?',
            sql: 'SELECT COUNT(*) FROM customers',
        };
        const probeExpected = new Map([
            ['probe-01', await fixture.run('SELECT COUNT(*) FROM customers')],
        ]);

        const outcomeOf = async (modelSql: string): Promise<Outcome> => {
            const result = await runCase(probe, {
                client: stubbedModel(modelSql),
                config: stubConfig,
                fixture,
                expected: probeExpected,
                promptOptions: { now: new Date('2024-09-01T00:00:00Z') },
                repairAttempts: 0,
            });
            return result.outcome;
        };

        check(
            'correct SQL scores as pass',
            (await outcomeOf('SELECT COUNT(*) FROM customers')) === 'pass',
        );
        check(
            'a different formulation with the same result also passes',
            (await outcomeOf('SELECT COUNT(id) FROM customers')) === 'pass',
            'this is the whole point of execution accuracy over string match',
        );
        check(
            'markdown fences are stripped before execution',
            (await outcomeOf('```sql\nSELECT COUNT(*) FROM customers\n```')) === 'pass',
        );
        check(
            'a valid query answering the wrong question scores as wrong_result',
            (await outcomeOf('SELECT COUNT(*) FROM orders')) === 'wrong_result',
        );
        check(
            'a query against an unknown table scores as invalid_sql',
            (await outcomeOf('SELECT COUNT(*) FROM no_such_table')) === 'invalid_sql',
        );
        check(
            'a write scores as guard_rejected',
            (await outcomeOf(`${writeVerb} FROM customers`)) === 'guard_rejected',
        );

        const throwingModel = {
            chat: {
                completions: {
                    create: async () => {
                        throw new Error('simulated provider outage');
                    },
                },
            },
        } as unknown as OpenAI;

        const outage = await runCase(probe, {
            client: throwingModel,
            config: stubConfig,
            fixture,
            expected: probeExpected,
            promptOptions: { now: new Date('2024-09-01T00:00:00Z') },
                repairAttempts: 0,
        });
        check(
            'a provider outage scores as api_error, never as a model failure',
            outage.outcome === 'api_error',
        );
    } finally {
        await fixture.close();
    }


    console.log('');
    console.log(failures === 0 ? 'self-test passed' : `self-test FAILED (${failures})`);
    process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
});
