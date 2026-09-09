// Report rendering. JSON is the record of the run; Markdown is what goes in
// the README, so it has to stay readable without the JSON next to it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunReport } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(HERE, '..', 'results');

function pct(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdown(report: RunReport): string {
    const { meta } = report;
    const lines: string[] = [];

    lines.push(`# Text-to-SQL eval — ${meta.provider} / ${meta.model} (${meta.dialect})`);
    lines.push('');
    lines.push(`- **Execution accuracy: ${pct(report.executionAccuracy)}** (${report.passed}/${report.scored} scored cases)`);
    lines.push(`- Run: ${meta.startedAt} · ${(meta.durationMs / 1000).toFixed(1)}s · concurrency ${meta.concurrency}`);
    lines.push(`- Harness v${meta.harnessVersion} · frozen eval date ${meta.evalDate}`);
    if (report.outcomes.api_error > 0) {
        lines.push(`- ${report.outcomes.api_error} case(s) excluded from scoring as API errors`);
    }
    lines.push('');

    lines.push('## Outcomes');
    lines.push('');
    lines.push('| Outcome | Count | Meaning |');
    lines.push('| --- | ---: | --- |');
    lines.push(`| pass | ${report.outcomes.pass} | Result set matched the reference |`);
    lines.push(`| wrong_result | ${report.outcomes.wrong_result} | Valid SQL, answered the wrong question |`);
    lines.push(`| invalid_sql | ${report.outcomes.invalid_sql} | Failed to execute (syntax or unknown column) |`);
    lines.push(`| guard_rejected | ${report.outcomes.guard_rejected} | Not a single read-only statement |`);
    lines.push(`| api_error | ${report.outcomes.api_error} | Provider/transport failure, not scored |`);
    lines.push('');

    lines.push('## By slice');
    lines.push('');
    lines.push('| Slice | Accuracy | Passed |');
    lines.push('| --- | ---: | ---: |');
    for (const [slice, stats] of Object.entries(report.bySlice).sort()) {
        lines.push(`| ${slice} | ${pct(stats.accuracy)} | ${stats.passed}/${stats.scored} |`);
    }
    lines.push('');

    lines.push('## By difficulty');
    lines.push('');
    lines.push('| Difficulty | Accuracy | Passed |');
    lines.push('| --- | ---: | ---: |');
    for (const level of ['easy', 'medium', 'hard']) {
        const stats = report.byDifficulty[level];
        if (!stats) continue;
        lines.push(`| ${level} | ${pct(stats.accuracy)} | ${stats.passed}/${stats.scored} |`);
    }
    lines.push('');

    const failures = report.results.filter(
        (r) => r.outcome !== 'pass' && r.outcome !== 'api_error',
    );
    if (failures.length > 0) {
        lines.push('## Failures');
        lines.push('');
        for (const failure of failures) {
            lines.push(`### \`${failure.id}\` — ${failure.outcome}`);
            lines.push('');
            lines.push(`> ${failure.question}`);
            lines.push('');
            lines.push('```sql');
            lines.push(`-- generated`);
            lines.push(failure.generatedSql ?? '(none)');
            lines.push(`-- reference`);
            lines.push(failure.referenceSql);
            lines.push('```');
            lines.push('');
            if (failure.detail) lines.push(`\`${failure.detail}\``);
            lines.push('');
        }
    }

    return lines.join('\n');
}

export function writeReport(report: RunReport, tag: string): { json: string; md: string } {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const jsonPath = join(RESULTS_DIR, `${tag}.json`);
    const mdPath = join(RESULTS_DIR, `${tag}.md`);
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(mdPath, `${renderMarkdown(report)}\n`);
    return { json: jsonPath, md: mdPath };
}

export function renderConsoleSummary(report: RunReport): string {
    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${report.meta.provider}/${report.meta.model} on ${report.meta.dialect}`);
    lines.push(`  Execution accuracy: ${pct(report.executionAccuracy)} (${report.passed}/${report.scored})`);
    lines.push('');
    for (const [slice, stats] of Object.entries(report.bySlice).sort()) {
        lines.push(`    ${slice.padEnd(20)} ${pct(stats.accuracy).padStart(6)}  ${stats.passed}/${stats.scored}`);
    }
    lines.push('');
    if (report.meta.repairAttempts > 0) {
        lines.push(`    repair: ${report.repaired} case(s) retried, ${report.repairedToPass} recovered to pass`);
    }
    const notable = (['wrong_result', 'invalid_sql', 'guard_rejected', 'api_error'] as const)
        .filter((k) => report.outcomes[k] > 0)
        .map((k) => `${k}=${report.outcomes[k]}`);
    if (notable.length) lines.push(`    ${notable.join('  ')}`);
    return lines.join('\n');
}

// ---------------------------------------------------------- multi-run ---

export interface FlakyCase {
    id: string;
    slice: string;
    passes: number;
}

export interface MultiRunSummary {
    runs: RunReport[];
    accuracies: number[];
    mean: number;
    min: number;
    max: number;
    stdevPp: number;
    stablePass: number;
    stableFail: number;
    flaky: FlakyCase[];
    bySlice: Record<string, { mean: number; min: number; max: number }>;
}

/**
 * Aggregate repeated runs of the same configuration.
 *
 * The headline is not the mean but the flaky count: cases that pass in some
 * runs and fail in others define the noise floor, and any claimed improvement
 * smaller than that floor is not an improvement.
 */
export function summarizeRuns(runs: RunReport[]): MultiRunSummary {
    const accuracies = runs.map((r) => r.executionAccuracy);
    const mean = accuracies.reduce((s, x) => s + x, 0) / accuracies.length;
    const variance =
        accuracies.reduce((s, x) => s + (x - mean) ** 2, 0) / accuracies.length;

    const passCounts = new Map<string, { slice: string; passes: number }>();
    for (const run of runs) {
        for (const result of run.results) {
            const entry = passCounts.get(result.id) ?? { slice: result.slice, passes: 0 };
            if (result.outcome === 'pass') entry.passes++;
            passCounts.set(result.id, entry);
        }
    }

    const flaky: FlakyCase[] = [];
    let stablePass = 0;
    let stableFail = 0;
    for (const [id, { slice, passes }] of passCounts) {
        if (passes === runs.length) stablePass++;
        else if (passes === 0) stableFail++;
        else flaky.push({ id, slice, passes });
    }
    flaky.sort((a, b) => (a.id < b.id ? -1 : 1));

    const sliceNames = new Set(runs.flatMap((r) => Object.keys(r.bySlice)));
    const bySlice: Record<string, { mean: number; min: number; max: number }> = {};
    for (const name of sliceNames) {
        const values = runs.map((r) => r.bySlice[name]?.accuracy ?? 0);
        bySlice[name] = {
            mean: values.reduce((s, x) => s + x, 0) / values.length,
            min: Math.min(...values),
            max: Math.max(...values),
        };
    }

    return {
        runs,
        accuracies,
        mean,
        min: Math.min(...accuracies),
        max: Math.max(...accuracies),
        stdevPp: Math.sqrt(variance) * 100,
        stablePass,
        stableFail,
        flaky,
        bySlice,
    };
}

export function renderMultiRunConsole(summary: MultiRunSummary): string {
    const meta = summary.runs[0].meta;
    const lines: string[] = [];
    const n = summary.runs.length;

    lines.push('');
    lines.push(`  ${meta.provider}/${meta.model} on ${meta.dialect} · ${n} runs`);
    lines.push(
        `  Execution accuracy: mean ${pct(summary.mean)} ` +
        `range ${pct(summary.min)}-${pct(summary.max)} (sd ${summary.stdevPp.toFixed(1)}pp)`,
    );
    lines.push('');
    for (const [slice, stats] of Object.entries(summary.bySlice).sort()) {
        lines.push(
            `    ${slice.padEnd(20)} mean ${pct(stats.mean).padStart(6)}` +
            `  range ${pct(stats.min)}-${pct(stats.max)}`,
        );
    }
    lines.push('');
    lines.push(
        `  Stability: ${summary.stablePass} always pass · ` +
        `${summary.stableFail} always fail · ${summary.flaky.length} flaky`,
    );
    if (summary.flaky.length > 0) {
        const detail = summary.flaky
            .map((f) => `${f.id} (${f.passes}/${n})`)
            .join(', ');
        lines.push(`    flaky: ${detail}`);
        lines.push('');
        lines.push(
            `  Noise floor is ${summary.flaky.length} case(s). Treat any delta ` +
            `at or below that as unproven.`,
        );
    }
    return lines.join('\n');
}

export function renderMultiRunMarkdown(summary: MultiRunSummary): string {
    const meta = summary.runs[0].meta;
    const n = summary.runs.length;
    const lines: string[] = [];

    lines.push(`# Repeated eval — ${meta.provider} / ${meta.model} (${meta.dialect})`);
    lines.push('');
    lines.push(`- **Mean execution accuracy: ${pct(summary.mean)}** over ${n} runs`);
    lines.push(`- Range ${pct(summary.min)}-${pct(summary.max)}, sd ${summary.stdevPp.toFixed(1)}pp`);
    lines.push(`- Per-run: ${summary.accuracies.map(pct).join(', ')}`);
    lines.push(`- Harness v${meta.harnessVersion} · frozen eval date ${meta.evalDate}`);
    lines.push('');

    lines.push('## By slice');
    lines.push('');
    lines.push('| Slice | Mean | Min | Max |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const [slice, stats] of Object.entries(summary.bySlice).sort()) {
        lines.push(`| ${slice} | ${pct(stats.mean)} | ${pct(stats.min)} | ${pct(stats.max)} |`);
    }
    lines.push('');

    lines.push('## Stability');
    lines.push('');
    lines.push(`| Category | Cases |`);
    lines.push(`| --- | ---: |`);
    lines.push(`| Passed every run | ${summary.stablePass} |`);
    lines.push(`| Failed every run | ${summary.stableFail} |`);
    lines.push(`| Flaky | ${summary.flaky.length} |`);
    lines.push('');
    if (summary.flaky.length > 0) {
        lines.push('| Flaky case | Slice | Passes |');
        lines.push('| --- | --- | ---: |');
        for (const f of summary.flaky) {
            lines.push(`| \`${f.id}\` | ${f.slice} | ${f.passes}/${n} |`);
        }
        lines.push('');
        lines.push(
            `The flaky count is the noise floor of this configuration. An ` +
            `intervention that moves fewer cases than this has not been shown ` +
            `to do anything.`,
        );
        lines.push('');
    }

    return lines.join('\n');
}

export function writeMultiRunReport(
    summary: MultiRunSummary,
    tag: string,
): { json: string; md: string } {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const jsonPath = join(RESULTS_DIR, `${tag}.json`);
    const mdPath = join(RESULTS_DIR, `${tag}.md`);
    writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(mdPath, `${renderMultiRunMarkdown(summary)}\n`);
    return { json: jsonPath, md: mdPath };
}
