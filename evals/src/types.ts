import type { DatabaseSchema, SqlDialect } from '../../src/lib/schemaTypes';

export type Dialect = SqlDialect;

/** Which fixture database a case is written against. */
export type FixtureName = 'storefront' | 'library';

export type Slice =
    | 'single-table'
    | 'joins'
    | 'aggregation'
    | 'window-functions'
    | 'ambiguous-schema';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface EvalCase {
    id: string;
    slice: Slice;
    difficulty: Difficulty;
    /** The natural-language question handed to the model, verbatim. */
    question: string;
    /**
     * Reference SQL. A bare string applies to every dialect; use the object
     * form when the dialects genuinely diverge (window frames, date maths).
     */
    sql: string | Partial<Record<Dialect, string>>;
    /**
     * Whether row order is part of correctness. True only when the question
     * actually pins an order ("top 3", "sorted by"). Defaults to false, in
     * which case rows are canonically sorted before comparison.
     */
    ordered?: boolean;
    /**
     * Which split the case belongs to. 'dev' cases informed the prompt and
     * exemplar work; 'test' cases were written afterwards to cover function
     * surface rather than observed failures, and must never be looked at while
     * tuning. Defaults to 'dev'.
     */
    split?: 'dev' | 'test';
    /**
     * Fixture database this case targets. Defaults to 'storefront'.
     * 'library' uses a deliberately different schema — suffixed primary keys,
     * full_name rather than name, integer cents, a nullable date — to test
     * generalisation to an unseen database rather than unseen questions.
     */
    fixture?: FixtureName;
    /** Restrict a case to specific dialects. Defaults to all. */
    dialects?: Dialect[];
    notes?: string;
}

/**
 * Failure taxonomy. The distinction matters: `api_error` is harness/infra
 * noise and must never be counted against the model, while `invalid_sql` and
 * `wrong_result` are genuinely different model failures — one is a syntax or
 * schema mistake, the other is a plausible query that answers the wrong
 * question. Collapsing them hides which one you actually have.
 */
export type Outcome =
    | 'pass'
    | 'wrong_result'
    | 'invalid_sql'
    | 'guard_rejected'
    | 'api_error';

export interface CaseResult {
    id: string;
    slice: Slice;
    difficulty: Difficulty;
    question: string;
    outcome: Outcome;
    referenceSql: string;
    generatedSql: string | null;
    detail?: string;
    latencyMs: number;
    promptTokens: number | null;
    completionTokens: number | null;
    /** Execution-guided repair attempts consumed on this case. 0 when disabled. */
    repairs: number;
}

export interface RunMeta {
    provider: string;
    model: string;
    dialect: Dialect;
    startedAt: string;
    durationMs: number;
    concurrency: number;
    harnessVersion: string;
    /** Repair attempts allowed per case; 0 means the feature was off. */
    repairAttempts: number;
    /** Frozen clock stamped into the prompt, so runs stay reproducible. */
    evalDate: string;
}

export interface RunReport {
    meta: RunMeta;
    /** Cases that reached the model. Excludes api_error from the denominator. */
    scored: number;
    passed: number;
    executionAccuracy: number;
    outcomes: Record<Outcome, number>;
    /** Cases that consumed at least one repair attempt. */
    repaired: number;
    /** Cases that failed to execute, were repaired, and then passed. */
    repairedToPass: number;
    bySlice: Record<string, { scored: number; passed: number; accuracy: number }>;
    byDifficulty: Record<string, { scored: number; passed: number; accuracy: number }>;
    results: CaseResult[];
}

export interface FixtureDb {
    dialect: Dialect;
    name: FixtureName;
    schema: DatabaseSchema;
    /** Execute read-only. Returns rows as positional arrays. */
    run(sql: string): Promise<unknown[][]>;
    close(): Promise<void>;
}
