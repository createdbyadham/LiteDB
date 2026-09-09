// Result-set equivalence for execution accuracy.
//
// Execution accuracy asks whether the generated query *answers the question*,
// not whether it looks like the reference. So both queries are executed and
// their result sets compared. That deliberately accepts any query that
// produces the right rows — a different join order, a subquery instead of a
// CTE, EXISTS instead of IN — which is the whole point: string or AST
// similarity would fail correct answers and reward memorised phrasing.

export interface CompareOptions {
    /** When false, rows are canonically sorted before comparison. */
    ordered: boolean;
    /** Decimal places used to compare floats. Guards against 1/3 drift. */
    precision?: number;
}

export type CompareVerdict = { equal: true } | { equal: false; reason: string };

type Scalar = string | number | null;

/**
 * Collapse engine-specific representations to comparable values.
 *
 * Numeric-looking strings become numbers so a Postgres NUMERIC ('188.00') and
 * a SQLite REAL (188) compare equal. The tradeoff is that a genuine text
 * column holding "123" would match the number 123; no such column exists in
 * the fixture, and the alternative — failing correct answers over storage
 * representation — is worse for a cross-dialect benchmark.
 */
function normalizeValue(value: unknown, precision: number): Scalar {
    if (value === null || value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'bigint') {
        const asNumber = Number(value);
        return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
    }
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return String(value);
        return Number(value.toFixed(precision));
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed !== '' && /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
            return Number(Number(trimmed).toFixed(precision));
        }
        return value;
    }
    return JSON.stringify(value);
}

function normalizeRows(rows: unknown[][], precision: number): Scalar[][] {
    return rows.map((row) => row.map((cell) => normalizeValue(cell, precision)));
}

/** Stable canonical ordering for set comparison. */
function sortRows(rows: Scalar[][]): Scalar[][] {
    return [...rows].sort((a, b) => {
        const ka = JSON.stringify(a);
        const kb = JSON.stringify(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

function preview(row: Scalar[]): string {
    const text = JSON.stringify(row);
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function compareResultSets(
    actual: unknown[][],
    expected: unknown[][],
    options: CompareOptions,
): CompareVerdict {
    const precision = options.precision ?? 6;

    if (actual.length !== expected.length) {
        return {
            equal: false,
            reason: `row count ${actual.length} != expected ${expected.length}`,
        };
    }

    // Both empty: column arity is unobservable from rows alone, so accept.
    if (expected.length === 0) return { equal: true };

    const actualCols = actual[0].length;
    const expectedCols = expected[0].length;
    if (actualCols !== expectedCols) {
        return {
            equal: false,
            reason: `column count ${actualCols} != expected ${expectedCols}`,
        };
    }

    let normActual = normalizeRows(actual, precision);
    let normExpected = normalizeRows(expected, precision);

    if (!options.ordered) {
        normActual = sortRows(normActual);
        normExpected = sortRows(normExpected);
    }

    for (let i = 0; i < normExpected.length; i++) {
        const a = normActual[i];
        const e = normExpected[i];
        for (let j = 0; j < e.length; j++) {
            if (a[j] !== e[j]) {
                return {
                    equal: false,
                    reason:
                        `row ${i} col ${j}: got ${JSON.stringify(a[j])}, ` +
                        `expected ${JSON.stringify(e[j])} | got ${preview(a)} vs ${preview(e)}`,
                };
            }
        }
    }

    return { equal: true };
}
