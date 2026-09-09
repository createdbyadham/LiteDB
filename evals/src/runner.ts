// Orchestration: prompt -> generate -> guard -> execute -> compare.

import type OpenAI from 'openai';
import {
    buildRepairMessages,
    buildTextToSqlMessages,
    stripSqlFences,
    type PromptOptions,
} from '../../src/lib/promptBuilder';
import { compareResultSets } from './compare';
import { guardReadOnly } from './guard';
import { generate, type ProviderConfig } from './provider';
import type { CaseResult, Dialect, EvalCase, FixtureDb, Outcome, RunReport } from './types';

export const HARNESS_VERSION = '1.0.0';

/** Resolve the reference SQL for a dialect, or null if the case does not apply. */
export function referenceSqlFor(evalCase: EvalCase, dialect: Dialect): string | null {
    if (typeof evalCase.sql === 'string') return evalCase.sql;
    return evalCase.sql[dialect] ?? null;
}

export function applicableCases(cases: EvalCase[], dialect: Dialect): EvalCase[] {
    return cases.filter((c) => {
        if (c.dialects && !c.dialects.includes(dialect)) return false;
        return referenceSqlFor(c, dialect) !== null;
    });
}

export interface ReferenceFailure {
    id: string;
    sql: string;
    error: string;
}

/**
 * Execute every reference query up front.
 *
 * Two reasons this happens before any model call. First, a broken reference is
 * a harness bug that would otherwise masquerade as a model failure. Second, it
 * fails the run in about a second instead of after paying for N completions.
 */
export async function precomputeExpected(
    fixture: FixtureDb,
    cases: EvalCase[],
): Promise<{ expected: Map<string, unknown[][]>; failures: ReferenceFailure[] }> {
    const expected = new Map<string, unknown[][]>();
    const failures: ReferenceFailure[] = [];

    for (const evalCase of cases) {
        const sql = referenceSqlFor(evalCase, fixture.dialect);
        if (sql === null) continue;
        try {
            expected.set(evalCase.id, await fixture.run(sql));
        } catch (error) {
            failures.push({
                id: evalCase.id,
                sql,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { expected, failures };
}

export interface RunCaseDeps {
    client: OpenAI;
    config: ProviderConfig;
    fixture: FixtureDb;
    expected: Map<string, unknown[][]>;
    promptOptions: PromptOptions;
    /** Extra generate/execute rounds allowed after an engine error. 0 = off. */
    repairAttempts: number;
}

export async function runCase(evalCase: EvalCase, deps: RunCaseDeps): Promise<CaseResult> {
    const { client, config, fixture, expected, promptOptions, repairAttempts } = deps;
    const referenceSql = referenceSqlFor(evalCase, fixture.dialect) ?? '';

    const base = {
        id: evalCase.id,
        slice: evalCase.slice,
        difficulty: evalCase.difficulty,
        question: evalCase.question,
        referenceSql,
    };

    let messages = buildTextToSqlMessages(evalCase.question, fixture.schema, promptOptions);

    // Accumulated across repair turns: a repaired case genuinely costs two
    // round trips, and reporting only the last one would understate it.
    let latencyMs = 0;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let repairs = 0;

    let sql: string | null = null;
    let outcome: Outcome = 'api_error';
    let detail: string | undefined;

    for (let attempt = 0; attempt <= repairAttempts; attempt++) {
        let generated;
        try {
            generated = await generate(client, config, messages);
        } catch (error) {
            return {
                ...base,
                outcome: 'api_error',
                generatedSql: sql,
                detail: error instanceof Error ? error.message : String(error),
                latencyMs,
                promptTokens,
                completionTokens,
                repairs,
            };
        }

        latencyMs += generated.latencyMs;
        if (generated.promptTokens !== null) {
            promptTokens = (promptTokens ?? 0) + generated.promptTokens;
        }
        if (generated.completionTokens !== null) {
            completionTokens = (completionTokens ?? 0) + generated.completionTokens;
        }

        sql = stripSqlFences(generated.content);
        const canRetry = attempt < repairAttempts;

        const verdict = guardReadOnly(sql);
        if (!verdict.ok) {
            outcome = 'guard_rejected';
            detail = verdict.reason;
            if (!canRetry) break;
            messages = buildRepairMessages(messages, sql, verdict.reason);
            repairs++;
            continue;
        }

        let actual: unknown[][];
        try {
            actual = await fixture.run(verdict.sql);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            outcome = 'invalid_sql';
            detail = message;
            if (!canRetry) break;
            messages = buildRepairMessages(messages, sql, message);
            repairs++;
            continue;
        }

        const comparison = compareResultSets(actual, expected.get(evalCase.id) ?? [], {
            ordered: evalCase.ordered ?? false,
        });
        outcome = comparison.equal ? 'pass' : 'wrong_result';
        detail = comparison.equal ? undefined : comparison.reason;

        // The query ran. A wrong-but-valid result produces no error to feed
        // back, so there is nothing to repair from — stop rather than pretend
        // the loop can see correctness it has no signal for.
        break;
    }

    return {
        ...base,
        outcome,
        generatedSql: sql,
        detail,
        latencyMs,
        promptTokens,
        completionTokens,
        repairs,
    };
}

/** Bounded-concurrency map that preserves input order in the output. */
async function pooled<T, R>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const index = cursor++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });

    await Promise.all(runners);
    return results;
}

function emptyOutcomes(): Record<Outcome, number> {
    return {
        pass: 0,
        wrong_result: 0,
        invalid_sql: 0,
        guard_rejected: 0,
        api_error: 0,
    };
}

function group(
    results: CaseResult[],
    key: (r: CaseResult) => string,
): Record<string, { scored: number; passed: number; accuracy: number }> {
    const out: Record<string, { scored: number; passed: number; accuracy: number }> = {};
    for (const result of results) {
        // api_error is infrastructure noise, never model error.
        if (result.outcome === 'api_error') continue;
        const bucket = (out[key(result)] ??= { scored: 0, passed: 0, accuracy: 0 });
        bucket.scored++;
        if (result.outcome === 'pass') bucket.passed++;
    }
    for (const bucket of Object.values(out)) {
        bucket.accuracy = bucket.scored === 0 ? 0 : bucket.passed / bucket.scored;
    }
    return out;
}

export interface RunOptions {
    cases: EvalCase[];
    fixture: FixtureDb;
    client: OpenAI;
    config: ProviderConfig;
    expected: Map<string, unknown[][]>;
    concurrency: number;
    promptOptions: PromptOptions;
    repairAttempts: number;
    onProgress?: (done: number, total: number, result: CaseResult) => void;
}

export async function runAll(options: RunOptions): Promise<RunReport> {
    const { cases, fixture, client, config, expected, concurrency, promptOptions, repairAttempts } =
        options;
    const startedAt = new Date();
    let done = 0;

    const results = await pooled(cases, concurrency, async (evalCase) => {
        const result = await runCase(evalCase, {
            client,
            config,
            fixture,
            expected,
            promptOptions,
            repairAttempts,
        });
        done++;
        options.onProgress?.(done, cases.length, result);
        return result;
    });

    const outcomes = emptyOutcomes();
    for (const result of results) outcomes[result.outcome]++;

    const scored = results.length - outcomes.api_error;
    const passed = outcomes.pass;

    return {
        meta: {
            provider: config.provider,
            model: config.model,
            dialect: fixture.dialect,
            startedAt: startedAt.toISOString(),
            durationMs: Date.now() - startedAt.getTime(),
            concurrency,
            harnessVersion: HARNESS_VERSION,
            repairAttempts,
            evalDate: (promptOptions.now ?? new Date()).toISOString().split('T')[0],
        },
        scored,
        passed,
        executionAccuracy: scored === 0 ? 0 : passed / scored,
        outcomes,
        repaired: results.filter((r) => r.repairs > 0).length,
        repairedToPass: results.filter((r) => r.repairs > 0 && r.outcome === 'pass').length,
        bySlice: group(results, (r) => r.slice),
        byDifficulty: group(results, (r) => r.difficulty),
        results,
    };
}
