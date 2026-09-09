import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalCase } from './types';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, '..', 'cases');

/**
 * Load every case file and fail loudly on duplicate ids. Ids appear in
 * reports and in commit messages when a case is fixed, so silently
 * de-duplicating them would make results impossible to trace.
 */
export function loadCases(): EvalCase[] {
    const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();
    const cases: EvalCase[] = [];
    const seen = new Set<string>();

    for (const file of files) {
        const parsed = JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8')) as EvalCase[];
        if (!Array.isArray(parsed)) {
            throw new Error(`${file}: expected a JSON array of cases`);
        }
        for (const evalCase of parsed) {
            if (seen.has(evalCase.id)) {
                throw new Error(`Duplicate case id "${evalCase.id}" in ${file}`);
            }
            seen.add(evalCase.id);
            cases.push(evalCase);
        }
    }

    return cases;
}
