#!/usr/bin/env node
// CLI entry point for the LiteDB Text-to-SQL eval harness.
//
//   npm run eval -- --provider ollama --model qwen2.5-coder:7b
//   npm run eval -- --provider openai --slice joins --limit 10
//   npm run eval:verify           (no model calls; checks the golden set)

import { createFixture } from './fixture';
import { loadCases } from './loadCases';
import { createClient, resolveProvider } from './provider';
import {
    renderConsoleSummary,
    renderMultiRunConsole,
    summarizeRuns,
    writeMultiRunReport,
    writeReport,
} from './report';
import { applicableCases, precomputeExpected, runAll } from './runner';
import type { Dialect, EvalCase, FixtureName, RunReport, Slice } from './types';

interface Args {
    provider: string;
    model?: string;
    dialect: Dialect;
    slice?: Slice;
    difficulty?: string;
    split?: 'dev' | 'test';
    fixture: FixtureName;
    limit?: number;
    concurrency: number;
    tag?: string;
    verifyOnly: boolean;
    includeSamples: boolean;
    qualifyColumns: boolean;
    antiSubstitution: boolean;
    fewShot: number;
    repairAttempts: number;
    repeat: number;
}

function parseArgs(argv: string[]): Args {
    const args: Args = {
        provider: process.env.EVAL_PROVIDER || 'ollama',
        dialect: 'sqlite',
        concurrency: 4,
        verifyOnly: false,
        includeSamples: true,
        fixture: 'storefront',
        qualifyColumns: false,
        antiSubstitution: false,
        fewShot: 3,
        repairAttempts: 1,
        repeat: 1,
    };

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        switch (flag) {
            case '--provider': args.provider = value; i++; break;
            case '--model': args.model = value; i++; break;
            case '--dialect': args.dialect = value as Dialect; i++; break;
            case '--slice': args.slice = value as Slice; i++; break;
            case '--difficulty': args.difficulty = value; i++; break;
            case '--split': args.split = value as 'dev' | 'test'; i++; break;
            case '--fixture': args.fixture = value as FixtureName; i++; break;
            case '--limit': args.limit = Number(value); i++; break;
            case '--concurrency': args.concurrency = Number(value); i++; break;
            case '--tag': args.tag = value; i++; break;
            case '--verify-references': args.verifyOnly = true; break;
            case '--no-samples': args.includeSamples = false; break;
            case '--qualified': args.qualifyColumns = true; break;
            case '--directive': args.antiSubstitution = true; break;
            case '--repair': args.repairAttempts = Number(value); i++; break;
            case '--no-repair': args.repairAttempts = 0; break;
            case '--fewshot': args.fewShot = Number(value); i++; break;
            case '--no-fewshot': args.fewShot = 0; break;
            case '--repeat': args.repeat = Number(value); i++; break;
            default:
                if (flag.startsWith('--')) throw new Error(`Unknown flag: ${flag}`);
        }
    }

    if (args.dialect !== 'sqlite' && args.dialect !== 'postgres') {
        throw new Error(`--dialect must be sqlite or postgres`);
    }
    return args;
}

function selectCases(all: EvalCase[], args: Args, dialect: Dialect): EvalCase[] {
    // A run targets one fixture: cases are written against a specific schema.
    let selected = applicableCases(all, dialect).filter(
        (c) => (c.fixture ?? 'storefront') === args.fixture,
    );
    if (args.slice) selected = selected.filter((c) => c.slice === args.slice);
    if (args.difficulty) selected = selected.filter((c) => c.difficulty === args.difficulty);
    if (args.split) selected = selected.filter((c) => (c.split ?? 'dev') === args.split);
    if (args.limit !== undefined) selected = selected.slice(0, args.limit);
    return selected;
}

/**
 * Load credentials from a gitignored .env if present.
 *
 * Keeps API keys out of shell history and out of the command line, where they
 * would otherwise be visible to every process on the machine. CI sets real
 * environment variables instead, so a missing file is normal, not an error.
 */
function loadDotEnv(): void {
    for (const file of ['.env', 'evals/.env']) {
        try {
            process.loadEnvFile(file);
        } catch {
            // Absent or unreadable; environment variables still apply.
        }
    }
}

async function listModels(): Promise<void> {
    const config = resolveProvider('openai');
    const client = createClient(config);
    const models = await client.models.list();
    const ids = models.data.map((m) => m.id).sort();
    process.stdout.write(`${ids.length} model(s) available on this key:
`);
    for (const id of ids) process.stdout.write(`  ${id}
`);
}

async function main(): Promise<void> {
    loadDotEnv();

    if (process.argv.includes('--list-models')) {
        await listModels();
        return;
    }

    const args = parseArgs(process.argv.slice(2));

    // The prompt embeds a date. Freeze it so a case whose answer depends on
    // "this year" cannot start failing in January.
    const evalDate = new Date(process.env.EVAL_DATE || '2024-09-01T00:00:00Z');

    const fixture = await createFixture(args.dialect, {
        includeSamples: args.includeSamples,
        name: args.fixture,
    });

    try {
        const allCases = loadCases();
        const cases = selectCases(allCases, args, args.dialect);

        if (cases.length === 0) {
            throw new Error('No cases matched the given filters.');
        }

        process.stdout.write(
            `Loaded ${cases.length} case(s) for ${args.dialect} ` +
            `(${allCases.length} total in the golden set)\n`,
        );

        const { expected, failures } = await precomputeExpected(fixture, cases);

        if (failures.length > 0) {
            process.stderr.write(`\n${failures.length} reference query/queries failed:\n`);
            for (const failure of failures) {
                process.stderr.write(`  ${failure.id}: ${failure.error}\n`);
            }
            process.stderr.write('\nFix the golden set before trusting a run.\n');
            process.exitCode = 1;
            return;
        }

        if (args.verifyOnly) {
            process.stdout.write(`All ${cases.length} reference queries execute cleanly.\n`);
            return;
        }

        const config = resolveProvider(args.provider, args.model);
        const client = createClient(config);

        process.stdout.write(`Running ${config.provider}/${config.model}...\n`);

        const promptOptions = {
            now: evalDate,
            qualifyColumns: args.qualifyColumns,
            antiSubstitution: args.antiSubstitution,
            fewShot: args.fewShot,
        };

        const runs: RunReport[] = [];
        for (let attempt = 1; attempt <= args.repeat; attempt++) {
            if (args.repeat > 1) process.stdout.write(`run ${attempt}/${args.repeat} `);
            runs.push(
                await runAll({
                    cases,
                    fixture,
                    client,
                    config,
                    expected,
                    concurrency: args.concurrency,
                    promptOptions,
                    repairAttempts: args.repairAttempts,
                    onProgress: (done, total, result) => {
                        process.stdout.write(result.outcome === 'pass' ? '.' : 'x');
                        if (done === total) process.stdout.write('\n');
                    },
                }),
            );
        }

        const tag = args.tag || `${config.provider}-${config.model}-${args.dialect}`
            .replace(/[^a-zA-Z0-9._-]/g, '_');

        // A single run is only a point estimate. Repeated runs also report the
        // flaky-case count, which is the noise floor that any claimed
        // improvement has to clear before it means anything.
        let paths: { json: string; md: string };
        if (args.repeat > 1) {
            const summary = summarizeRuns(runs);
            process.stdout.write(`${renderMultiRunConsole(summary)}\n`);
            paths = writeMultiRunReport(summary, tag);
        } else {
            process.stdout.write(`${renderConsoleSummary(runs[0])}\n`);
            paths = writeReport(runs[0], tag);
        }
        process.stdout.write(`\n  wrote ${paths.json}\n  wrote ${paths.md}\n`);
    } finally {
        await fixture.close();
    }
}

main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
});
